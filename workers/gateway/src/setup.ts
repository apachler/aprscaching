// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * setup.ts — the sysop first-install checklist. GET /api/admin/setup reports, for the signed-in
 * operator, what this instance has configured and what still needs attention — a web-driven setup
 * wizard within a hard boundary: security-critical settings are env-only by design (INGEST_SECRET,
 * SESSION_SECRET, OPERATOR_SECRET, ADMIN_CALLSIGNS, FED_PRIVATE_KEY, …), so the wizard reports their presence and
 * health READ-ONLY — it never writes them and NEVER echoes a secret value, only a status. The only
 * values echoed are already-public identity strings (instance domain, app URL, operator imprint).
 * Runtime-writable state (federation peers, forwarding partners, peer trust) stays with the
 * existing sysop surfaces; the web panel links each DB-sourced item to the surface that manages it.
 */
import { nowS } from "./util/time.js";
import { applyDerivedDefaults, configProblems, type Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json } from "./app.js";
import { adminCalls, requireSysop } from "./admin.js";
import { serviceCall, FALLBACK_SERVICE_CALL } from "./servicecall.js";
import { sessionIdentity, sessionsEnabled, signInPaths, weakSecret } from "./auth.js";
import { federationConfigError } from "./federation.js";
import { isCallsignVerified } from "./callsign.js";
import { budgetStatus } from "./budget.js";
import { amprCallOf } from "./fed44net.js";
import { configured44net } from "./fed44netcheck.js";

type WriteBudgetStatus = Awaited<ReturnType<typeof budgetStatus>>;

export interface SetupItem {
  /** Stable id: the env key for env-sourced items, `db:<probe>` for runtime state. */
  key: string;
  label: string;
  group: "security" | "identity" | "trust" | "legal" | "delivery" | "data";
  /** How much a non-ok status matters: blocking = sign-in or ingest is broken; recommended = expected of a
   *  public instance; optional = a feature this instance may do without. */
  level: "blocking" | "recommended" | "optional";
  status: "ok" | "warn" | "missing";
  /** env ⇒ read-only here, set in the deployment environment; db ⇒ managed by an admin surface. */
  source: "env" | "db";
  /** One-line status text. Never a secret value. */
  detail: string;
}

const set = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;

/** APP_URL's hostname, the default of INSTANCE and RP_ID (env.ts applyDerivedDefaults). */
function appHost(env: Env): string | null {
  try {
    return set(env.APP_URL) ? new URL(env.APP_URL!).hostname || null : null;
  } catch {
    return null;
  }
}

/** Count helper tolerant of a probe failing (a missing optional table must not break the checklist). */
async function count(env: Env, sql: string, ...binds: unknown[]): Promise<number | null> {
  try {
    const row = await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return null;
  }
}

