// SPDX-License-Identifier: MIT
/**
 * hostmode.ts — the WA8DED / "TheFirmware" host-mode codec. Host mode is the classic
 * multi-channel TNC protocol Graphic Packet leaned on (and TFPCX emulates in software): the host
 * frames commands/data per channel, the TNC frames typed responses (success / message / monitor /
 * connected info). This is the PURE wire codec, unit-tested for self-consistency; the serial handshake
 * + exact TNC quirks are validate-at-deploy against a real TNC2-firmware / TFPCX.
 *
 * Convention used here (documented so a deploy can verify it):
 *   Host → TNC:  [chan][0][cmd…][0x00]              (command, NUL-terminated)
 *                [chan][1][len-1][data…]            (info, 1..256 bytes)
 *   TNC → Host:  [chan][0]                          type 0 = success, nothing follows
 *                [chan][1|2|3][text…][0x00]          success-msg / error / link-status
 *                [chan][4][hdr…][0x00]               monitor header of a frame without info
 *                [chan][5][hdr…][0x00]               monitor header; its info follows as type 6
 *                [chan][6|7][len-1][data…]           monitor info / connected info, 1..256 bytes
 */
const enc = (s: string): Uint8Array => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
};
const dec = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};

/** Host → TNC: a command on a channel (channel 0 = the TNC itself). */
export function hostmodeCommand(chan: number, cmd: string): Uint8Array {
  const c = enc(cmd);
  const out = new Uint8Array(2 + c.length + 1);
  out[0] = chan & 0xff;
  out[1] = 0;
  out.set(c, 2);
  out[2 + c.length] = 0;
  return out;
}
/**
 * Host → TNC: up to 256 bytes of info to transmit on a channel (caller splits longer payloads). No info is
 * no frame: the length byte holds len-1, so a zero-length frame would announce 256 bytes it does not carry.
 */
export function hostmodeData(chan: number, data: Uint8Array): Uint8Array {
  if (!data.length) return new Uint8Array(0);
  const n = Math.min(data.length, 256);
  const out = new Uint8Array(3 + n);
  out[0] = chan & 0xff;
  out[1] = 1;
  out[2] = (n - 1) & 0xff;
  out.set(data.subarray(0, n), 3);
  return out;
}

export type HostmodeEvent =
  | { chan: number; type: 0 }
  | { chan: number; type: 1 | 2 | 3 | 4 | 5; text: string }
  | { chan: number; type: 6 | 7; info: Uint8Array };

const nulAt = (buf: Uint8Array, from: number): number => {
  for (let i = from; i < buf.length; i++) if (buf[i] === 0) return i;
  return -1;
};

/** Parse TNC → host frames; return decoded events + trailing partial bytes to re-feed. */
export function parseHostmode(buf: Uint8Array): { events: HostmodeEvent[]; rest: Uint8Array } {
  const events: HostmodeEvent[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const chan = buf[off]!,
      type = buf[off + 1]!;
    if (type === 0) {
      events.push({ chan, type: 0 });
      off += 2;
      continue;
    }
    if (type >= 1 && type <= 5) {
      const end = nulAt(buf, off + 2);
      if (end < 0) break; // wait for the terminator
      events.push({ chan, type: type as 1 | 2 | 3 | 4 | 5, text: dec(buf.slice(off + 2, end)) });
      off = end + 1;
      continue;
    }
    if (type === 6 || type === 7) {
      if (buf.length - off < 3) break; // need the length byte
      const len = buf[off + 2]! + 1; // the length byte holds len-1: 1..256 bytes
      if (buf.length - (off + 3) < len) break;
      events.push({ chan, type, info: buf.slice(off + 3, off + 3 + len) });
      off += 3 + len;
      continue;
    }
    // unknown type — resync by dropping one byte (defensive; shouldn't happen on a clean link)
    off += 1;
  }
  return { events, rest: buf.slice(off) };
}
