// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
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

// ---------------------------------------------------------------- first-install checklist (Setup)
const SETUP_GROUPS: Array<{ id: SetupItem["group"]; title: string }> = [
  { id: "security", title: "Security" },
  { id: "identity", title: "Identity & auth" },
  { id: "trust", title: "Trust & federation" },
  { id: "legal", title: "Legal & source" },
  { id: "delivery", title: "Delivery" },
  { id: "data", title: "Runtime state" },
];

/**
 * The web-driven first-install wizard, within its hard boundary: security-critical settings are
 * env-only (deploy/.env, systemd EnvironmentFile, wrangler secrets), so the checklist shows their
 * presence READ-ONLY — the server never echoes a secret value, and nothing here writes env config.
 * Runtime-writable state (peers, partners, trust) lives in the sibling admin groups; each DB row
 * says where it is managed.
 */
function SetupAdmin(props: { onDocs: (slug: string) => void }) {
  const [items, setItems] = useState<SetupItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setError(null);
    getAdminSetup()
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  };
  useEffect(() => {
    refresh();
  }, []);

  if (error) return <ErrorState onRetry={refresh}>{error}</ErrorState>;
  if (!items) return <EmptyState>Checking this instance's configuration…</EmptyState>;

  const attention = items.filter((i) => i.status !== "ok").length;
  return (
    <>
      <p className="muted">
        {attention === 0
          ? "Everything checks out — this instance is fully configured."
          : `${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention.`}{" "}
        Settings marked <span className="mono">env</span> are read-only here by design: they hold secrets or identity
        the server must not accept at runtime — set them in the deployment environment (
        <span className="mono">deploy/.env</span>, systemd unit, or <span className="mono">wrangler secret put</span>)
        and restart. The walkthrough:{" "}
        <button className="link-btn" onClick={() => props.onDocs("operate/first-hour")}>
          Your first hour as sysop
        </button>
        .
      </p>
      {SETUP_GROUPS.map((g) => {
        const rows = items.filter((i) => i.group === g.id);
        if (rows.length === 0) return null;
        return (
          <div key={g.id}>
            <h4 className="set-subh">{g.title}</h4>
            {rows.map((i) => (
              <div className="setrow" key={i.key}>
                <div className="setrow-l">
                  <Badge kind={i.status === "ok" ? "found" : i.status === "warn" ? "warn" : "dnf"}>
                    {i.status === "ok" ? "ok" : i.status === "warn" ? "check" : "missing"}
                  </Badge>{" "}
                  {i.label} {i.source === "env" && <span className="muted mono">env</span>}
                </div>
                <div className="setrow-c muted">{i.detail}</div>
              </div>
            ))}
          </div>
        );
      })}
      <button onClick={refresh}>Re-check</button>
    </>
  );
}

// ---------------------------------------------------------------- federation peers + trust
function FederationAdmin() {
  const fmt = useFmt();
  const toast = useToast();
  const [peers, setPeers] = useState<FedPeer[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const refresh = () => {
    setLoadErr(false);
    return listFederationPeers()
      .then((r) => setPeers(r.peers))
      .catch(() => setLoadErr(true));
  };
  useEffect(() => {
    void refresh();
  }, []);
  const trust = async (url: string, t: "trusted" | "unvetted" | "blocked") => {
    try {
      await setPeerTrust(url, t);
      toast(`Peer ${t}`);
      await refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <Fed44netWizard onAdmitted={refresh} />
      {loadErr ? (
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
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState<Awaited<ReturnType<typeof getFedDescriptor>> | null>(null);
  const [descErr, setDescErr] = useState(false);
  const [call, setCall] = useState("");
  useEffect(() => {
    if (!open || desc) return;
    setDescErr(false);
    getFedDescriptor()
      .then((d) => {
        setDesc(d);
        if (!call && d.aprsCall) setCall(d.aprsCall.split("-")[0] ?? "");
      })
      .catch(() => setDescErr(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once on first open; `call` is only seeded
  }, [open, desc]);

  const record =
    desc?.signed && desc.publicKey && call.trim()
      ? `_aprscaching.${call.trim().toLowerCase()}.ampr.org  TXT  "v=acs1; inst=${desc.instance}; key=${desc.publicKey}"`
      : null;
  return (
    <div className="disclosure">
      <button className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Be reachable on 44net
      </button>
      {open && (
        <div className="disclosure-body">
          {descErr ? (
            <div className="comment error">Couldn't load this instance's descriptor — close and reopen to retry.</div>
          ) : desc && !desc.signed ? (
            <div className="comment">Configure a federation signing key to publish a verifiable 44net binding.</div>
          ) : (
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
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- FBB forwarding partners + routing rules
const EMPTY_PARTNER: Partial<ForwardPartner> & { call: string } = { call: "", proto: "rf-fbb", connectScript: "" };

function ForwardingAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [partners, setPartners] = useState<ForwardPartner[]>([]);
  const [rules, setRules] = useState<ForwardRuleRow[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Partial<ForwardPartner> & { call: string }>(EMPTY_PARTNER);
  const [rule, setRule] = useState({ partner: "", route: "" });

  const refresh = () => {
    setLoadErr(false);
    listForwardPartners()
      .then((r) => setPartners(r.partners))
      .catch(() => setLoadErr(true));
    listForwardRules()
      .then((r) => setRules(r.rules))
      .catch(() => setLoadErr(true));
  };
  useEffect(() => {
    refresh();
  }, []);

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
      {loadErr ? (
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
  const [ports, setPorts] = useState<PortStat[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const load = () => {
    setLoadErr(false);
    getPorts()
      .then((r) => setPorts(r.ports))
      .catch(() => setLoadErr(true));
  };
  useEffect(load, []);
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
      {loadErr ? (
        <ErrorState onRetry={load}>Couldn't load port statistics.</ErrorState>
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