function envItems(env: Env): SetupItem[] {
  const items: SetupItem[] = [];
  const push = (i: SetupItem) => items.push(i);

  // ---- malformed settings — the Node/Bun servers refuse to start on one; the Worker reports it here.
  // Each detail names the key and what it expects, never the value.
  const problems = configProblems(env);
  push({
    key: "config",
    label: "Settings are well-formed",
    group: "security",
    level: "blocking",
    status: problems.length ? "missing" : "ok",
    source: "env",
    detail: problems.length ? problems.map((p) => p.message).join("; ") : "every setting has a value of its type",
  });

  // ---- security — the env-only core; the gateway fails closed without it
  push({
    key: "INGEST_SECRET",
    level: "blocking",
    label: "Ingest secret",
    group: "security",
    status: weakSecret(env.INGEST_SECRET) ? "missing" : "ok",
    source: "env",
    detail: weakSecret(env.INGEST_SECRET)
      ? "unset or the 'change-me' default — the ingest box cannot post packets"
      : "set — the ingest box authenticates with it (ingest plane only)",
  });
  push({
    key: "SESSION_SECRET",
    level: "blocking",
    label: "Session secret",
    group: "security",
    // reaching this checklist takes a session, so a usable secret is in place whenever it renders
    status: sessionsEnabled(env) ? "ok" : "missing",
    source: "env",
    detail: sessionsEnabled(env)
      ? "dedicated session-signing secret"
      : "unset, weak or shared with a machine secret — nobody can sign in",
  });
  push({
    key: "OPERATOR_SECRET",
    level: "recommended",
    label: "Operator secret",
    group: "security",
    status: weakSecret(env.OPERATOR_SECRET) ? "warn" : "ok",
    source: "env",
    detail: weakSecret(env.OPERATOR_SECRET)
      ? "unset — operator scripts (tools/admin/verify-call.mjs, signin-link.mjs) are closed; the web operator surface still works"
      : "set — operator scripts authenticate with it",
  });
  {
    const n = (env.ADMIN_CALLSIGNS ?? "").split(",").filter((c) => c.trim()).length;
    push({
      key: "ADMIN_CALLSIGNS",
      level: "blocking",
      label: "Instance operators",
      group: "security",
      status: "ok", // reaching this endpoint requires a configured operator
      source: "env",
      detail: `${n} operator callsign${n === 1 ? "" : "s"} configured`,
    });
  }

  {
    // the one on-air call: players send it radio commands, and answers and Mailbox messages come from it
    const call = serviceCall(env);
    const bases = new Set([...adminCalls(env)].map((c) => baseCall(c)));
    const status: SetupItem["status"] = call === FALLBACK_SERVICE_CALL || !bases.has(baseCall(call)) ? "warn" : "ok";
    push({
      key: "SERVICE_CALL",
      level: "recommended",
      label: "Service call",
      group: "identity",
      status,
      source: "env",
      detail:
        call === FALLBACK_SERVICE_CALL
          ? `${call} — not a callsign: MeshCom nodes drop messages to it and APRS-IS answers cannot go out as plain messages; name an operator in ADMIN_CALLSIGNS`
          : status === "warn"
            ? `${call} — not a call of an ADMIN_CALLSIGNS base call: answers go out under a licence that is not the operator's`
            : `${call}${set(env.SERVICE_CALL) ? "" : " (the first operator's call with SSID 15)"} — players send radio commands to it; changing it, or the order of ADMIN_CALLSIGNS, sends them to a new address`,
    });
  }

  // ---- identity — public strings, safe to echo. INSTANCE and RP_ID follow APP_URL unless set.
  const host = appHost(env);
  const signIn = signInPaths(env);
  const fromApp = (v: string | undefined) => (v === host ? `${v} (APP_URL's host)` : String(v));
  push({
    key: "APP_URL",
    level: "recommended",
    label: "App origin",
    group: "identity",
    status: set(env.APP_URL) ? "ok" : "warn",
    source: "env",
    detail: !set(env.APP_URL)
      ? "unset — passkeys are closed, and sign-in links, redirects and CORS fall back to the request host"
      : signIn.passkeys
        ? String(env.APP_URL)
        : `${env.APP_URL} — plain http: passkeys need https, so members sign in with email or the operator's sign-in link`,
  });
  push({
    key: "INSTANCE",
    level: "recommended",
    label: "Instance id",
    group: "identity",
    status: set(env.INSTANCE) ? "ok" : "warn",
    source: "env",
    detail: set(env.INSTANCE)
      ? fromApp(env.INSTANCE)
      : "unset — set APP_URL (INSTANCE follows its host); federation records need a canonical instance domain",
  });
  push({
    key: "RP_ID",
    level: "optional",
    label: "Passkey domain",
    group: "identity",
    status: set(env.RP_ID) ? "ok" : "warn",
    source: "env",
    detail: set(env.RP_ID) ? fromApp(env.RP_ID) : "unset — set APP_URL (the passkey domain follows its host)",
  });

  // ---- trust — what Tier A and federation need
  {
    const sites = (env.FIRST_PARTY_SITES ?? "").split(/[\s,]+/).filter(Boolean);
    push({
      key: "FIRST_PARTY_SITES",
      level: "optional",
      label: "First-party RF sites",
      group: "trust",
      status: sites.length ? "ok" : "warn",
      source: "env",
      detail: sites.length
        ? `${sites.length} attested site call${sites.length === 1 ? "" : "s"} (${sites.join(", ")}) — Tier A can originate here`
        : "none attested — no find on this instance reaches Tier A (transport never equals trust)",
    });
  }
  push({
    key: "FED_PRIVATE_KEY",
    level: "recommended",
    label: "Federation signing key",
    group: "trust",
    status: set(env.FED_PRIVATE_KEY) ? "ok" : "warn",
    source: "env",
    detail: set(env.FED_PRIVATE_KEY)
      ? "set — feeds are signed"
      : "unset — feeds serve unsigned and peers won't mirror them (generate: node tools/fedkey/genkey.mjs)",
  });
  {
    // shown only with a 44net endpoint; the DNS side runs on demand (GET /api/admin/setup/44net)
    const host = configured44net(env);
    const call = host && amprCallOf(host);
    if (host)
      push({
        key: "44net",
        level: "optional",
        label: "44Net",
        group: "trust",
        status: call ? "ok" : "warn",
        source: "env",
        detail: call
          ? `44net endpoint ${host} (${call}) — run the 44Net check to see what peers find in DNS`
          : `44net endpoint ${host} is not a name under <call>.ampr.org, where peers look up a callsign's binding`,
      });
  }
  if (env.FED_REGISTRY || env.FED_REGISTRY_DNS) {
    const err = federationConfigError(env);
    push({
      key: "FED_REGISTRY_KEY",
      level: "blocking",
      label: "Registry authority key",
      group: "trust",
      status: err ? "missing" : "ok",
      source: "env",
      detail: err ?? "pinned — the registry verifies under it; DNS only locates the document",
    });
  }

  // ---- legal — the public instance's obligations
  {
    const all = set(env.OPERATOR_NAME) && set(env.OPERATOR_ADDRESS) && set(env.OPERATOR_EMAIL);
    push({
      key: "OPERATOR",
      level: "recommended",
      label: "Operator imprint",
      group: "legal",
      status: all ? "ok" : "missing",
      source: "env",
      detail: all
        ? `${env.OPERATOR_NAME} <${env.OPERATOR_EMAIL}>`
        : "OPERATOR_NAME / OPERATOR_ADDRESS / OPERATOR_EMAIL incomplete — /imprint and /privacy show a not-configured warning",
    });
  }
  push({
    key: "SOURCE_REPO",
    level: "optional",
    label: "Source link (AGPL §13)",
    group: "legal",
    status: set(env.SOURCE_REPO) ? "ok" : "warn",
    source: "env",
    detail: set(env.SOURCE_REPO)
      ? String(env.SOURCE_REPO)
      : "unset — serving the upstream repo URL; a modified instance MUST point at its own published fork",
  });

  // ---- delivery — how sign-in links and notifications leave the box
  {
    // Email is how members sign in when passkeys are unavailable and how they recover an account. It is
    // blocking only when nothing else lets anyone in: no passkey origin and no operator sign-in link.
    const mail = signIn.email;
    const noWayIn = !signIn.passkeys && !signIn.email && !signIn.operatorLink;
    push({
      key: "EMAIL",
      level: noWayIn ? "blocking" : signIn.passkeys ? "recommended" : "optional",
      label: "Email delivery",
      group: "delivery",
      status: mail ? "ok" : noWayIn ? "missing" : "warn",
      source: "env",
      detail: mail
        ? `sign-in links + digest mail from ${env.EMAIL_FROM}`
        : noWayIn
          ? "nobody can sign in: no https APP_URL (passkeys), no EMAIL_FROM / EMAIL_API_KEY, no OPERATOR_SECRET (operator sign-in link) — set one"
          : signIn.passkeys
            ? "EMAIL_FROM / EMAIL_API_KEY unset — passkeys work; members without one, or who lose theirs, cannot recover by email"
            : "EMAIL_FROM / EMAIL_API_KEY unset — members sign in with the operator's link (node tools/admin/signin-link.mjs <CALL>)",
    });
  }
  {
    const pushKeys = set(env.VAPID_PUBLIC) && set(env.VAPID_PRIVATE);
    push({
      key: "VAPID",
      level: "optional",
      label: "Web push",
      group: "delivery",
      status: pushKeys ? "ok" : "warn",
      source: "env",
      detail: pushKeys
        ? "VAPID keys set — web push is live"
        : "VAPID keys unset — push notifications fall back to the email digest",
    });
  }
  return items;
}

