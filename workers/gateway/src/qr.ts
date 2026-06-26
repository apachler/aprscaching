/**
 * qr.ts — a small, dependency-free QR encoder (byte mode, ECC level M, versions 1–6) rendering SVG.
 * Enough for cache deep-links / share URLs (v6-M holds 106 bytes). Pure + runtime-neutral.
 *
 * Correctness: the Reed–Solomon core is unit-tested against the ISO/IEC 18004 worked example, and the
 * matrix against structural invariants (size, finder/timing patterns). Versions ≥7 (which need version
 * info blocks) are intentionally out of scope.
 */

// ---- GF(256), primitive polynomial 0x11d ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** Reed–Solomon error-correction codewords for `data` (poly division by the generator of degree n). */
export function rsEncode(data: number[], n: number): number[] {
  // generator polynomial g(x) = ∏ (x - α^i)
  const gen = [1];
  for (let i = 0; i < n; i++) {
    gen.push(0);
    for (let j = gen.length - 1; j > 0; j--) gen[j] = gen[j - 1]! ^ gfMul(gen[j]!, EXP[i]!);
    gen[0] = gfMul(gen[0]!, EXP[i]!);
  }
  const res = new Array(n).fill(0);
  for (const d of data) {
    const factor = d ^ res.shift()!;
    res.push(0);
    for (let i = 0; i < n; i++) res[i] ^= gfMul(gen[n - 1 - i]!, factor);
  }
  return res;
}

// ---- version table (ECC level M): per-block data codewords, EC codewords, remainder bits, alignment ----
interface VerSpec { ver: number; blocks: number[]; ec: number; remainder: number; align: number[] }
const VERSIONS: VerSpec[] = [
  { ver: 1, blocks: [16], ec: 10, remainder: 0, align: [] },
  { ver: 2, blocks: [28], ec: 16, remainder: 7, align: [6, 18] },
  { ver: 3, blocks: [44], ec: 26, remainder: 7, align: [6, 22] },
  { ver: 4, blocks: [32, 32], ec: 18, remainder: 7, align: [6, 26] },
  { ver: 5, blocks: [43, 43], ec: 24, remainder: 7, align: [6, 30] },
  { ver: 6, blocks: [27, 27, 27, 27], ec: 16, remainder: 7, align: [6, 34] },
];
const capacity = (v: VerSpec) => v.blocks.reduce((a, b) => a + b, 0);

