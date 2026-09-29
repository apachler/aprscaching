// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import type * as maplibregl from "maplibre-gl";
import {
  listFederationPeers,
  setPeerTrust,
  add44netPeer,
  getFedDescriptor,
  type Fed44netResult,
  listForwardPartners,
  saveForwardPartner,
  deleteForwardPartner,
  listForwardRules,
  saveForwardRule,
  deleteForwardRule,
  getPorts,
  cotUrl,
  getAdminSetup,
  listManualVerifications,
  addManualVerification,
  revokeManualVerification,
  type ManualVerification,
  getAdminAdoptions,
  offerForAdoption,
  withdrawAdoptionOffer,
  assignCacheOwner,
  decideAdoptionRequest,
  type AdminAdoptions,
  type SetupItem,
  type FedPeer,
  type ForwardPartner,
  type ForwardRuleRow,
  type PortStat,
} from "../api.js";
import { useFmt } from "../format.js";
import {
  Panel,
  Group,
  Badge,
  EmptyState,
  ErrorState,
  Switch,
  Ico,
  copyText,
  useConfirm,
  useToast,
  useLoad,
  Disclosure,
} from "../ui/index.js";

/**
 * AdminPanel — the instance-operator (sysop) back end. Instance-wide configuration that belongs to the ham
 * who DEPLOYED this instance, kept OUT of per-user Settings: the federation network (peers + trust), FBB
 * forwarding (partners + routing rules), and the ingest data plane (transports + the TAK/CoT feed). Only
 * rendered when `/api/admin/whoami` reports the signed-in account is an operator (ADMIN_CALLSIGNS); every
 * write here is sysop-gated server-side, so this is a convenience surface over already-protected endpoints.
 */
