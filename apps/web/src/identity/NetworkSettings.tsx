import { useEffect, useState } from "react";
import {
  listFederationPeers, listForwardPartners, saveForwardPartner, deleteForwardPartner,
  type FedPeer, type ForwardPartner,
} from "../api.js";
import { useFmt } from "../format.js";
import { Badge, EmptyState, Switch, useToast } from "../ui/index.js";

/**
 * NetworkSettings — the platform network config (Settings → "Network", moved out of the workbench).
 * Two subsections: the **federation peers** (who this instance mirrors, trust tier, sync health) and
 * the **FBB forwarding partners** (docs/29 F4) — the classic packet BBSes this instance forwards mail
 * to over RF/AXUDP. Federation peers are read-only observability; partners are sysop-editable config.
 */
export function NetworkSettings() {
  return (
    <>
      <h4 className="set-subh">Federation peers</h4>
      <FederationPeers />
      <h4 className="set-subh">Forwarding partners <span className="muted">· FBB / BBS mail</span></h4>
      <ForwardPartners />
    </>
  );
}

function FederationPeers() {
  const fmt = useFmt();
  const [peers, setPeers] = useState<FedPeer[]>([]);
  useEffect(() => { listFederationPeers().then((r) => setPeers(r.peers)).catch(console.error); }, []);

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
        </li>
      ))}
    </ul>
  );
}

const EMPTY_PARTNER: Partial<ForwardPartner> & { call: string } = { call: "", proto: "rf-fbb", connectScript: "" };

/** Sysop CRUD for FBB forwarding partners: list with per-partner enable toggle + an add form. */
function ForwardPartners() {
  const toast = useToast();
  const [partners, setPartners] = useState<ForwardPartner[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Partial<ForwardPartner> & { call: string }>(EMPTY_PARTNER);

  const refresh = () => listForwardPartners().then((r) => setPartners(r.partners)).catch(console.error);
  useEffect(() => { refresh(); }, []);

  const save = async (p: Partial<ForwardPartner> & { call: string }) => {
    try { await saveForwardPartner(p); toast(`Partner ${p.call.toUpperCase()} saved`); await refresh(); }
    catch (e) { toast((e as Error).message || "Save failed"); }
  };
  const toggle = (p: ForwardPartner, enabled: boolean) => save({ ...p, enabled });
  const remove = async (p: ForwardPartner) => {
    if (!confirm(`Remove forwarding partner ${p.call}?`)) return;
    try { await deleteForwardPartner(p.id); toast(`Partner ${p.call} removed`); await refresh(); }
    catch (e) { toast((e as Error).message || "Remove failed"); }
  };
  const submit = async () => {
    if (!form.call.trim()) { toast("A partner callsign is required"); return; }
    await save(form);
    setForm(EMPTY_PARTNER); setAdding(false);
  };

  return (
    <>
      {partners.length === 0
        ? <EmptyState>No forwarding partners. Add a BBS to exchange mail with over RF.</EmptyState>
        : (
          <ul className="logs">
            {partners.map((p) => (
              <li key={p.id}>
                <Switch label={`Forwarding to ${p.call}`} checked={p.enabled} onChange={(v) => toggle(p, v)} />
                <span className="mono">{p.call}</span>
                <span className="muted"> · {p.proto}{p.ha ? ` · ${p.ha}` : ""}</span>
                <button className="link-btn" aria-label={`Remove ${p.call}`} onClick={() => remove(p)}>remove</button>
                <div className="comment">
                  every {p.intervalMin} min{p.timebands ? ` @ ${p.timebands} UTC` : ""} · types {p.msgtypes}
                  {p.requestReverse ? " · reverse" : ""} · block {p.maxBlock}
                  {p.connectScript && <> · <span className="mono">{p.connectScript.replace(/\n/g, " ; ")}</span></>}
                </div>
              </li>
            ))}
          </ul>
        )}

      {adding ? (
        <div className="partner-form">
          <label>Callsign<input className="mono" placeholder="OE8XBM-1" value={form.call}
            onChange={(e) => setForm((f) => ({ ...f, call: e.target.value }))} /></label>
          <label>Hierarchical address<input className="mono" placeholder="OE8XBM.OE.EU" value={form.ha ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, ha: e.target.value }))} /></label>
          <label>Transport
            <select value={form.proto ?? "rf-fbb"} onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value as ForwardPartner["proto"] }))}>
              <option value="rf-fbb">RF (FBB)</option>
              <option value="axudp">AXUDP</option>
              <option value="ip-fed">IP federation</option>
            </select>
          </label>
          <label>Connect script<input className="mono" placeholder="C NODE1&#10;C 3 DB0XYZ" value={form.connectScript ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, connectScript: e.target.value }))} /></label>
          <label>Interval (min)<input type="number" min={0} max={1440} value={form.intervalMin ?? 30}
            onChange={(e) => setForm((f) => ({ ...f, intervalMin: Number(e.target.value) }))} /></label>
          <label>Time-bands (UTC)<input className="mono" placeholder="0-6,22-23" value={form.timebands ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, timebands: e.target.value }))} /></label>
          <div className="row">
            <button className="primary" onClick={submit}>Save partner</button>
            <button onClick={() => { setForm(EMPTY_PARTNER); setAdding(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}>Add partner</button>
      )}
    </>
  );
}
