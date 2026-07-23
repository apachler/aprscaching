// SPDX-License-Identifier: MIT
/**
 * bbs-fbb-gate.ts — the SID switch in front of the interactive BBS. A real FBB-family BBS
 * greets every caller with its SID (`[NAME-VER-FLAGS$]`); a human sees it as banner noise, but a
 * forwarding peer (FBB, BPQ, JNOS, our own scheduler) answers with its OWN SID and then drives the
 * F-protocol. This wrapper serves both from one callsign: lines go to the interactive `BbsSession`
 * until the peer's first line IS an SID — from then on the session is an `FbbSession` responder
 * (proposals in, verdicts out, reverse forwarding from the store), and when it ends (`FQ`) the
 * collected traffic is handed to `onSessionEnd` for persistence.
 */
import { FbbSession, type FbbStore } from "./fbb-session.js";
import type { LineApp, LineReply } from "./link-app.js";

const SID_RE = /^\[[^\]]+\]$/;

export interface FbbGateOpts {
  /** Our SID, emitted in the greeting (default matches FbbSession's). */
  sid?: string;
  /** Build the responder's store when a forwarding peer announces itself (may fetch the reverse pool). */
  makeStore: () => FbbStore | Promise<FbbStore>;
  /** Called once when the forwarding session completes; persist store.inbox / sent BIDs here. */
  onSessionEnd?: (store: FbbStore) => void | Promise<void>;
}

export class FbbGatedBbs implements LineApp {
  private fbb: FbbSession | null = null;
  private store: FbbStore | null = null;
  private ended = false;

  constructor(
    private interactive: LineApp,
    private opts: FbbGateOpts,
  ) {}

  private sid(): string {
    return this.opts.sid ?? "[ACG-1.0-F$]";
  }

  greeting(): string[] {
    return [this.sid(), ...this.interactive.greeting()];
  }

  async handle(input: string): Promise<LineReply> {
    if (!this.fbb) {
      const t = input.trim();
      if (SID_RE.test(t)) {
        // the caller is a forwarding peer — switch this session to the F-protocol responder
        this.store = await this.opts.makeStore();
        this.fbb = new FbbSession(this.store, { initiator: false, sid: this.sid(), sidAlreadySent: true });
        const r = this.fbb.feed(t);
        return { lines: r.out, disconnect: r.done };
      }
      return this.interactive.handle(input);
    }
    const r = this.fbb.feed(input);
    if (r.done && !this.ended) {
      this.ended = true;
      try {
        await this.opts.onSessionEnd?.(this.store!);
      } catch (e) {
        console.error(`[fbb-gate] session persist failed: ${(e as Error).message}`);
      }
    }
    return { lines: r.out, disconnect: r.done };
  }
}
