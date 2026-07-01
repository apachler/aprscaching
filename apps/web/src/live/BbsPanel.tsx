import { useCallback, useEffect, useState } from "react";
import { getBbsInbox, getBulletins, getBbsSent, postBbsMessage, markBbsRead, type BbsMessage } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState } from "../ui/index.js";

type Tab = "inbox" | "sent" | "bulletins" | "compose";

/** BBS — store-and-forward APRS mail + (network-federated) bulletins + connected-mode threads. */
export function BbsPanel(props: { callsign: string; onClose: () => void }) {
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
  const [selected, setSelected] = useState<BbsMessage | null>(null); // reading pane (wide master-detail)

  const load = useCallback(() => {
    if (signedIn) {
      getBbsInbox(props.callsign).then((r) => setInbox(r.messages)).catch(console.error);
      getBbsSent(props.callsign).then((r) => setSent(r.messages)).catch(console.error);
    }
    getBulletins().then((r) => setBulletins(r.bulletins)).catch(console.error);
  }, [props.callsign, signedIn]);
  useEffect(() => { load(); }, [load]);

  const unread = inbox.filter((m) => m.readAt == null).length;

  // open a message into the reading pane; mark inbox mail read (optimistic) and persist
  function openMessage(m: BbsMessage) {
    setSelected(m);
    if (m.type !== "B" && m.readAt == null) {
      setInbox((prev) => prev.map((x) => (x.id === m.id ? { ...x, readAt: Math.floor(Date.now() / 1000) } : x)));
      void markBbsRead(m.id).catch(() => { /* a re-load will reconcile */ });
    }
  }
  // the conversation for a message rendered as a real reply TREE (forum/BBS style): every message in
  // the thread nested under its parent (reply_to), depth-first, each child sorted oldest-first. Depth
  // drives the indentation + connector, so a reply-to-a-reply sits under the message it answered.
  function threadTree(m: BbsMessage): { msg: BbsMessage; depth: number }[] {
    const tid = m.threadId ?? m.id;
    const byId = new Map<number, BbsMessage>();
    for (const x of [...inbox, ...sent, ...bulletins]) if ((x.threadId ?? x.id) === tid) byId.set(x.id, x);
    const kids = new Map<number | null, BbsMessage[]>();
    for (const x of byId.values()) {
      const parent = x.replyTo != null && byId.has(x.replyTo) ? x.replyTo : null; // orphans → roots
      (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(x);
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.postedAt - b.postedAt);
    const out: { msg: BbsMessage; depth: number }[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const x of kids.get(parent) ?? []) { out.push({ msg: x, depth }); walk(x.id, depth + 1); }
    };
    walk(null, 0);
    return out;
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
    <button className={tab === key ? "primary" : ""} onClick={() => { setTab(key); setSelected(null); }}>
      {label}{badge ? <Badge className="ml-1">{badge}</Badge> : null}
    </button>
  );

  // one compact list row (from/date/subject) for the master list; clicking loads the reading pane.
  const listRow = (m: BbsMessage, kind: "inbox" | "bulletins") => (
    <li key={m.id} className={`bbs-row${kind === "inbox" && m.readAt == null ? " bbs-unread" : ""}${selected?.id === m.id ? " on" : ""}`}
        onClick={() => openMessage(m)}>
      <div className="bbs-row-h">
        {kind === "inbox" && m.readAt == null && <span className="bbs-dot" aria-label="unread" />}
        {kind === "bulletins" && <Badge>{m.toCall}</Badge>}
        <strong>{m.fromCall}</strong>
        <span className="muted bbs-row-date">{fmt.dateTime(m.postedAt)}</span>
      </div>
      {m.subject && <div className="bbs-subj">{m.subject}</div>}
    </li>
  );

  // the reading pane: full message headers + body + its SR thread + Reply
  const reader = () => {
    if (!selected) return <div className="bbs-reader-empty muted">Select a message to read.</div>;
    const tree = threadTree(selected);
    return (
      <article className="bbs-read">
        <button className="link bbs-back" onClick={() => setSelected(null)}>← Messages</button>
        <h3>{selected.subject || "(no subject)"}</h3>
        <dl className="bbs-hdr">
          <div><dt>From</dt><dd className="mono">{selected.fromCall}</dd></div>
          <div><dt>To</dt><dd className="mono">{selected.toCall}</dd></div>
          <div><dt>BID</dt><dd className="mono">{selected.bid}</dd></div>
          <div><dt>Date</dt><dd>{fmt.dateTime(selected.postedAt)}</dd></div>
        </dl>
        {tree.length > 1 ? (
          <>
            {tree.length > 1 && <div className="bbs-thread-h muted">Thread · {tree.length} messages</div>}
            <div className="bbs-thread">
              {tree.map(({ msg: t, depth }) => (
                <div key={t.id} className={`bbs-node depth-${Math.min(depth, 6)}${t.id === selected.id ? " on" : ""}`}
                     onClick={() => setSelected(t)} role="button" tabIndex={0}>
                  <div className="bbs-msg">
                    <div className="bbs-msg-h">
                      {depth > 0 && <span className="bbs-reply-mark" aria-hidden="true">↳</span>}
                      <strong className="mono">{t.fromCall}</strong>
                      <span className="muted">→ {t.toCall}</span>
                      <span className="muted bbs-node-date">{fmt.dateTime(t.postedAt)}</span>
                    </div>
                    <div className="comment">{t.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : <div className="comment bbs-read-body">{selected.body}</div>}
        <div className="row end"><button className="primary" onClick={() => reply(selected)}>Reply</button></div>
      </article>
    );
  };

  return (
    <Panel title="✉ BBS" onClose={props.onClose} wide>
      <div className="row gap-2 bbs-tabs">
        {tabBtn("inbox", "Inbox", unread)}
        {tabBtn("sent", "Sent")}
        {tabBtn("bulletins", "Bulletins")}
        {tabBtn("compose", "Compose")}
      </div>

      {tab === "inbox" && (!signedIn ? <EmptyState>Set your callsign to see your mail.</EmptyState> :
        inbox.length === 0 ? <EmptyState>No messages for {props.callsign}.</EmptyState> : (
        <div className="bbs-body" data-sel={selected ? "1" : "0"}>
          <ul className="bbs-list">{inbox.map((m) => listRow(m, "inbox"))}</ul>
          <div className="bbs-reader">{reader()}</div>
        </div>
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
        <div className="bbs-body" data-sel={selected ? "1" : "0"}>
          <ul className="bbs-list">{bulletins.map((m) => listRow(m, "bulletins"))}</ul>
          <div className="bbs-reader">{reader()}</div>
        </div>
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
