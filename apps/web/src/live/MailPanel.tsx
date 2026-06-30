import { useCallback, useEffect, useState } from "react";
import { getBbsInbox, getBulletins, getBbsSent, postBbsMessage, markBbsRead, type BbsMessage } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState } from "../ui/index.js";

type Tab = "inbox" | "sent" | "bulletins" | "compose";

/** BBS — store-and-forward APRS mail + (network-federated) bulletins. */
export function MailPanel(props: { callsign: string; onClose: () => void }) {
  const fmt = useFmt();
  const signedIn = props.callsign.length >= 3;
  const [tab, setTab] = useState<Tab>("inbox");
  const [inbox, setInbox] = useState<BbsMessage[]>([]);
  const [sent, setSent] = useState<BbsMessage[]>([]);
  const [bulletins, setBulletins] = useState<BbsMessage[]>([]);
  const [to, setTo] = useState(""); const [subject, setSubject] = useState(""); const [body, setBody] = useState("");
  const [type, setType] = useState<"P" | "B" | "T">("P");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    if (signedIn) {
      getBbsInbox(props.callsign).then((r) => setInbox(r.messages)).catch(console.error);
      getBbsSent(props.callsign).then((r) => setSent(r.messages)).catch(console.error);
    }
    getBulletins().then((r) => setBulletins(r.bulletins)).catch(console.error);
  }, [props.callsign, signedIn]);
  useEffect(() => { load(); }, [load]);

  const unread = inbox.filter((m) => m.readAt == null).length;

  // open an inbox message: mark it read (optimistic) and persist
  async function openMessage(m: BbsMessage) {
    if (m.readAt != null) return;
    setInbox((prev) => prev.map((x) => (x.id === m.id ? { ...x, readAt: Math.floor(Date.now() / 1000) } : x)));
    try { await markBbsRead(m.id); } catch { /* a re-load will reconcile */ }
  }

  function reply(m: BbsMessage) {
    setTo(m.fromCall);
    setSubject(m.subject ? (/^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`) : "");
    setType(m.type === "B" ? "B" : "P"); setReplyTo(m.id);  // thread the reply (SR)
    setTab("compose"); setMsg(null);
  }

  async function send() {
    if (!to.trim() || !body.trim() || !signedIn) { setMsg("Set your callsign, a recipient and a message."); return; }
    try {
      const r = await postBbsMessage({ fromCall: props.callsign, toCall: to.trim().toUpperCase(), subject: subject.trim() || undefined, body: body.trim(), type, replyTo: replyTo ?? undefined });
      setMsg(r.type === "B" ? "Bulletin posted to the network." : r.type === "T" ? "Traffic stored." : "Held — it'll be delivered when the station is next heard.");
      setBody(""); setTo(""); setSubject(""); setReplyTo(null); setType("P"); load();
      setTab(r.type === "B" ? "bulletins" : "sent");
    } catch (e) { setMsg((e as Error).message); }
  }

  const DELIVERY: Record<string, string> = { held: "⏳ held", sent: "📡 sent", acked: "✓ delivered", expired: "✕ expired" };
  const tabBtn = (key: Tab, label: string, badge?: number) => (
    <button className={tab === key ? "primary" : ""} onClick={() => setTab(key)}>
      {label}{badge ? <Badge className="ml-1">{badge}</Badge> : null}
    </button>
  );

  return (
    <Panel title="✉ BBS" onClose={props.onClose}>
      <div className="row gap-2">
        {tabBtn("inbox", "Inbox", unread)}
        {tabBtn("sent", "Sent")}
        {tabBtn("bulletins", "Bulletins")}
        {tabBtn("compose", "Compose")}
      </div>

      {tab === "inbox" && (!signedIn ? <EmptyState>Set your callsign to see your mail.</EmptyState> :
        inbox.length === 0 ? <EmptyState>No messages for {props.callsign}.</EmptyState> : (
        <ul className="logs">{inbox.map((m) => (
          <li key={m.id} className={m.readAt == null ? "bbs-unread" : ""} onClick={() => openMessage(m)}>
            {m.readAt == null && <span className="bbs-dot" aria-label="unread" />}
            <strong>{m.fromCall}</strong> <span className="muted">· {fmt.dateTime(m.postedAt)}</span>
            {m.subject && <span className="bbs-subj"> · {m.subject}</span>}
            <div className="comment">{m.body}</div>
            <button className="link" onClick={(e) => { e.stopPropagation(); reply(m); }}>Reply</button>
          </li>
        ))}</ul>
      ))}

      {tab === "sent" && (!signedIn ? <EmptyState>Set your callsign to see your sent mail.</EmptyState> :
        sent.length === 0 ? <EmptyState>You haven't sent any mail yet.</EmptyState> : (
        <ul className="logs">{sent.map((m) => (
          <li key={m.id}>
            <span className="muted">to</span> <strong>{m.toCall}</strong> <span className="muted">· {fmt.dateTime(m.postedAt)}</span>
            <Badge className="ml-2">{DELIVERY[m.delivery ?? "held"] ?? "⏳ held"}</Badge>
            {m.subject && <span className="bbs-subj"> · {m.subject}</span>}
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "bulletins" && (bulletins.length === 0 ? <EmptyState>No bulletins.</EmptyState> : (
        <ul className="logs">{bulletins.map((m) => (
          <li key={m.id}>
            <Badge>{m.toCall}</Badge> <strong>{m.fromCall}</strong>
            <span className="muted"> · {fmt.dateTime(m.postedAt)}{m.origin && m.origin !== "local" ? ` · via ${m.origin}` : ""}</span>
            {m.subject && <span className="bbs-subj"> · {m.subject}</span>}
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "compose" && (<>
        {replyTo != null && <p className="muted">↳ reply to message #{replyTo} (threaded)</p>}
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as "P" | "B" | "T")}>
            <option value="P">Personal</option>
            <option value="B">Bulletin</option>
            <option value="T">Traffic (NTS)</option>
          </select>
        </label>
        <label>To <span className="muted">(callsign, or ALL/BLN… for a bulletin)</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="OE8APR" /></label>
        <label>Subject <span className="muted">(optional)</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={60} placeholder="net" /></label>
        <label>Message <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={300} /></label>
        <div className="row end"><button className="primary" onClick={send}>Send</button></div>
        <p className="muted">From <strong>{props.callsign || "(set callsign)"}</strong>. Personal mail is held and store-and-forwarded over APRS when the recipient is next heard; bulletins propagate to federated instances.</p>
      </>)}
      {msg && <p className="muted">{msg}</p>}
    </Panel>
  );
}
