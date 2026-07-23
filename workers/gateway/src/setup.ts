// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * setup.ts — the sysop first-install checklist. GET /api/admin/setup reports, for the signed-in
 * operator, what this instance has configured and what still needs attention — a web-driven setup
 * wizard within a hard boundary: security-critical settings are env-only by design (INGEST_SECRET,
 * SESSION_SECRET, ADMIN_CALLSIGNS, FED_PRIVATE_KEY, …), so the wizard reports their presence and
 * health READ-ONLY — it never writes them and NEVER echoes a secret value, only a status. The only
 * values echoed are already-public identity strings (instance domain, app URL, operator imprint).
 * Runtime-writable state (federation peers, forwarding partners, peer trust) stays with the
 * existing sysop surfaces; the web panel links each DB-sourced item to the surface that manages it.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { sessionCallsign, weakSecret } from "./auth.js";

export interface SetupItem {
  /** Stable id: the env key for env-sourced items, `db:<probe>` for runtime state. */
  key: string;
  label: string;
  group: "security" | "identity" | "trust" | "legal" | "delivery" | "data";
  status: "ok" | "warn" | "missing";
  /** env ⇒ read-only here, set in the deployment environment; db ⇒ managed by an admin surface. */
  source: "env" | "db";
  /** One-line status text. Never a secret value. */
  detail: string;
}

const set = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;

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

  // ---- security — the env-only core; the gateway fails closed without it
  push({
    key: "INGEST_SECRET",
    label: "Ingest secret",
    group: "security",
    status: weakSecret(env.INGEST_SECRET) ? "missing" : "ok",
    source: "env",
    detail: weakSecret(env.INGEST_SECRET)
      ? "unset or the 'change-me' default — the gateway refuses to mint sessions"
      : "set — the ingest box authenticates with it",
  });
  push({
    key: "SESSION_SECRET",
    label: "Session secret",
    group: "security",
    status: !set(env.SESSION_SECRET) ? "warn" : weakSecret(env.SESSION_SECRET) ? "missing" : "ok",
    source: "env",
    detail: !set(env.SESSION_SECRET)
      ? "derived from INGEST_SECRET — fine for a single-operator box; shared gateways set a dedicated secret"
      : weakSecret(env.SESSION_SECRET)
        ? "set to the 'change-me' default — sessions are refused"
        : "dedicated session-signing secret",
  });
  {
    const n = (env.ADMIN_CALLSIGNS ?? "").split(",").filter((c) => c.trim()).length;
    push({
      key: "ADMIN_CALLSIGNS",
      label: "Instance operators",
      group: "security",
      status: "ok", // reaching this endpoint requires a configured operator
      source: "env",
      detail: `${n} operator callsign${n === 1 ? "" : "s"} configured`,
    });
  }

  // ---- identity — public strings, safe to echo
  push({
    key: "INSTANCE",
    label: "Instance id",
    group: "identity",
    status: set(env.INSTANCE) ? "ok" : "warn",
    source: "env",
    detail: set(env.INSTANCE) ? String(env.INSTANCE) : "unset — federation records need a canonical instance domain",
  });
  push({
    key: "APP_URL",
    label: "App origin",
    group: "identity",
    status: set(env.APP_URL) ? "ok" : "warn",
    source: "env",
    detail: set(env.APP_URL) ? String(env.APP_URL) : "unset — magic-link redirects and CORS use same-origin defaults",
  });
  push({
    key: "RP_ID",
    label: "Passkey domain",
    group: "identity",
    status: set(env.RP_ID) ? "ok" : "warn",
    source: "env",
    detail: set(env.RP_ID)
      ? String(env.RP_ID)
      : "unset — passkeys bind to the request host; set the registrable domain for a public instance",
  });

  // ---- trust — what Tier A and federation need
  {
    const sites = (env.FIRST_PARTY_SITES ?? "").split(",").filter((c) => c.trim());
    push({
      key: "FIRST_PARTY_SITES",
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
    label: "Federation signing key",
    group: "trust",
    status: set(env.FED_PRIVATE_KEY) ? "ok" : "warn",
    source: "env",
    detail: set(env.FED_PRIVATE_KEY)
      ? "set — feeds are signed"
      : "unset — feeds serve unsigned and peers won't mirror them (generate: node tools/fedkey/genkey.mjs)",
  });

  // ---- legal — the public instance's obligations
  {
    const all = set(env.OPERATOR_NAME) && set(env.OPERATOR_ADDRESS) && set(env.OPERATOR_EMAIL);
    push({
      key: "OPERATOR",
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
    const mail = set(env.EMAIL_FROM) && set(env.EMAIL_API_KEY);
    push({
      key: "EMAIL",
      label: "Email delivery",
      group: "delivery",
      status: mail ? "ok" : "warn",
      source: "env",
      detail: mail
        ? `magic-link + digest mail from ${env.EMAIL_FROM}`
        : "EMAIL_FROM / EMAIL_API_KEY unset — sign-in links cannot be delivered (dev tokens stay off by default)",
    });
  }
  {
    const pushKeys = set(env.VAPID_PUBLIC) && set(env.VAPID_PRIVATE);
    push({
      key: "VAPID",
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
async function dbItems(env: Env, callsign: string | null): Promise<SetupItem[]> {
  const nowS = Math.floor(Date.now() / 1000);
  const items: SetupItem[] = [];

  const rx = await count(env, "SELECT COUNT(*) AS n FROM packets_recent WHERE ts > ?", nowS - 3600);
  items.push({
    key: "db:ingest",
    label: "Ingest feeding",
    group: "data",
    status: rx ? "ok" : "warn",
    source: "db",
    detail: rx
      ? `${rx} packet${rx === 1 ? "" : "s"} heard in the last hour`
      : "no packets in the last hour — check the ingest box (INGEST_URL + INGEST_SECRET) or the browser RF bridge",
  });

  const peers = await count(env, "SELECT COUNT(*) AS n FROM fed_peers WHERE enabled = 1");
  items.push({
    key: "db:peers",
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
    label: "Forwarding partners",
    group: "data",
    status: "ok", // FBB forwarding is optional — a count, not a to-do
    source: "db",
    detail: `${partners ?? 0} enabled partner${partners === 1 ? "" : "s"} (optional — managed under Forwarding)`,
  });

  const caches = await count(env, "SELECT COUNT(*) AS n FROM caches WHERE status != 'archived'");
  items.push({
    key: "db:caches",
    label: "Caches",
    group: "data",
    status: caches ? "ok" : "warn",
    source: "db",
    detail: caches ? `${caches} active cache${caches === 1 ? "" : "s"}` : "none yet — hide the first cache",
  });

  if (callsign) {
    const base = callsign.split("-")[0]!;
    const v = await count(env, "SELECT COUNT(*) AS n FROM accounts WHERE callsign = ? AND verified = 1", base);
    items.push({
      key: "db:verify",
      label: "Your callsign control-verification",
      group: "data",
      status: v ? "ok" : "warn",
      source: "db",
      detail: v
        ? `${base} is control-verified — transmit paths are available to you`
        : `${base} is not control-verified — verify it (Settings → account) to enable transmit`,
    });
  }
  return items;
}

/** GET /api/admin/setup — the operator's configuration checklist (sysop-gated, statuses only). */
export async function handleAdminSetup(req: Request, env: Env): Promise<Response> {
  const guard = await requireSysop(req, env);
  if (guard) return guard;
  const callsign = await sessionCallsign(req, env);
  return json({ items: [...envItems(env), ...(await dbItems(env, callsign))] });
}
