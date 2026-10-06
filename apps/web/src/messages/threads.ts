// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * threads.ts — the operator's own messages as conversations, and the choice of how a new one is delivered. Pure:
 * the messenger view (Conversations.tsx) renders what these return.
 *
 * A conversation is the pair of the operator (any SSID of their base call) and one other station (any SSID of its
 * base call). It gathers the APRS and MeshCom messages the instance logged between them, the messages the operator
 * left in the Mailbox for that station, and those left for the operator that wait until they are heard. A Mailbox
 * message the service call delivered (`de <call>: <text>`) belongs to the conversation with the station that left it.
 */
import type { MailboxMessage, MessageItem } from "../api.js";
import type { LinkKind } from "../rf/radioLink.js";

/** The longest APRS message text. */
const APRS_TEXT_MAX = 67;

/** Why a Mailbox message already sent offers no Withdraw. */
export const MAILBOX_SENT_NOTE = "Already sent on the air, so it can no longer be withdrawn.";

/** Where a message stands, in one word the thread shows beside it. */
export type ItemState =
  "queued" | "sent" | "acked" | "failed" | "waiting" | "sent-no-ack" | "delivered" | "undelivered" | "expired";

export interface ThreadItem {
  key: string;
  ts: number;
  dir: "in" | "out";
  /** The callsign that sent it: the operator's own call (any SSID) on an outgoing message. */
  from: string;
  /** The other station's exact callsign, SSID included: the sender of an incoming message, the addressee of one sent. */
  with: string;
  text: string;
  transport?: string | null;
  /** Delivered by the Mailbox: left in the app or by a MAIL command, sent when the station was heard. */
  viaMailbox?: boolean;
  state?: ItemState;
  /** A Mailbox message the operator left and can still take back: one not yet sent on the air. */
  withdrawId?: number;
}

export interface Thread {
  /** The other station's base call: the conversation's key ({@link threadKey}). */
  peer: string;
  /** Where a reply goes: the exact callsign of the conversation's latest message. */
  replyTo: string;
  /** The other side erased their account or gave up their call: the messages stay, there is no one to reply to. */
  withdrawn?: boolean;
  /** Oldest first. */
  items: ThreadItem[];
  last: ThreadItem;
}

const MAILBOX_STATE: Record<MailboxMessage["status"], ItemState> = {
  held: "waiting",
  sent: "sent-no-ack",
  delivered: "delivered",
  undelivered: "undelivered",
  expired: "expired",
};

