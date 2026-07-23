// SPDX-License-Identifier: MIT
// FBB compressed ("B") transport: SOH/STX/EOT block framing with the additive checksum, the streaming
// decoder, LZHUF-B1 message round-trips (incl. resume), SID compression negotiation, and FS `!offset`.
import { describe, it, expect } from "vitest";
import {
  encodeBinaryTransfer,
  BinaryTransferDecoder,
  encodeFbbCompressed,
  decodeFbbCompressed,
  fbbCompressedLength,
  parseBinaryHeader,
  sidFlags,
  sidHasCompression,
  compressionAgreed,
  SOH,
  STX,
  EOT,
  FBB_DATA_BLOCK,
} from "../src/fbb-binary.js";
import { parseFSDetailed, parseFS, buildProposalFA, parseProposal } from "../src/forward.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("FBB binary block framing", () => {
  it("frames header + data as SOH/STX/EOT with a zero-sum additive checksum", () => {
    const frame = encodeBinaryTransfer(enc("T\0"), enc("hello"));
    expect(frame[0]).toBe(SOH);
    expect(frame[1]).toBe(2); // header length
    // the last two bytes are EOT + the checksum byte; every payload byte + checksum ≡ 0 (mod 256)
    expect(frame[frame.length - 2]).toBe(EOT);
    let sum = 0;
    for (const b of enc("T\0")) sum += b;
    for (const b of enc("hello")) sum += b;
    expect((sum + frame[frame.length - 1]!) & 0xff).toBe(0);
  });

  it("splits data into ≤250-byte STX blocks", () => {
    const data = new Uint8Array(600).fill(0x41);
    const frame = encodeBinaryTransfer(enc(""), data);
    // count STX markers: 600 → 250 + 250 + 100 = 3 blocks
    let stx = 0;
    for (let i = 0; i < frame.length; i++) if (frame[i] === STX && (i === 0 || true)) stx++;
    // markers can collide with payload bytes (0x41≠STX here), so this count is exact for 0x41 fill
    expect(stx).toBe(3);
    expect(FBB_DATA_BLOCK).toBe(250);
  });

  it("round-trips through the streaming decoder, split across arbitrary byte boundaries", () => {
    const frame = encodeBinaryTransfer(enc("hdr\0"), enc("the quick brown fox"));
    const dec = new BinaryTransferDecoder();
    const got: ReturnType<BinaryTransferDecoder["push"]> = [];
    for (let i = 0; i < frame.length; i += 3) got.push(...dec.push(frame.subarray(i, i + 3)));
    expect(got).toHaveLength(1);
    expect(got[0]!.checksumOk).toBe(true);
    expect(new TextDecoder().decode(got[0]!.header)).toBe("hdr\0");
    expect(new TextDecoder().decode(got[0]!.data)).toBe("the quick brown fox");
  });

  it("flags a corrupted transfer as checksum-bad", () => {
    const frame = encodeBinaryTransfer(enc("h\0"), enc("payload"));
    frame[frame.length - 1] = (frame[frame.length - 1]! ^ 0xff) & 0xff; // corrupt the checksum byte
    const [t] = new BinaryTransferDecoder().push(frame);
    expect(t!.checksumOk).toBe(false);
  });

  it("decodes a peer's 0-length block byte as 256 bytes", () => {
    // hand-build SOH(empty) STX(len=0 ⇒ 256) <256 bytes> EOT chk
    const data = new Uint8Array(256).fill(0x42);
    let chk = 0;
    for (const b of data) chk = (chk + b) & 0xff;
    const frame = Uint8Array.from([SOH, 0, STX, 0, ...data, EOT, (256 - chk) & 0xff]);
    const [t] = new BinaryTransferDecoder().push(frame);
    expect(t!.data.length).toBe(256);
    expect(t!.checksumOk).toBe(true);
  });
});

