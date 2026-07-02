/**
 * panel.ts — the declarative panel model a `panel`-capability Tool contributes (docs/28). A tool NEVER
 * touches the DOM; it emits a typed node tree and the host renders it with real semantic elements +
 * theme tokens. This keeps the sandbox safe (no styled-div/script injection) while still letting a tool
 * present a real UI region — a readout, a small table, status bars — on whatever surface(s) it targets.
 */

/** A tone hint mapped by the host to a status/tier token (never a raw colour). */
export type PanelTone = "default" | "muted" | "accent" | "ok" | "warn" | "bad";

/** One node in a panel. Intentionally small + serialisable so imported (sandboxed) tools can emit it too. */
export type PanelNode =
  | { kind: "text"; text: string; tone?: PanelTone }
  | { kind: "kv"; key: string; value: string; tone?: PanelTone }         // a labelled value row
  | { kind: "badge"; text: string; tone?: PanelTone }
  | { kind: "bar"; label: string; value: number; max: number; tone?: PanelTone } // an ASCII/▁ bar meter
  | { kind: "table"; head: string[]; rows: string[][] };

/** A tool's panel: an optional title + an ordered list of nodes. Replaced wholesale on each setPanel. */
export interface PanelSpec {
  title?: string;
  nodes: PanelNode[];
}

const TONES = new Set<PanelTone>(["default", "muted", "accent", "ok", "warn", "bad"]);
const tone = (t: unknown): PanelTone | undefined => (TONES.has(t as PanelTone) ? (t as PanelTone) : undefined);
const str = (x: unknown, cap = 240): string => (typeof x === "string" ? x : String(x ?? "")).slice(0, cap);

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
      case "text": nodes.push({ kind: "text", text: str(d.text), tone: tone(d.tone) }); break;
      case "kv": nodes.push({ kind: "kv", key: str(d.key, 60), value: str(d.value), tone: tone(d.tone) }); break;
      case "badge": nodes.push({ kind: "badge", text: str(d.text, 40), tone: tone(d.tone) }); break;
      case "bar": nodes.push({ kind: "bar", label: str(d.label, 60), value: Number(d.value) || 0, max: Number(d.max) || 1, tone: tone(d.tone) }); break;
      case "table": {
        const head = (Array.isArray(d.head) ? d.head : []).slice(0, 8).map((h) => str(h, 40));
        const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 100)
          .map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => str(c, 80)));
        nodes.push({ kind: "table", head, rows });
        break;
      }
      default: /* unknown kind → dropped */ break;
    }
  }
  return { title: typeof o.title === "string" ? str(o.title, 80) : undefined, nodes };
}
