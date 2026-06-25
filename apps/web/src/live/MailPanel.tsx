import { useCallback, useEffect, useState } from "react";
import { getBbsInbox, getBulletins, postBbsMessage, type BbsMessage } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState } from "../ui/index.js";

/** BBS — store-and-forward APRS mail + bulletins. */
export function MailPanel(props: { callsign: string; onClose: () => void }) {
  const fmt = useFmt();
  const [tab, setTab] = useState<"inbox" | "bulletins" | "compose">("inbox");
  const [inbox, setInbox] = useState<BbsMessage[]>([]);
  const [bulletins, setBulletins] = useState<BbsMessage[]>([]);
  const [to, setTo] = useState(""); const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    if (props.callsign.length >= 3) getBbsInbox(props.callsign).then((r) => setInbox(r.messages)).catch(console.error);
    getBulletins().then((r) => setBulletins(r.bulletins)).catch(console.error);
  }, [props.callsign]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    if (!to.trim() || !body.trim() || props.callsign.length < 3) { setMsg("Set your callsign, a recipient and a message."); return; }
    try {
      const r = await postBbsMessage({ fromCall: props.callsign, toCall: to.trim().toUpperCase(), body: body.trim() });
      setMsg(r.type === "B" ? "Bulletin posted." : "Held — it'll be delivered when the station is next heard.");
      setBody(""); setTo(""); load();
    } catch (e) { setMsg((e as Error).message); }
  }

  const status = (m: BbsMessage) => ({ held: "⏳ held", sent: "📡 sent", acked: "✓ delivered", expired: "✕ expired" } as Record<string, string>)[m.delivery ?? ""] ?? "";
  return (
    <Panel title="✉ BBS" onClose={props.onClose}>
      <div className="row gap-2">
        <button className={tab === "inbox" ? "primary" : ""} onClick={() => setTab("inbox")}>Inbox</button>
        <button className={tab === "bulletins" ? "primary" : ""} onClick={() => setTab("bulletins")}>Bulletins</button>
        <button className={tab === "compose" ? "primary" : ""} onClick={() => setTab("compose")}>Compose</button>
      </div>

      {tab === "inbox" && (props.callsign.length < 3 ? <EmptyState>Set your callsign to see your mail.</EmptyState> :
        inbox.length === 0 ? <EmptyState>No messages for {props.callsign}.</EmptyState> : (
        <ul className="logs">{inbox.map((m) => (
          <li key={m.id}>
            <strong>{m.fromCall}</strong> <span className="muted">· {fmt.dateTime(m.postedAt)}</span>
            <Badge className="ml-2">{status(m)}</Badge>
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "bulletins" && (bulletins.length === 0 ? <EmptyState>No bulletins.</EmptyState> : (
        <ul className="logs">{bulletins.map((m) => (
          <li key={m.id}>
            <Badge>{m.toCall}</Badge> <strong>{m.fromCall}</strong>
            <span className="muted"> · {fmt.dateTime(m.postedAt)}</span>
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "compose" && (<>
        <label>To <span className="muted">(callsign, or ALL/BLN… for a bulletin)</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="OE8APR" /></label>
        <label>Message <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={300} /></label>
        <div className="row end"><button className="primary" onClick={send}>Send</button></div>
        <p className="muted">From <strong>{props.callsign || "(set callsign)"}</strong>. Personal mail is held and store-and-forwarded over APRS when the recipient is next heard.</p>
      </>)}
      {msg && <p className="muted">{msg}</p>}
    </Panel>
  );
}