describe("FBB compressed message (LZHUF-B1 + framing)", () => {
  it("round-trips a message body through compress → frame → decode → decompress", () => {
    const body = "Hello from OE8APR.\nThis is a compressed FBB bulletin.\n".repeat(20);
    const frame = encodeFbbCompressed({ title: "Test bulletin", body });
    const [t] = new BinaryTransferDecoder().push(frame);
    const out = decodeFbbCompressed(t!);
    expect(out.title).toBe("Test bulletin");
    expect(out.body).toBe(body);
    expect(out.crcOk).toBe(true);
  });

  it("compresses a repetitive body well below its raw size", () => {
    const body = "CQ CQ CQ de OE8APR ".repeat(200);
    const frame = encodeFbbCompressed({ title: "x", body });
    expect(frame.length).toBeLessThan(body.length / 2);
  });

  it("resumes a partially-held message from a byte offset", () => {
    const body = "resume me ".repeat(100);
    const full = encodeFbbCompressed({ title: "R", body }); // offset 0, whole stream — the sender's first try
    const priorStream = (() => {
      const [t] = new BinaryTransferDecoder().push(full);
      return t!.data; // the complete B1 stream the receiver captured before the link dropped
    })();
    const offset = Math.floor(priorStream.length / 2);
    const resumed = encodeFbbCompressed({ title: "R", body, offset });
    const [t] = new BinaryTransferDecoder().push(resumed);
    expect(parseBinaryHeader(t!.header)).toEqual({ title: "R", offset });
    // stitch the held prefix + the resumed tail, then decode
    const out = decodeFbbCompressed(t!, priorStream);
    expect(out.body).toBe(body);
    expect(out.crcOk).toBe(true);
  });

  it("reports the compressed stream length a receiver would cite on resume", () => {
    const body = "measure ".repeat(50);
    const frame = encodeFbbCompressed({ title: "m", body });
    const [t] = new BinaryTransferDecoder().push(frame);
    expect(fbbCompressedLength(body)).toBe(t!.data.length);
  });
});

describe("FBB SID compression negotiation", () => {
  it("extracts flags and detects the B flag", () => {
    expect(sidFlags("[FBB-7.0.11-AB1FHMRX$]")).toBe("AB1FHMRX");
    expect(sidHasCompression("[FBB-7.0.11-AB1FHMRX$]")).toBe(true);
    expect(sidHasCompression("[ACG-1.0-F$]")).toBe(false);
  });

  it("agrees on compression only when both SIDs advertise B", () => {
    expect(compressionAgreed("[ACG-1.0-BF$]", "[FBB-7.0.11-B$]")).toBe(true);
    expect(compressionAgreed("[ACG-1.0-F$]", "[FBB-7.0.11-B$]")).toBe(false);
    expect(compressionAgreed("[ACG-1.0-BF$]", "[FBB-7.0.11-F$]")).toBe(false);
  });
});

describe("FBB FA proposals + FS resume replies", () => {
  it("builds and parses an FA (compressed) proposal", () => {
    const [line] = buildProposalFA([
      { type: "B", from: "OE8APR", atBbs: "OE8XBM", to: "ALL", bid: "1234_OE8", size: 500 },
    ]);
    expect(line!.startsWith("FA ")).toBe(true);
    const p = parseProposal(line!);
    expect(p).toMatchObject({ type: "B", from: "OE8APR", to: "ALL", bid: "1234_OE8", size: 500 });
  });

  it("parses FS `!offset` as accept-with-resume and keeps plain verdicts", () => {
    const v = parseFSDetailed("FS +!512-=");
    expect(v).toEqual([
      { verdict: "accept" },
      { verdict: "accept", offset: 512 },
      { verdict: "reject" },
      { verdict: "defer" },
    ]);
    // the compat wrapper flattens a resume to a plain accept
    expect(parseFS("FS +!512-=")).toEqual(["accept", "accept", "reject", "defer"]);
  });
});
