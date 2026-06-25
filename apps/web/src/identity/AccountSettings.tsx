import { useCallback, useEffect, useState } from "react";
import { startAprsVerify, confirmAprsVerify, getVerifyStatus } from "../api.js";
import { Group, Badge, Icon } from "../ui/index.js";
import { baseCall } from "./useIdentity.js";

type Id = {
  active: string; list: string[];
  add: (c: string) => void; setActive: (c: string) => void; remove: (c: string) => void;
};

/** Settings → Account: your operating callsigns (incl. SSIDs), the active one, and per-base-call
 *  APRS-message verification. One account, many callsigns; one active at a time. */
export function AccountSettings(props: { identity: Id }) {
  const { active, list, add, setActive, remove } = props.identity;
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Record<string, boolean>>({});   // base call -> verified
  const [verifying, setVerifying] = useState<string | null>(null);     // base call mid-challenge
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const bases = Array.from(new Set(list.map(baseCall)));
  const refresh = useCallback(() => {
    for (const b of bases) getVerifyStatus(b).then((r) => setStatus((s) => ({ ...s, [b]: r.verified }))).catch(() => {});
  }, [bases.join(",")]);
  useEffect(() => { refresh(); }, [refresh]);

  async function startVerify(call: string) {
    const b = baseCall(call); setBusy(true); setMsg(null);
    try { await startAprsVerify(b); setVerifying(b); setCode(""); setMsg(`Sent a code to ${b} over APRS — read it on your radio and enter it.`); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!verifying) return;
    setBusy(true); setMsg(null);
    try {
      const r = await confirmAprsVerify(verifying, code.trim());
      if (r.verified) { setStatus((s) => ({ ...s, [verifying]: true })); setVerifying(null); setMsg(`${verifying} verified ✓`); }
      else setMsg("That code didn't match. Check your radio and try again.");
    } catch { setMsg("That code didn't match. Check your radio and try again."); }
    finally { setBusy(false); }
  }

  return (
    <Group title="Account & callsigns" status={active ? active : "no callsign"}>
      {list.length === 0 && <p className="muted">Add a callsign to claim your finds. Use your base call (e.g. <span className="mono">OE8APR</span>) or a station SSID (e.g. <span className="mono">OE8APR-9</span>).</p>}
      <ul className="callsigns">
        {list.map((c) => {
          const verified = status[baseCall(c)];
          return (
            <li key={c} className={c === active ? "active" : ""}>
              <button className="cs-pick" aria-pressed={c === active} onClick={() => setActive(c)} title={c === active ? "Active operating callsign" : "Set active"}>
                <span className={`cs-dot${c === active ? " on" : ""}`} aria-hidden="true" />
                <span className="mono cs-name">{c}</span>
              </button>
              {verified
                ? <Badge kind="tierA" title="callsign-control verified"><Icon name="check" size={12} /> verified</Badge>
                : <button className="link" disabled={busy} onClick={() => startVerify(c)}>verify</button>}
              <button className="iconbtn" aria-label={`Remove ${c}`} onClick={() => remove(c)}><Icon name="close" size={15} /></button>
            </li>
          );
        })}
      </ul>

      {verifying && (
        <div className="verify-code">
          <label>Code sent to <span className="mono">{verifying}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" maxLength={6} />
          </label>
          <div className="row end"><button onClick={() => setVerifying(null)}>Cancel</button>
            <button className="primary" disabled={busy || code.trim().length < 4} onClick={confirm}>{busy ? "Checking…" : "Confirm"}</button></div>
        </div>
      )}

      <div className="row mt-3">
        <input value={draft} placeholder="Add callsign (OE8APR-9)" onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { add(draft); setDraft(""); } }} />
        <button onClick={() => { if (draft.trim()) { add(draft); setDraft(""); } }}>Add</button>
      </div>
      {msg && <p className="muted mt-2">{msg}</p>}
      <p className="muted mt-2 fine">Verification proves you hold the licensed base call; its SSID stations (-7 HT, -9 mobile, -10 IGate…) inherit it. Passkey sign-in lands next.</p>
    </Group>
  );
}