/** Encode a string (UTF-8, byte mode) into a boolean module matrix. Throws if too long for v6-M. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = VERSIONS.find((v) => capacity(v) >= bytes.length + 2 + Math.ceil(0 / 8)); // +2: mode+count headroom
  if (!spec) throw new Error("data too long for QR v1–6 (max 106 bytes)");

  // ---- bitstream: mode(0100) + 8-bit count + data + terminator + byte-align + pad ----
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const totalData = capacity(spec);
  const cap = totalData * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);     // terminator
  while (bits.length % 8) bits.push(0);                              // byte align
  const padBytes = [0xec, 0x11];
  for (let i = 0; bits.length < cap; i++) push(padBytes[i % 2]!, 8); // pad

  const dataCw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) dataCw.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // ---- split into blocks, RS each, interleave ----
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let pos = 0;
  for (const len of spec.blocks) { const d = dataCw.slice(pos, pos + len); pos += len; blocks.push(d); ecs.push(rsEncode(d, spec.ec)); }
  const final: number[] = [];
  for (let i = 0; i < Math.max(...spec.blocks); i++) for (const b of blocks) if (i < b.length) final.push(b[i]!);
  for (let i = 0; i < spec.ec; i++) for (const e of ecs) final.push(e[i]!);

  const finalBits: number[] = [];
  for (const cw of final) for (let i = 7; i >= 0; i--) finalBits.push((cw >> i) & 1);
  for (let i = 0; i < spec.remainder; i++) finalBits.push(0);

  // ---- matrix ----
  const size = 17 + spec.ver * 4;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r: number, c: number, v: boolean) => { m[r]![c] = v; };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(rr, cc, inRing || inCore);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i++) { if (m[6]![i] === null) set(6, i, i % 2 === 0); if (m[i]![6] === null) set(i, 6, i % 2 === 0); }
  // alignment patterns
  for (const r of spec.align) for (const c of spec.align) {
    if (m[r]![c] !== null) continue; // skip those overlapping finders
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // dark module
  // reserve format areas (set later) — mark as non-null with false so data skips them
  const reserveFormat = () => {
    for (let i = 0; i < 9; i++) { if (m[8]![i] === null) set(8, i, false); if (m[i]![8] === null) set(i, 8, false); }
    for (let i = 0; i < 8; i++) { if (m[8]![size - 1 - i] === null) set(8, size - 1 - i, false); if (m[size - 1 - i]![8] === null) set(size - 1 - i, 8, false); }
  };
  reserveFormat();

  // ---- place data (zigzag, upward/downward columns), skipping the vertical timing column 6 ----
  const reserved = m.map((row) => row.map((v) => v !== null));
  let bi = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row]![c]) continue;
        const bit = bi < finalBits.length ? finalBits[bi]! : 0; bi++;
        m[row]![c] = bit === 1;
      }
    }
    upward = !upward;
  }

  // ---- masking: pick the lowest-penalty of the 8 standard masks ----
  const maskFns = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number, _c: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const applyMask = (base: boolean[][], fn: (r: number, c: number) => boolean): boolean[][] =>
    base.map((row, r) => row.map((v, c) => (reserved[r]![c] ? v : v !== fn(r, c))));
  const fullMatrix = m.map((row) => row.map((v) => v === true));

  let best: boolean[][] | null = null, bestMask = 0, bestPenalty = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const cand = applyMask(fullMatrix, maskFns[mk]!);
    placeFormat(cand, reserved, mk, size);
    const p = penalty(cand, size);
    if (p < bestPenalty) { bestPenalty = p; best = cand; bestMask = mk; }
  }
  void bestMask;
  return best!;
}

// format info: 5 bits (ECC level M = 0b00, mask 3 bits) → BCH(15,5), XOR mask 0x5412
function placeFormat(m: boolean[][], reserved: boolean[][], mask: number, size: number): void {
  const data = (0b00 << 3) | mask;
  let bch = data << 10;
  for (let i = 14; i >= 10; i--) if ((bch >> i) & 1) bch ^= 0b10100110111 << (i - 10);
  const bits = ((data << 10) | (bch & 0x3ff)) ^ 0b101010000010010;
  const bit = (i: number) => ((bits >> i) & 1) === 1;
  // top-left (around the corner) + duplicated near top-right / bottom-left
  for (let i = 0; i <= 5; i++) m[8]![i] = bit(i);
  m[8]![7] = bit(6); m[8]![8] = bit(7); m[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i]![8] = bit(i);
  for (let i = 0; i <= 7; i++) m[size - 1 - i]![8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8]![size - 15 + i] = bit(i);
  void reserved;
}

function penalty(m: boolean[][], size: number): number {
  let p = 0;
  // rule 1: runs of 5+ same-colour in row/col
  for (let r = 0; r < size; r++) for (const line of [m[r]!, m.map((row) => row[r]!)]) {
    let run = 1;
    for (let i = 1; i < size; i++) { if (line[i] === line[i - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1; }
  }
  // rule 3: finder-like 1011101 patterns (rough)
  for (let r = 0; r < size; r++) for (let c = 0; c < size - 6; c++) {
    const seq = [m[r]![c], m[r]![c + 1], m[r]![c + 2], m[r]![c + 3], m[r]![c + 4], m[r]![c + 5], m[r]![c + 6]];
    if (JSON.stringify(seq) === JSON.stringify([true, false, true, true, true, false, true])) p += 40;
  }
  return p;
}

/** Render a QR for `text` as a standalone SVG string (with a 4-module quiet zone). */
export function qrSvg(text: string, opts: { size?: number; quiet?: number } = {}): string {
  const matrix = qrMatrix(text);
  const n = matrix.length;
  const quiet = opts.quiet ?? 4;
  const dim = n + quiet * 2;
  const px = opts.size ?? 256;
  let rects = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matrix[r]![c]) rects += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${rects}" fill="#000"/></svg>`;
}
