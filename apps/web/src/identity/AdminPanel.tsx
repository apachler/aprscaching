import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import {
  listFederationPeers, setPeerTrust, listForwardPartners, saveForwardPartner, deleteForwardPartner,
  listForwardRules, saveForwardRule, deleteForwardRule, getPorts, cotUrl,
  type FedPeer, type ForwardPartner, type ForwardRuleRow, type PortStat,
} from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Group, Badge, EmptyState, Switch, Ico, useToast } from "../ui/index.js";

/**
 * AdminPanel — the instance-operator (sysop) back end. Instance-wide configuration that belongs to the ham
 * who DEPLOYED this instance, kept OUT of per-user Settings: the federation network (peers + trust), FBB
 * forwarding (partners + routing rules), and the ingest data plane (transports + the TAK/CoT feed). Only
 * rendered when `/api/admin/whoami` reports the signed-in account is an operator (ADMIN_CALLSIGNS); every
 * write here is sysop-gated server-side, so this is a convenience surface over already-protected endpoints.
 */
export function AdminPanel(props: { callsign: string; map: maplibregl.Map | null; onClose: () => void }) {
  return (
    <Panel title={<><Ico e="🛡 " />Instance admin</>} onClose={props.onClose}>
      <p className="muted">Operator-only. These settings govern the whole instance, not your account — you see
        this because <span className="mono">{props.callsign}</span> is configured as an operator.</p>

      <Group title="Federation" status="peers & trust" defaultOpen={true}><FederationAdmin /></Group>
      <Group title="Forwarding" status="FBB / BBS" defaultOpen={false}><ForwardingAdmin /></Group>
      <Group title="Ingest & transports" status="data plane" defaultOpen={false}><IngestAdmin map={props.map} /></Group>
    </Panel>
  );
}