/** The marker an erased person or a call's former holder shows under: a stand-in, never a station. */
export const isPersonMarker = (call: string): boolean => /^(WITHDRAWN|FORMER)(#|$)/i.test(call.trim());

const baseOf = (call: string) => call.toUpperCase().split("-")[0] ?? "";
const DELIVERED = /^de ([A-Z0-9]{1,6}(?:-[A-Z0-9]{1,2})?): ([\s\S]*)$/i;

/** Gather the operator's messages and Mailbox into conversations, the most recent first. */
export function threadsOf(
  messages: readonly MessageItem[],
  mailbox: { sent: readonly MailboxMessage[]; received: readonly MailboxMessage[] } | undefined,
  myCall: string,
  service: string | null,
): Thread[] {
  const myBase = baseOf(myCall);
  const svc = service?.toUpperCase() ?? null;
  // the service call shares the sysop's base call but speaks for the instance: its side is never the operator's
  const mine = (call: string | null | undefined) =>
    !!call && call.toUpperCase() !== svc && baseOf(call) === myBase && myBase.length >= 3;
  const byPeer = new Map<string, ThreadItem[]>();
  const add = (peer: string, item: Omit<ThreadItem, "with">) => {
    const p = threadKey(peer, svc);
    const list = byPeer.get(p) ?? [];
    list.push({ ...item, with: peer.toUpperCase() });
    byPeer.set(p, list);
  };

  for (const m of messages) {
    if (!m.toCall) continue;
    if (mine(m.fromCall)) {
      add(m.toCall, {
        key: `m:${m.id}`,
        ts: m.ts,
        dir: "out",
        from: m.fromCall,
        text: m.body,
        transport: m.transport,
        state: m.delivery ?? "sent",
      });
    } else if (mine(m.toCall)) {
      const delivered = svc && m.fromCall.toUpperCase() === svc ? DELIVERED.exec(m.body) : null;
      if (delivered)
        add(delivered[1]!, {
          key: `m:${m.id}`,
          ts: m.ts,
          dir: "in",
          from: delivered[1]!.toUpperCase(),
          text: delivered[2]!,
          transport: m.transport,
          viaMailbox: true,
        });
      else
        add(m.fromCall, {
          key: `m:${m.id}`,
          ts: m.ts,
          dir: "in",
          from: m.fromCall,
          text: m.body,
          transport: m.transport,
        });
    }
  }

  for (const b of mailbox?.sent ?? [])
    add(b.deliveredTo ?? b.to, {
      key: `box:${b.id}`,
      ts: b.createdAt,
      dir: "out",
      from: b.from,
      text: b.text,
      viaMailbox: true,
      state: MAILBOX_STATE[b.status],
      ...(b.status === "held" ? { withdrawId: b.id } : {}),
    });
  // a message left for the operator shows here until it goes out on the air, then as the service call delivered it
  for (const b of mailbox?.received ?? [])
    if (b.status === "held")
      add(b.from, {
        key: `box:${b.id}`,
        ts: b.createdAt,
        dir: "in",
        from: b.from,
        text: b.text,
        viaMailbox: true,
        state: "waiting",
      });

  const threads: Thread[] = [];
  for (const [peer, items] of byPeer) {
    items.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
    const last = items[items.length - 1]!;
    threads.push({
      peer,
      replyTo: last.with,
      items,
      last,
      ...(isPersonMarker(peer) && { withdrawn: true }),
    });
  }
  return threads.sort((a, b) => b.last.ts - a.last.ts);
}

/**
 * The conversation a callsign belongs to: its base call, so every SSID of one station is one conversation and a
 * message waiting in the Mailbox for OE6BOB stays beside the one OE6BOB-9 answered. The service call speaks for
 * the instance, not for the sysop who shares its base call, and keeps a conversation of its own; a withdrawn
 * marker stays as it is.
 */
export function threadKey(call: string, service: string | null): string {
  const c = call.trim().toUpperCase();
  if (isPersonMarker(c) || (service && c === service.toUpperCase())) return c;
  return baseOf(c);
}

/** The callsigns the operator wrote with most recently, for the recipient field's suggestions. */
export function correspondents(threads: readonly Thread[], limit = 20): string[] {
  return threads
    .filter((t) => !t.withdrawn)
    .slice(0, limit)
    .map((t) => t.replyTo);
}

/** How a new message travels: now, or kept in the Mailbox until the instance hears the station. */
export type Delivery = "now" | "heard";
/** How "now" goes out: from the operator's own radio in this browser, or through the instance to APRS-IS. */
type NowRoute = "radio" | "instance";

/**
 * Pure: the route a message sent now takes. The operator's own radio when it is connected with a TNC that can
 * transmit and transmit is switched on; otherwise the instance's APRS-IS outbox.
 */
export function nowRoute(r: { link: LinkKind | null; txOn: boolean; verified: boolean }): NowRoute {
  return (r.link === "serial" || r.link === "ble") && r.txOn && r.verified ? "radio" : "instance";
}

/** Why the operator cannot send at all, or null when they can. Every path puts the text on the air in their name. */
export function sendBlocked(s: { signedIn: boolean; verified: boolean; callsign: string }): string | null {
  if (!s.signedIn || s.callsign.length < 3) return "Sign in to send a message.";
  if (!s.verified)
    return `Verify ${baseOf(s.callsign)} to send: every message goes out on the air under your callsign.`;
  return null;
}

/** The longest text for a delivery: the Mailbox sends `de <call>: <text>` from the service call. */
export function textMax(delivery: Delivery, from: string): number {
  return delivery === "heard" ? APRS_TEXT_MAX - `de ${from.toUpperCase()}: `.length : APRS_TEXT_MAX;
}

/** A recipient the APRS addressee field holds: a callsign with an optional SSID. */
export const validRecipient = (to: string): boolean =>
  /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/i.test(to.trim()) && !isPersonMarker(to);
