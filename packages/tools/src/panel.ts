// SPDX-License-Identifier: MIT
/**
 * panel.ts — the declarative panel model a `panel`-capability Tool contributes. A tool NEVER
 * touches the DOM; it emits a typed node tree and the host renders it with real semantic elements +
 * theme tokens. This keeps the sandbox safe (no styled-div/script injection) while still letting a tool
 * present a real UI region — a readout, a small table, status bars — on whatever surface(s) it targets.
 */

/** A tone hint mapped by the host to a status/tier token (never a raw colour). */
export type PanelTone = "default" | "muted" | "accent" | "ok" | "warn" | "bad";

/** One node in a panel. Intentionally small + serialisable so imported (sandboxed) tools can emit it too. */
export type PanelNode =
  | { kind: "text"; text: string; tone?: PanelTone }
  | { kind: "kv"; key: string; value: string; tone?: PanelTone } // a labelled value row
  | { kind: "badge"; text: string; tone?: PanelTone }
  | { kind: "bar"; label: string; value: number; max: number; tone?: PanelTone } // an ASCII/▁ bar meter
  | { kind: "table"; head: string[]; rows: string[][] }
  // A monospace CP437/ANSI cell grid — the Graphic-Packet "GIP" imagery primitive. Each
  // cell is a single glyph with an optional ANSI colour index (0–15 → --ansi-N); the host renders it as
  // a `grid` of spans. Function-agnostic: a tool decides the cells are an image, a spectrum, a game board.
  | { kind: "blocks"; cols: number; cells: { ch: string; c?: number }[] };

/** A tool's panel: an optional title + an ordered list of nodes. Replaced wholesale on each setPanel. */
export interface PanelSpec {
  title?: string;
  nodes: PanelNode[];
}

/** Turn a block of monospace text (CP437/ANSI art — e.g. a `.ans` export) into a `blocks` node. Monochrome
 *  (green phosphor) by default; `cols` = the widest line, rows padded so the grid is rectangular. */
export function parseBlocks(text: string, cap = 4000): Extract<PanelNode, { kind: "blocks" }> {
  const lines = String(text).replace(/\r/g, "").split("\n").slice(0, 64);
  const cols = Math.max(
    1,
    Math.min(
      200,
      lines.reduce((m, l) => Math.max(m, l.length), 0),
    ),
  );
  const cells: { ch: string; c?: number }[] = [];
  for (const line of lines) for (let x = 0; x < cols && cells.length < cap; x++) cells.push({ ch: line[x] ?? " " });
  return { kind: "blocks", cols, cells };
}

const TONES = new Set<PanelTone>(["default", "muted", "accent", "ok", "warn", "bad"]);
const tone = (t: unknown): PanelTone | undefined => (TONES.has(t as PanelTone) ? (t as PanelTone) : undefined);
// Coerce an untrusted panel value to a string: primitives stringify, an object becomes "" (never
// "[object Object]"), then cap the length.
const str = (x: unknown, cap = 240): string =>
  (typeof x === "string"
    ? x
    : typeof x === "number" || typeof x === "boolean" || typeof x === "bigint"
      ? String(x)
      : ""
  ).slice(0, cap);

/**
 * Coerce an untrusted panel (from an imported tool) into a safe PanelSpec — bounds strings/rows, drops
 * unknown node kinds. Trusted built-ins can build a PanelSpec directly; this guards the imported path.
 */
export function sanitizePanel(input: unknown): PanelSpec {
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawNodes = Array.isArray(o.nodes) ? o.nodes.slice(0, 60) : [];
  const nodes: PanelNode[] = [];
  for (const n of rawNodes) {
    if (!n || typeof n !== "object") continue;
    const d = n as Record<string, unknown>;
    switch (d.kind) {
      case "text":
        nodes.push({ kind: "text", text: str(d.text), tone: tone(d.tone) });
        break;
      case "kv":
        nodes.push({ kind: "kv", key: str(d.key, 60), value: str(d.value), tone: tone(d.tone) });
        break;
      case "badge":
        nodes.push({ kind: "badge", text: str(d.text, 40), tone: tone(d.tone) });
        break;
      case "bar":
        nodes.push({
          kind: "bar",
          label: str(d.label, 60),
          value: Number(d.value) || 0,
          max: Number(d.max) || 1,
          tone: tone(d.tone),
        });
        break;
      case "table": {
        const head = (Array.isArray(d.head) ? d.head : []).slice(0, 8).map((h) => str(h, 40));
        const rows = (Array.isArray(d.rows) ? d.rows : [])
          .slice(0, 100)
          .map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => str(c, 80)));
        nodes.push({ kind: "table", head, rows });
        break;
      }
      case "blocks": {
        const cols = Math.max(1, Math.min(200, Math.floor(Number(d.cols) || 1)));
        const cells = (Array.isArray(d.cells) ? d.cells : []).slice(0, 4000).map((cell) => {
          const o = cell && typeof cell === "object" ? (cell as Record<string, unknown>) : {};
          const ch = (typeof o.ch === "string" ? o.ch : " ").slice(0, 1) || " ";
          const c = Number(o.c);
          return Number.isInteger(c) && c >= 0 && c <= 15 ? { ch, c } : { ch };
        });
        nodes.push({ kind: "blocks", cols, cells });
        break;
      }
      default:
        /* unknown kind → dropped */ break;
    }
  }
  return { title: typeof o.title === "string" ? str(o.title, 80) : undefined, nodes };
}