// ---------------------------------------------------------------- federation peers + trust
function FederationAdmin() {
  const fmt = useFmt();
  const toast = useToast();
  const [peers, setPeers] = useState<FedPeer[]>([]);
  const refresh = () => listFederationPeers().then((r) => setPeers(r.peers)).catch(console.error);
  useEffect(() => { refresh(); }, []);
  const trust = async (url: string, t: "trusted" | "unvetted" | "blocked") => {
    try { await setPeerTrust(url, t); toast(`Peer ${t}`); await refresh(); } catch (e) { toast((e as Error).message); }
  };
  if (peers.length === 0) return <EmptyState>No federation peers configured.</EmptyState>;
  return (
    <ul className="logs">
      {peers.map((p) => (
        <li key={p.url}>
          <Badge kind={p.health === "ok" ? "found" : p.health === "error" ? "dnf" : "warn"} title={`trust: ${p.trust}`}>{p.health}</Badge>
          <span className="mono">{p.instance ?? p.url}</span>
          <span className="muted"> · {p.trust}{p.signed ? " · signed" : ""}</span>
          <div className="comment">
            {p.last_ok ? `synced ${fmt.ago(p.last_ok)}` : "never synced"} · {p.mirrored_total} mirrored
            {p.rep_confirmed > 0 && ` · ${p.rep_confirmed} corroborations`}
            {p.sync_err > 0 && ` · ${Math.round(p.errorRate * 100)}% errors`}
          </div>
          {p.health === "error" && p.last_error && <div className="comment error">{p.last_error}</div>}
          <div className="row">
            <button disabled={p.trust === "trusted"} onClick={() => trust(p.url, "trusted")}>Trust</button>
            <button disabled={p.trust === "unvetted"} onClick={() => trust(p.url, "unvetted")}>Unvet</button>
            <button className="danger" disabled={p.trust === "blocked"} onClick={() => trust(p.url, "blocked")}>Block</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- FBB forwarding partners + routing rules
const EMPTY_PARTNER: Partial<ForwardPartner> & { call: string } = { call: "", proto: "rf-fbb", connectScript: "" };

function ForwardingAdmin() {
  const toast = useToast();
  const [partners, setPartners] = useState<ForwardPartner[]>([]);
  const [rules, setRules] = useState<ForwardRuleRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Partial<ForwardPartner> & { call: string }>(EMPTY_PARTNER);
  const [rule, setRule] = useState({ partner: "", route: "" });

  const refresh = () => {
    listForwardPartners().then((r) => setPartners(r.partners)).catch(console.error);
    listForwardRules().then((r) => setRules(r.rules)).catch(console.error);
  };
  useEffect(() => { refresh(); }, []);

  const savePartner = async (p: Partial<ForwardPartner> & { call: string }) => {
    try { await saveForwardPartner(p); toast(`Partner ${p.call.toUpperCase()} saved`); refresh(); } catch (e) { toast((e as Error).message); }
  };
  const submitPartner = async () => {
    if (!form.call.trim()) { toast("A partner callsign is required"); return; }
    await savePartner(form); setForm(EMPTY_PARTNER); setAdding(false);
  };
  const removePartner = async (p: ForwardPartner) => {
    if (!confirm(`Remove forwarding partner ${p.call}?`)) return;
    try { await deleteForwardPartner(p.id); toast(`Partner ${p.call} removed`); refresh(); } catch (e) { toast((e as Error).message); }
  };
  const submitRule = async () => {
    if (!rule.partner.trim() || !rule.route.trim()) { toast("Route + partner required"); return; }
    try { await saveForwardRule({ partner: rule.partner, route: rule.route, transport: "rf-fbb" }); setRule({ partner: "", route: "" }); refresh(); }
    catch (e) { toast((e as Error).message); }
  };
  const removeRule = async (id: number) => { try { await deleteForwardRule(id); refresh(); } catch (e) { toast((e as Error).message); } };

  return (
    <>
      <h4 className="set-subh">Partners</h4>
      {partners.length === 0
        ? <EmptyState>No forwarding partners. Add a BBS to exchange mail with over RF.</EmptyState>
        : (
          <ul className="logs">
            {partners.map((p) => (
              <li key={p.id}>
                <Switch label={`Forwarding to ${p.call}`} checked={p.enabled} onChange={(v) => savePartner({ ...p, enabled: v })} />
                <span className="mono">{p.call}</span>
                <span className="muted"> · {p.proto}{p.ha ? ` · ${p.ha}` : ""}</span>
                <button className="link-btn" aria-label={`Remove ${p.call}`} onClick={() => removePartner(p)}>remove</button>
                <div className="comment">every {p.intervalMin} min{p.timebands ? ` @ ${p.timebands} UTC` : ""} · types {p.msgtypes}{p.requestReverse ? " · reverse" : ""}</div>
              </li>
            ))}
          </ul>
        )}
      {adding ? (
        <div className="partner-form">
          <label>Callsign<input className="mono" placeholder="OE8XBM-1" value={form.call} onChange={(e) => setForm((f) => ({ ...f, call: e.target.value }))} /></label>
          <label>Hierarchical address<input className="mono" placeholder="OE8XBM.OE.EU" value={form.ha ?? ""} onChange={(e) => setForm((f) => ({ ...f, ha: e.target.value }))} /></label>
          <label>Transport
            <select value={form.proto ?? "rf-fbb"} onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value as ForwardPartner["proto"] }))}>
              <option value="rf-fbb">RF (FBB)</option><option value="axudp">AXUDP</option><option value="ip-fed">IP federation</option>
            </select>
          </label>
          <label>Connect script<input className="mono" placeholder="C NODE1&#10;C 3 DB0XYZ" value={form.connectScript ?? ""} onChange={(e) => setForm((f) => ({ ...f, connectScript: e.target.value }))} /></label>
          <label>Interval (min)<input type="number" min={0} max={1440} value={form.intervalMin ?? 30} onChange={(e) => setForm((f) => ({ ...f, intervalMin: Number(e.target.value) }))} /></label>
          <label>Time-bands (UTC)<input className="mono" placeholder="0-6,22-23" value={form.timebands ?? ""} onChange={(e) => setForm((f) => ({ ...f, timebands: e.target.value }))} /></label>
          <div className="row"><button className="primary" onClick={submitPartner}>Save partner</button><button onClick={() => { setForm(EMPTY_PARTNER); setAdding(false); }}>Cancel</button></div>
        </div>
      ) : <button onClick={() => setAdding(true)}>Add partner</button>}

      <h4 className="set-subh">Routing rules <span className="muted">· region → partner</span></h4>
      {rules.length === 0 ? <EmptyState>No rules — mail routes to the default federation catch-all.</EmptyState> : (
        <ul className="logs">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="mono">{r.route}</span> <span className="muted">→ {r.partner} · {r.transport}</span>
              <button className="link-btn" onClick={() => removeRule(r.id)}>remove</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input className="mono" placeholder="route (DL, EU, *)" aria-label="Route (region prefix)" value={rule.route} onChange={(e) => setRule((x) => ({ ...x, route: e.target.value }))} />
        <input className="mono" placeholder="partner call" aria-label="Partner callsign" value={rule.partner} onChange={(e) => setRule((x) => ({ ...x, partner: e.target.value }))} />
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
  useEffect(() => { getPorts().then((r) => setPorts(r.ports)).catch(console.error); }, []);
  const feedUrl = (() => { const b = props.map?.getBounds(); return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : ""; })();
  return (
    <>
      <h4 className="set-subh">Transports <span className="muted">· {ports.length} port{ports.length === 1 ? "" : "s"} · 24h RX</span></h4>
      {ports.length === 0 ? <EmptyState>No traffic yet.</EmptyState> : ports.map((p) => (
        <div className="setrow" key={p.port}><div className="setrow-l"><span className="mono">{p.port}</span></div><div className="setrow-c muted">{fmt.num(p.rx, 0)} rx</div></div>
      ))}
      <h4 className="set-subh">TAK / CoT feed</h4>
      <p className="muted">Add this as a data feed in ATAK/WinTAK to see this instance's APRS stations as CoT:</p>
      <div className="row">
        <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => { navigator.clipboard?.writeText(feedUrl); toast("Feed URL copied"); }}>copy</button>
      </div>
    </>
  );
}