export function AdminPanel(props: {
  callsign: string;
  map: maplibregl.Map | null;
  onDocs: (slug: string) => void;
  onClose: () => void;
}) {
  // group filter (ui-ux.md §2: settings pages with >3 groups are searchable)
  const [q, setQ] = useState("");
  const show = (...words: string[]) => !q.trim() || words.some((w) => w.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Panel
      title={
        <>
          <Ico e="🛡 " />
          Instance admin
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Operator-only. These settings govern the whole instance, not your account — you see this because{" "}
        <span className="mono">{props.callsign}</span> is configured as an operator.
      </p>
      <label className="srch">
        <span className="srch-ic">⌕</span>
        <input
          value={q}
          placeholder="Search admin sections…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search admin sections"
        />
      </label>

      {show("setup", "checklist", "install", "secrets", "wizard") && (
        <Group title="Setup" status="first-install checklist" defaultOpen={true}>
          <SetupAdmin onDocs={props.onDocs} />
        </Group>
      )}
      {show("verification", "verify", "callsign", "manual", "licence", "sysop") && (
        <Group title="Callsign verification" status="manual" defaultOpen={false}>
          <VerificationAdmin />
        </Group>
      )}
      {show("adoption", "adopt", "caches", "owner", "withdrawn", "assign", "orphan") && (
        <Group title="Cache adoption" status="owners" defaultOpen={false}>
          <AdoptionAdmin />
        </Group>
      )}
      {show("federation", "peers", "trust", "44net", "sync") && (
        <Group title="Federation" status="peers & trust" defaultOpen={false}>
          <FederationAdmin />
        </Group>
      )}
      {show("forwarding", "fbb", "bbs", "partners", "rules", "mail") && (
        <Group title="Forwarding" status="FBB / BBS" defaultOpen={false}>
          <ForwardingAdmin />
        </Group>
      )}
      {show("ingest", "transports", "ports", "tak", "cot", "feed") && (
        <Group title="Ingest & transports" status="data plane" defaultOpen={false}>
          <IngestAdmin map={props.map} />
        </Group>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- manual callsign verification

const CALL_RE = /^[A-Z0-9]{3,9}(-[A-Z0-9]{1,2})?$/;

/**
 * Verify a callsign by hand for an operator no attested receiving site can hear. Each one carries a note
 * saying how control of the licence was checked, is listed here, and can be revoked. Calls verified on
 * the air or by the operator CLI are not listed and cannot be revoked from here.
 */
function VerificationAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const list = useLoad(() => listManualVerifications().then((r) => r.verifications), []);
  const rows = list.data;
  const refresh = list.reload;
  const [call, setCall] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const cs = call.trim().toUpperCase();
  const callOk = CALL_RE.test(cs);
  const noteOk = note.trim().length >= 3;
  const submit = async () => {
    if (!callOk || !noteOk) {
      setFormErr(!callOk ? "Enter a valid callsign." : "Say how you checked control of the licence.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const r = await addManualVerification(cs, note.trim());
      toast(`${r.callsign} verified`);
      setCall("");
      setNote("");
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const revoke = async (v: ManualVerification) => {
    if (
      !(await confirmDialog({
        title: `Revoke the verification of ${v.callsign}?`,
        message: "The call becomes unverified: transmit and leaderboard credit close until it is verified again.",
        confirmLabel: "Revoke",
        danger: true,
      }))
    )
      return;
    try {
      await revokeManualVerification(v.callsign);
      toast(`${v.callsign} verification revoked`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <p className="muted fine">
        For operators out of range of every receiving site this instance attests. Verify only a call whose licence you
        have checked yourself; the note records how.
      </p>
      <div className="partner-form">
        <label>
          Callsign
          <input
            className="mono"
            placeholder="VK2ABC"
            value={call}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr && !callOk}
            onChange={(e) => setCall(e.target.value)}
          />
        </label>
        <label>
          How control was checked
          <input
            placeholder="licence seen on a video call"
            value={note}
            maxLength={200}
            aria-invalid={!!formErr && !noteOk}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        <div className="row end">
          <button className="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
            {saving ? "Verifying…" : "Verify callsign"}
          </button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}
      <h4 className="set-subh">Verified by hand</h4>
      {list.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the manual verifications.</ErrorState>
      ) : rows === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState>
          No calls verified by hand. Use the form above for an operator no receiving site can hear.
        </EmptyState>
      ) : (
        <ul className="logs">
          {rows.map((v) => (
            <li key={v.callsign}>
              <span className="mono">{v.callsign}</span>
              <span className="muted">
                {" "}
                · by <span className="mono">{v.verifiedBy ?? "?"}</span> · {fmt.date(v.verifiedAt)}
                {v.held ? "" : " · no account yet"}
              </span>
              <button
                className="link-btn danger"
                aria-label={`Revoke the verification of ${v.callsign}`}
                onClick={() => void revoke(v)}
              >
                Revoke
              </button>
              {v.note && <div className="comment">{v.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- cache adoption

type AdoptCache = AdminAdoptions["withdrawn"][number];

/**
 * Hand caches to new owners. A withdrawn owner's cache (the owner erased their account) or an abandoned one
 * is offered to the community with a public note; signed-in holders of a verified call ask for it here, and
 * the sysop approves one — or assigns the cache straight to a verified call. An active owner is told of an
 * offer and can keep the cache until the notice period ends.
 */
function AdoptionAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const adoptions = useLoad(getAdminAdoptions, []);
  const data = adoptions.data;
  const refresh = adoptions.reload;
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const offerByCode = async () => {
    if (!code.trim() || note.trim().length < 3) {
      setFormErr(!code.trim() ? "Enter the cache code." : "Say why the cache is up for adoption.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      await offerForAdoption({ code: code.trim() }, note.trim());
      toast(`${code.trim().toUpperCase()} offered for adoption`);
      setCode("");
      setNote("");
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  /** Run one row action with its own busy flag, a toast, and a refresh. */
  const act = async (key: string, done: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast(done);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const withdraw = async (c: AdoptCache) => {
    if (
      !(await confirmDialog({
        title: `Withdraw the adoption offer on ${c.code}?`,
        message: "The cache leaves the adoption list and every pending request on it is cancelled.",
        confirmLabel: "Withdraw offer",
        danger: true,
      }))
    )
      return;
    await act(`w${c.id}`, `Offer on ${c.code} withdrawn`, () => withdrawAdoptionOffer(c.id));
  };
  const decide = async (c: AdoptCache, r: { id: number; callsign: string }, d: "approve" | "decline") => {
    if (
      !(await confirmDialog({
        title: d === "approve" ? `Hand ${c.code} to ${r.callsign}?` : `Decline ${r.callsign}'s request?`,
        message:
          d === "approve"
            ? "The cache changes owner; its finds and logbook stay. Other requests on it are declined."
            : "The requester is told their request was not taken up.",
        confirmLabel: d === "approve" ? "Approve" : "Decline",
        danger: d === "decline",
      }))
    )
      return;
    await act(`r${r.id}`, d === "approve" ? `${c.code} now belongs to ${r.callsign}` : "Request declined", () =>
      decideAdoptionRequest(r.id, d),
    );
  };

  const now = Math.floor(Date.now() / 1000);
  return (
    <>
      <p className="muted fine">
        Offer a cache whose owner has withdrawn or stopped looking after it. The note is public. An active owner is told
        and can keep the cache for {data ? Math.round(data.noticeSec / 86_400) : 14} days; the new owner must hold a
        control-verified call.
      </p>
      <div className="partner-form">
        <label>
          Cache code
          <input
            className="mono"
            placeholder="AC-0042"
            value={code}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr && !code.trim()}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label>
          Why it is up for adoption
          <input
            placeholder="owner inactive since 2024"
            value={note}
            maxLength={300}
            aria-invalid={!!formErr && note.trim().length < 3}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void offerByCode();
            }}
          />
        </label>
        <div className="row end">
          <button className="primary" disabled={saving} aria-busy={saving} onClick={() => void offerByCode()}>
            {saving ? "Offering…" : "Offer for adoption"}
          </button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}

      {adoptions.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the adoption list.</ErrorState>
      ) : data === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : (
        <>
          <h4 className="set-subh">Up for adoption</h4>
          {data.offered.length === 0 ? (
            <EmptyState>No cache is up for adoption. Offer one above, or from the withdrawn list below.</EmptyState>
          ) : (
            <ul className="logs">
              {data.offered.map((c) => (
                <li key={c.id}>
                  <span className="mono">{c.code}</span> {c.title}
                  <span className="muted">
                    {" "}
                    · owner <span className="mono">{c.ownerCall}</span> · offered by{" "}
                    <span className="mono">{c.offeredBy}</span> {fmt.ago(c.offeredAt)}
                  </span>{" "}
                  {c.noticeEndsAt > now ? (
                    <Badge kind="warn">notice until {fmt.date(c.noticeEndsAt)}</Badge>
                  ) : (
                    <Badge kind="found">ready</Badge>
                  )}
                  <div className="comment">{c.note}</div>
                  {c.requests.length === 0 ? (
                    <div className="comment muted">No requests yet.</div>
                  ) : (
                    <ul className="logs adopt-reqs">
                      {c.requests.map((r) => (
                        <li key={r.id}>
                          <span className="mono">{r.callsign}</span>
                          <span className="muted">
                            {" "}
                            · {r.inPlace ? "confirms it is in place" : "has not checked the site"} ·{" "}
                            {fmt.ago(r.requestedAt)}
                          </span>
                          {r.note && <div className="comment">{r.note}</div>}
                          <div className="row">
                            <button
                              disabled={busy !== null || c.noticeEndsAt > now}
                              aria-busy={busy === `r${r.id}`}
                              title={c.noticeEndsAt > now ? "The owner's notice period is still running" : undefined}
                              onClick={() => void decide(c, r, "approve")}
                            >
                              Approve
                            </button>
                            <button
                              className="danger"
                              disabled={busy !== null}
                              onClick={() => void decide(c, r, "decline")}
                            >
                              Decline
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="row">
                    <AssignOwner cache={c} disabled={busy !== null || c.noticeEndsAt > now} onDone={refresh} />
                    <button
                      className="link-btn danger"
                      disabled={busy !== null}
                      aria-label={`Withdraw the adoption offer on ${c.code}`}
                      onClick={() => void withdraw(c)}
                    >
                      Withdraw offer
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h4 className="set-subh">Withdrawn owners</h4>
          {data.withdrawn.length === 0 ? (
            <EmptyState>No cache is left by an erased account.</EmptyState>
          ) : (
            <ul className="logs">
              {data.withdrawn.map((c) => (
                <li key={c.id}>
                  <span className="mono">{c.code}</span> {c.title} <Badge>{c.status}</Badge>
                  <div className="row">
                    <OfferWithdrawn cache={c} onDone={refresh} />
                    <AssignOwner cache={c} disabled={busy !== null} onDone={refresh} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Disclosure label={`Recent activity (${data.log.length})`}>
            {data.log.length === 0 ? (
              <EmptyState>Nothing has happened yet.</EmptyState>
            ) : (
              <ul className="logs">
                {data.log.map((l) => (
                  <li key={l.id}>
                    <span className="mono">{l.code ?? `#${l.cacheId}`}</span>{" "}
                    <Badge>{l.action.replace(/_/g, " ")}</Badge>
                    <span className="muted">
                      by <span className="mono">{l.actor}</span>
                      {l.to && (
                        <>
                          {" "}
                          · <span className="mono">{l.from ?? "?"}</span> to <span className="mono">{l.to}</span>
                        </>
                      )}{" "}
                      · {fmt.date(l.at)}
                    </span>
                    {l.note && <div className="comment">{l.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </>
      )}
    </>
  );
}

/** Offer one withdrawn-owner cache: a disclosure holding the public note and the confirm button. */
function OfferWithdrawn(props: { cache: AdoptCache; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("The owner has withdrawn from the network.");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (note.trim().length < 3) {
      setErr("Say why the cache is up for adoption.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await offerForAdoption({ cacheId: props.cache.id }, note.trim());
      toast(`${props.cache.code} offered for adoption`);
      setOpen(false);
      props.onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!open)
    return (
      <button aria-expanded={false} onClick={() => setOpen(true)}>
        Offer…
      </button>
    );
  return (
    <div className="partner-form">
      <label>
        Public note
        <input value={note} maxLength={300} aria-invalid={!!err} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row end">
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button className="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
          {saving ? "Offering…" : `Offer ${props.cache.code}`}
        </button>
      </div>
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** Hand a cache straight to a call: the call must be held by an account and control-verified. */
function AssignOwner(props: { cache: AdoptCache; disabled: boolean; onDone: () => void }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState("");
  const [note, setNote] = useState("");
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cs = call.trim().toUpperCase();
  const submit = async () => {
    if (!CALL_RE.test(cs) || note.trim().length < 3) {
      setErr(!CALL_RE.test(cs) ? "Enter a valid callsign." : "Say why the cache changes owner.");
      return;
    }
    if (
      !(await confirmDialog({
        title: `Make ${cs} the owner of ${props.cache.code}?`,
        message: `The cache changes owner; its finds and logbook stay.${activate ? " It becomes active again." : " It keeps its status until the new owner edits it."}`,
        confirmLabel: "Assign owner",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    setErr(null);
    try {
      await assignCacheOwner(props.cache.id, cs, note.trim(), activate);
      toast(`${props.cache.code} now belongs to ${cs}`);
      setOpen(false);
      props.onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!open)
    return (
      <button
        aria-expanded={false}
        disabled={props.disabled}
        title={props.disabled ? "The owner's notice period is still running" : undefined}
        onClick={() => setOpen(true)}
      >
        Assign…
      </button>
    );
  return (
    <div className="partner-form">
      <label>
        New owner
        <input
          className="mono"
          placeholder="VK2ABC"
          value={call}
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={!!err && !CALL_RE.test(cs)}
          onChange={(e) => setCall(e.target.value)}
        />
      </label>
      <label>
        Why it changes owner
        <input
          placeholder="asked by email, licence checked"
          value={note}
          maxLength={300}
          aria-invalid={!!err && note.trim().length < 3}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="row">
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> The container is
        confirmed in place: make the cache active
      </label>
      <div className="row end">
        <button onClick={() => setOpen(false)}>Cancel</button>
        <button className="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
          {saving ? "Assigning…" : "Assign owner"}
        </button>
      </div>
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- first-install checklist (Setup)
const SETUP_GROUP_ORDER: SetupItem["group"][] = ["security", "identity", "delivery", "trust", "legal", "data"];
const byGroup = (a: SetupItem, b: SetupItem) => SETUP_GROUP_ORDER.indexOf(a.group) - SETUP_GROUP_ORDER.indexOf(b.group);

/** One checklist row: status chip (text, never colour alone), name, env marker, one-line detail. */
function SetupRow(props: { item: SetupItem }) {
  const i = props.item;
  return (
    <li className="setup-item">
      <Badge kind={i.status === "ok" ? "found" : i.status === "warn" ? "warn" : "dnf"}>
        {i.status === "ok" ? "ok" : i.status === "warn" ? "check" : "missing"}
      </Badge>
      <span className="setup-name">
        {i.label} {i.source === "env" && <span className="muted mono">env</span>}
      </span>
      <span className="setup-detail">{i.detail}</span>
    </li>
  );
}

/**
 * The web-driven first-install wizard, within its hard boundary: security-critical settings are
 * env-only (deploy/.env, systemd EnvironmentFile, wrangler secrets), so the checklist shows their
 * presence READ-ONLY — the server never echoes a secret value, and nothing here writes env config.
 * Items come in three levels so a working box reads as working: Blocking (sign-in or ingest broken),
 * Recommended for a public instance, and Optional (collapsed). Runtime-writable state (peers,
 * partners, trust) lives in the sibling admin groups; each DB row says where it is managed.
 */
function SetupAdmin(props: { onDocs: (slug: string) => void }) {
  const { data: items, error, loading, reload: refresh } = useLoad(() => getAdminSetup().then((r) => r.items), []);

  if (error) return <ErrorState onRetry={refresh}>{error}</ErrorState>;
  if (!items) return <EmptyState>Checking this instance's configuration…</EmptyState>;

  const level = (l: SetupItem["level"]) => items.filter((i) => i.level === l).sort(byGroup);
  const blocking = level("blocking");
  const recommended = level("recommended");
  const optional = level("optional");
  const open = (rows: SetupItem[]) => rows.filter((i) => i.status !== "ok").length;
  const broken = open(blocking);
  return (
    <>
      <p className={broken ? "error" : "muted"} role="status">
        {broken === 0
          ? "Sign-in and ingest work."
          : `${broken} blocking item${broken === 1 ? "" : "s"}: sign-in or ingest is not working yet.`}
        {broken === 0 && open(recommended) > 0 && ` ${open(recommended)} recommended for a public instance.`}
      </p>
      <h4 className="set-subh">Blocking</h4>
      <ul className="setup-list">
        {blocking.map((i) => (
          <SetupRow key={i.key} item={i} />
        ))}
      </ul>
      <h4 className="set-subh">Recommended for a public instance</h4>
      <ul className="setup-list">
        {recommended.map((i) => (
          <SetupRow key={i.key} item={i} />
        ))}
      </ul>
      <Disclosure label={`Optional (${optional.length}${open(optional) ? `, ${open(optional)} not set up` : ""})`}>
        <ul className="setup-list">
          {optional.map((i) => (
            <SetupRow key={i.key} item={i} />
          ))}
        </ul>
      </Disclosure>
      <p className="muted fine">
        Items marked <span className="mono">env</span> are read-only here: set them in the deployment environment (
        <span className="mono">deploy/.env</span>, the systemd unit, or{" "}
        <span className="mono">wrangler secret put</span>) and restart.{" "}
        <button className="link-btn" onClick={() => props.onDocs("operate/first-hour")}>
          Your first hour as sysop
        </button>
      </p>
      <button onClick={refresh} disabled={loading}>
        {loading ? "Checking…" : "Re-check"}
      </button>
    </>
  );
}

// ---------------------------------------------------------------- federation peers + trust
function FederationAdmin() {
  const fmt = useFmt();
  const toast = useToast();
  const list = useLoad(() => listFederationPeers().then((r) => r.peers), []);
  const peers: FedPeer[] = list.data ?? [];
  const refresh = list.reload;
  const trust = async (url: string, t: "trusted" | "unvetted" | "blocked") => {
    try {
      await setPeerTrust(url, t);
      toast(`Peer ${t}`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <Fed44netWizard onAdmitted={refresh} />
      {list.error ? (
        <ErrorState onRetry={refresh}>Couldn't load the peer list.</ErrorState>
      ) : (
        peers.length === 0 && <EmptyState>No federation peers configured.</EmptyState>
      )}
      <ul className="logs">
        {peers.map((p) => (
          <li key={p.url}>
            <Badge
              kind={p.health === "ok" ? "found" : p.health === "error" ? "dnf" : "warn"}
              title={`trust: ${p.trust}`}
            >
              {p.health}
            </Badge>
            <span className="mono">{p.instance ?? p.url}</span>
            <span className="muted">
              {" "}
              · {p.trust}
              {p.added_via ? ` (${p.added_via})` : ""}
              {p.signed ? " · signed" : ""}
            </span>
            <div className="comment">
              {p.last_ok ? `synced ${fmt.ago(p.last_ok)}` : "never synced"} · {p.mirrored_total} mirrored
              {p.rep_confirmed > 0 && ` · ${p.rep_confirmed} confirmed`}
              {p.rep_failed > 0 && ` · ${p.rep_failed} contradicted`}
              {p.sync_err > 0 && ` · ${Math.round(p.errorRate * 100)}% errors`}
            </div>
            {p.health === "error" && p.last_error && <div className="comment error">{p.last_error}</div>}
            <div className="row">
              <button disabled={p.trust === "trusted"} onClick={() => trust(p.url, "trusted")}>
                Trust
              </button>
              <button disabled={p.trust === "unvetted"} onClick={() => trust(p.url, "unvetted")}>
                Unvet
              </button>
              <button className="danger" disabled={p.trust === "blocked"} onClick={() => trust(p.url, "blocked")}>
                Block
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * 44net verified onboarding. ARDC's portal reviews a licence before delegating `<call>.ampr.org`,
 * so adding a peer by callsign resolves its `_aprscaching` TXT binding: DNSSEC-validated bindings
 * admit in one click, anything else shows the resolved key for an explicit operator confirm (a
 * trust-on-first-use pin). The disclosure underneath emits this instance's OWN TXT record to paste
 * into the ARDC portal so other operators can add us the same way.
 */
function Fed44netWizard(props: { onAdmitted: () => void }) {
  const toast = useToast();
  const [callsign, setCallsign] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Fed44netResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (confirm: boolean) => {
    const cs = (pending?.resolved?.callsign ?? callsign).trim();
    if (!cs) return;
    setBusy(true);
    setError(null);
    try {
      const r = await add44netPeer(cs, confirm);
      if (r.requiresConfirm) setPending(r);
      else if (r.ok) {
        setPending(null);
        setCallsign("");
        toast(`Peer ${r.peer?.instance ?? cs} admitted (${r.admitted === "dnssec" ? "DNSSEC-verified" : "pinned"})`);
        props.onAdmitted();
      }
    } catch (e) {
      setPending(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fed44net">
      <div className="row">
        <input
          placeholder="Add a peer by callsign (44net)"
          value={callsign}
          onChange={(e) => {
            setCallsign(e.target.value.toUpperCase());
            setPending(null);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !busy && !pending && void submit(false)}
          aria-label="Peer callsign on 44net"
        />
        <button className="primary" disabled={busy || !callsign.trim() || !!pending} onClick={() => void submit(false)}>
          {busy && !pending ? "Resolving…" : "Look up"}
        </button>
      </div>
      <div className="comment">
        Resolves the peer's ARDC-verified <span className="mono">&lt;call&gt;.ampr.org</span> binding.
      </div>
      {error && <div className="comment error">{error}</div>}
      {pending?.resolved && (
        <div className="confirmbox">
          <div>
            <Badge kind="warn">no DNSSEC</Badge> <span className="mono">{pending.resolved.host}</span> ·{" "}
            <span className="mono">{pending.resolved.instance}</span>
          </div>
          <div className="comment mono">key {pending.resolved.publicKey.slice(0, 16)}…</div>
          <div className="comment">
            The resolver could not DNSSEC-validate this binding
            {pending.descriptorChecked ? " (the live descriptor matches it)" : " and the peer was not reachable"} —
            confirming pins this key for the peer.
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void submit(true)}>
              Confirm &amp; pin
            </button>
            <button disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <MyTxtRecord />
    </div>
  );
}

/** The instance's own DNS binding — what an operator pastes into the ARDC portal to be addable. */
function MyTxtRecord() {
  return (
    <Disclosure label="Be reachable on 44net">
      <TxtRecordBody />
    </Disclosure>
  );
}

/** The disclosure's body: mounts on open, so a failed descriptor load retries by reopening. */
function TxtRecordBody() {
  const toast = useToast();
  const [call, setCall] = useState("");
  const { data: desc, error } = useLoad(
    () =>
      getFedDescriptor().then((d) => {
        if (d.aprsCall) setCall((c) => c || (d.aprsCall!.split("-")[0] ?? ""));
        return d;
      }),
    [],
  );
  const record =
    desc?.signed && desc.publicKey && call.trim()
      ? `_aprscaching.${call.trim().toLowerCase()}.ampr.org  TXT  "v=acs1; inst=${desc.instance}; key=${desc.publicKey}"`
      : null;
  if (error)
    return <div className="comment error">Couldn't load this instance's descriptor — close and reopen to retry.</div>;
  if (desc && !desc.signed)
    return <div className="comment">Configure a federation signing key to publish a verifiable 44net binding.</div>;
  return (
    <>
      <div className="row">
        <input
          placeholder="Your base callsign"
          value={call}
          onChange={(e) => setCall(e.target.value.toUpperCase())}
          aria-label="Your base callsign"
        />
        <button
          disabled={!record}
          onClick={() => {
            if (record)
              void copyText(record).then((ok) =>
                toast(ok ? "TXT record copied" : "Copy failed — select the record text and copy manually"),
              );
          }}
        >
          Copy
        </button>
      </div>
      {record && <div className="comment mono">{record}</div>}
      <div className="comment">
        Paste this TXT into your <span className="mono">&lt;call&gt;.ampr.org</span> DNS at the ARDC portal
        (portal.ampr.org) — other instances can then add you by callsign, verified.
      </div>
    </>
  );
}

// ---------------------------------------------------------------- FBB forwarding partners + routing rules
const EMPTY_PARTNER: Partial<ForwardPartner> & { call: string } = { call: "", proto: "rf-fbb", connectScript: "" };

function ForwardingAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const lists = useLoad(
    () =>
      Promise.all([listForwardPartners(), listForwardRules()]).then(([p, r]) => ({
        partners: p.partners,
        rules: r.rules,
      })),
    [],
  );
  const partners: ForwardPartner[] = lists.data?.partners ?? [];
  const rules: ForwardRuleRow[] = lists.data?.rules ?? [];
  const refresh = lists.reload;
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Partial<ForwardPartner> & { call: string }>(EMPTY_PARTNER);
  const [rule, setRule] = useState({ partner: "", route: "" });

  const savePartner = async (p: Partial<ForwardPartner> & { call: string }) => {
    try {
      await saveForwardPartner(p);
      toast(`Partner ${p.call.toUpperCase()} saved`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const submitPartner = async () => {
    if (!form.call.trim()) {
      toast("A partner callsign is required");
      return;
    }
    await savePartner(form);
    setForm(EMPTY_PARTNER);
    setAdding(false);
  };
  const removePartner = async (p: ForwardPartner) => {
    if (
      !(await confirmDialog({
        title: `Remove forwarding partner ${p.call}?`,
        message: "Its schedule and routing rules pointing at it stop forwarding.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await deleteForwardPartner(p.id);
      toast(`Partner ${p.call} removed`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const submitRule = async () => {
    if (!rule.partner.trim() || !rule.route.trim()) {
      toast("Route + partner required");
      return;
    }
    try {
      await saveForwardRule({ partner: rule.partner, route: rule.route, transport: "rf-fbb" });
      setRule({ partner: "", route: "" });
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const removeRule = async (r: ForwardRuleRow) => {
    if (
      !(await confirmDialog({
        title: `Remove rule ${r.route} → ${r.partner}?`,
        message: "Mail for that route falls back to the default federation catch-all.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await deleteForwardRule(r.id);
      toast("Rule removed");
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <h4 className="set-subh">Partners</h4>
      {lists.error ? (
        <ErrorState onRetry={refresh}>Couldn't load partners and rules.</ErrorState>
      ) : partners.length === 0 ? (
        <EmptyState>No forwarding partners. Add a BBS to exchange mail with over RF.</EmptyState>
      ) : (
        <ul className="logs">
          {partners.map((p) => (
            <li key={p.id}>
              <Switch
                label={`Forwarding to ${p.call}`}
                checked={p.enabled}
                onChange={(v) => savePartner({ ...p, enabled: v })}
              />
              <span className="mono">{p.call}</span>
              <span className="muted">
                {" "}
                · {p.proto}
                {p.ha ? ` · ${p.ha}` : ""}
              </span>
              <button className="link-btn danger" aria-label={`Remove ${p.call}`} onClick={() => void removePartner(p)}>
                Remove
              </button>
              <div className="comment">
                every {p.intervalMin} min{p.timebands ? ` @ ${p.timebands} UTC` : ""} · types {p.msgtypes}
                {p.requestReverse ? " · reverse" : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="partner-form">
          <label>
            Callsign
            <input
              className="mono"
              placeholder="OE8XBM-1"
              value={form.call}
              onChange={(e) => setForm((f) => ({ ...f, call: e.target.value }))}
            />
          </label>
          <label>
            Hierarchical address
            <input
              className="mono"
              placeholder="OE8XBM.OE.EU"
              value={form.ha ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, ha: e.target.value }))}
            />
          </label>
          <label>
            Transport
            <select
              value={form.proto ?? "rf-fbb"}
              onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value as ForwardPartner["proto"] }))}
            >
              <option value="rf-fbb">RF (FBB)</option>
              <option value="axudp">AXUDP</option>
              <option value="ip-fed">IP federation</option>
            </select>
          </label>
          <label>
            Connect script
            <input
              className="mono"
              placeholder="C NODE1&#10;C 3 DB0XYZ"
              value={form.connectScript ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, connectScript: e.target.value }))}
            />
          </label>
          <label>
            Interval (min)
            <input
              type="number"
              min={0}
              max={1440}
              value={form.intervalMin ?? 30}
              onChange={(e) => setForm((f) => ({ ...f, intervalMin: Number(e.target.value) }))}
            />
          </label>
          <label>
            Time-bands (UTC)
            <input
              className="mono"
              placeholder="0-6,22-23"
              value={form.timebands ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, timebands: e.target.value }))}
            />
          </label>
          <div className="row">
            <button className="primary" onClick={submitPartner}>
              Save partner
            </button>
            <button
              onClick={() => {
                setForm(EMPTY_PARTNER);
                setAdding(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}>Add partner</button>
      )}

      <h4 className="set-subh">
        Routing rules <span className="muted">· region → partner</span>
      </h4>
      {rules.length === 0 ? (
        <EmptyState>No rules — mail routes to the default federation catch-all.</EmptyState>
      ) : (
        <ul className="logs">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="mono">{r.route}</span>{" "}
              <span className="muted">
                → {r.partner} · {r.transport}
              </span>
              <button
                className="link-btn danger"
                aria-label={`Remove rule ${r.route} to ${r.partner}`}
                onClick={() => void removeRule(r)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          className="mono"
          placeholder="route (DL, EU, *)"
          aria-label="Route (region prefix)"
          value={rule.route}
          onChange={(e) => setRule((x) => ({ ...x, route: e.target.value }))}
        />
        <input
          className="mono"
          placeholder="partner call"
          aria-label="Partner callsign"
          value={rule.partner}
          onChange={(e) => setRule((x) => ({ ...x, partner: e.target.value }))}
        />
        <button onClick={submitRule}>Add rule</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- ingest transports + TAK/CoT feed
function IngestAdmin(props: { map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const list = useLoad(() => getPorts().then((r) => r.ports), []);
  const ports: PortStat[] = list.data ?? [];
  const feedUrl = (() => {
    const b = props.map?.getBounds();
    return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : "";
  })();
  return (
    <>
      <h4 className="set-subh">
        Transports{" "}
        <span className="muted">
          · {ports.length} port{ports.length === 1 ? "" : "s"} · 24h RX
        </span>
      </h4>
      {list.error ? (
        <ErrorState onRetry={list.reload}>Couldn't load port statistics.</ErrorState>
      ) : ports.length === 0 ? (
        <EmptyState>No traffic yet.</EmptyState>
      ) : (
        ports.map((p) => (
          <div className="setrow" key={p.port}>
            <div className="setrow-l">
              <span className="mono">{p.port}</span>
            </div>
            <div className="setrow-c muted">{fmt.num(p.rx, 0)} rx</div>
          </div>
        ))
      )}
      <h4 className="set-subh">TAK / CoT feed</h4>
      <p className="muted">Add this as a data feed in ATAK/WinTAK to see this instance's APRS stations as CoT:</p>
      <div className="row">
        <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={() => {
            void copyText(feedUrl).then((ok) =>
              toast(ok ? "Feed URL copied" : "Copy failed — select the URL and copy manually"),
            );
          }}
        >
          Copy
        </button>
      </div>
    </>
  );
}
