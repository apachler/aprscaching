# FBB B0/B1 compressed-forwarding wire facts

Ground truth for implementing `lzhuf` in `packages/packet`, established against the F6FBB 7.0.11
source package (`apt-get source fbb`, GPL — reference only, the implementation is written from the
algorithm; LZHUF itself is Okumura's public-domain design) and a live `xfbbd` (see README runbook).

## Codec parameters (diverge from classic lzhuf!)

- LZSS window `N = 2048` (classic Okumura ships 4096 — a same-tables/different-window variant),
  lookahead `F = 60`, `THRESHOLD = 2`.
- Adaptive Huffman: `N_CHAR = 256 - THRESHOLD + F = 314`, table `T = N_CHAR*2 - 1 = 627`, root
  `R = T - 1`, rebuild at `MAX_FREQ = 0x8000`.
- Position coding keeps the CLASSIC 6+6-bit Okumura scheme (`p_len`/`p_code` on the upper 6 bits,
  lower 6 bits verbatim) even though N=2048 — the tables are the public-domain originals.

## Stream layout

- Input normalization: bodies travel CRLF (`\n` → `\r\n`, lone `\r` dropped) and the message
  HEADER string is prepended to the compression input (`headlen` counts into `filesize`).
- **B0** ("basic"): `[4-byte LE textsize][compressed bytes]`.
- **B1**: `[2-byte CRC-16][4-byte LE filesize][compressed bytes]` — the CRC covers everything
  after itself (filesize bytes + compressed stream, threaded through `crc_fputc`), patched at
  offset 0 after encoding. CRC is the TransIt table-lookup CRC-16 (`src/pac_crc.c`).
- Message framing on the wire (the forwarding session, outside the codec): SOH header block with
  title/offset, STX data blocks, EOT + 1-byte additive checksum (`chck` accumulates every data
  byte); proposals switch from `FB` to `FA` when compression is negotiated.

## Validation strategy

The codec lives in `packages/packet/src/lzhuf.ts` with always-on round-trip tests
(`test/lzhuf.test.ts`: B0/B1 framing, CRC integrity, window-wraparound, all byte values).

**Byte-exactness** against real F6FBB is proven by diffing our `lzhufEncodeB0` output against an
oracle compiled from the FBB source. The oracle is *not* vendored here (it is F6FBB's GPL C); it is
reproducible in three steps: `apt-get source fbb`, assemble a standalone B0 driver around the pure
functions in `src/lzhuf.c` (the `Encode`/`Decode` core, `p_len`/`p_code`/`d_code`/`d_len` tables,
tree + bit-I/O), then compare. This check was run during development and passed byte-for-byte on all
corpus cases. The interop `fbb/` container reconfirms it end-to-end: a compressed forwarding session
(FBB `fbbcomp = OK 3`; its SID advertises `B`) exercises the codec against the reference itself.

## Session transport (built)

The binary-block session transport is implemented in `packages/packet/src/fbb-binary.ts` and wired into
the FBB session: SOH header block (`title \0 offset \0`) · STX data blocks (≤250 B; 0-length ⇒ 256 on
decode) · EOT + additive checksum; `FA` proposals in place of `FB` and an `FS !<offset>` resume reply.
Compression is offered when `BBS_FORWARD_COMPRESS=1` and engages only when the partner's SID also
advertises `B` (both peers must agree), negotiating back to plain ASCII otherwise. Byte-level
round-trips, negotiation, and resume are unit-tested; the compressed peer for live validation is the
byte-capable F6FBB container above (an ASCII-only responder is fallback-only).