/** Runtime-state probes — each names the existing surface that manages it. */
async function dbItems(env: Env, callsign: string | null, budget: WriteBudgetStatus): Promise<SetupItem[]> {
  const now = nowS();
  const items: SetupItem[] = [];

  const rx = await count(env, "SELECT COUNT(*) AS n FROM packets_recent WHERE ts > ?", now - 3600);
  // from 80 % of the write budget the raw packet log is paused, so an empty log says nothing about the ingest
  const paused = budget.level === "warn" || budget.level === "over";
  items.push({
    key: "db:ingest",
    level: "blocking",
    label: "Ingest feeding",
    group: "data",
    status: rx ? "ok" : "warn",
    source: "db",
    detail: rx
      ? `${rx} packet${rx === 1 ? "" : "s"} heard in the last hour`
      : paused
        ? "the D1 write budget has paused the raw packet log, so ingest activity cannot be checked here"
        : "no packets in the last hour — check the ingest box (INGEST_URL + INGEST_SECRET) or the browser RF bridge",
  });

  items.push({
    key: "D1_DAILY_WRITE_BUDGET",
    level: "optional",
    label: "D1 write budget",
    group: "data",
    status: paused ? "warn" : "ok",
    source: "env",
    detail:
      budget.used === null
        ? "off — every write is stored as configured"
        : `${budget.used.toLocaleString("en")} of ${budget.budget.toLocaleString("en")} rows written today (UTC)` +
          (budget.level === "over"
            ? " — over budget: only protected data is stored"
            : budget.level === "warn"
              ? " — past 80 %: the raw packet log is paused and unprotected stations store fewer fixes"
              : ""),
  });

  const peers = await count(env, "SELECT COUNT(*) AS n FROM fed_peers WHERE enabled = 1");
  items.push({
    key: "db:peers",
    level: "optional",
    label: "Federation peers",
    group: "data",
    status: peers ? "ok" : "warn",
    source: "db",
    detail: peers
      ? `${peers} enabled peer${peers === 1 ? "" : "s"}`
      : "no peers — a standalone instance works; add peers under Federation to corroborate and mirror",
  });

  const partners = await count(env, "SELECT COUNT(*) AS n FROM bbs_partners WHERE enabled = 1");
  items.push({
    key: "db:partners",
    level: "optional",
    label: "Forwarding partners",
    group: "data",
    status: "ok", // FBB forwarding is optional — a count, not a to-do
    source: "db",
    detail: `${partners ?? 0} enabled partner${partners === 1 ? "" : "s"} (optional — managed under Forwarding)`,
  });

  const caches = await count(env, "SELECT COUNT(*) AS n FROM caches WHERE status != 'archived'");
  items.push({
    key: "db:caches",
    level: "optional",
    label: "Caches",
    group: "data",
    status: caches ? "ok" : "warn",
    source: "db",
    detail: caches ? `${caches} active cache${caches === 1 ? "" : "s"}` : "none yet — hide the first cache",
  });

  if (callsign) {
    const base = baseCall(callsign);
    const v = await isCallsignVerified(env, base);
    items.push({
      key: "db:verify",
      level: "recommended",
      label: "Your callsign control-verification",
      group: "data",
      status: v ? "ok" : "warn",
      source: "db",
      detail: v
        ? `${base} is control-verified — transmit paths are available to you`
        : `${base} is not control-verified — verify it (You → Verify callsign) to enable transmit`,
    });
  }
  return items;
}

/**
 * GET /api/admin/setup — the operator's configuration checklist (a sysop, or the operator secret; statuses only), plus the
 * D1 write budget's `{ used, budget, level, alerts }` for the admin banner.
 */
export async function handleAdminSetup(req: Request, env: Env): Promise<Response> {
  // The checklist reports statuses, never a secret value, so the operator's scripts may read it too
  // (`deploy/aprscaching doctor` sends x-operator-secret).
  const guard = await requireSysop(req, env, { allowOperatorSecret: true });
  if (guard) return guard;
  const callsign = (await sessionIdentity(req, env))?.callsign ?? null;
  applyDerivedDefaults(env); // handle() has filled them already; a direct caller sees the same values
  // the write budget's counter: today's count, level and alerts, which the admin banner shows
  const budget = await budgetStatus(env);
  return json({ items: [...envItems(env), ...(await dbItems(env, callsign, budget))], budget });
}
