/**
 * ansi.ts — a small, safe ANSI-subset parser (docs/27 B.2). F6FBB/BPQ BBS menus came alive with ANSI
 * colour + box-drawing; the terminal pane must render that. We parse SGR colour/bold into spans and
 * drop every other control sequence (cursor moves, clears) so a remote BBS can't drive our cursor.
 * Colours are returned as 0–15 palette indices; the web layer maps them to theme tokens (so the
 * Cogmind flip recolours BBS output for free).
 */
export interface AnsiSpan { text: string; fg: number | null; bg: number | null; bold: boolean }

const ESC = 0x1b;

/** Apply one SGR parameter list to the running attribute state. */
function applySgr(params: number[], st: { fg: number | null; bg: number | null; bold: boolean }): void {
  if (params.length === 0) params = [0];
  for (const p of params) {
    if (p === 0) { st.fg = null; st.bg = null; st.bold = false; }
    else if (p === 1) st.bold = true;
    else if (p === 22) st.bold = false;
    else if (p >= 30 && p <= 37) st.fg = p - 30;
    else if (p === 39) st.fg = null;
    else if (p >= 40 && p <= 47) st.bg = p - 40;
    else if (p === 49) st.bg = null;
    else if (p >= 90 && p <= 97) st.fg = p - 90 + 8;       // bright foreground
    else if (p >= 100 && p <= 107) st.bg = p - 100 + 8;    // bright background
    // everything else (underline, blink, …) ignored — colour subset only
  }
}

/**
 * Parse a string with ANSI escapes into colour spans. Non-SGR CSI sequences are consumed and dropped;
 * a lone/ð truncated ESC is dropped. Adjacent text with identical attributes is coalesced.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const st = { fg: null as number | null, bg: null as number | null, bold: false };
  let text = "";
  const flush = () => {
    if (!text) return;
    const last = spans[spans.length - 1];
    if (last && last.fg === st.fg && last.bg === st.bg && last.bold === st.bold) last.text += text;
    else spans.push({ text, fg: st.fg, bg: st.bg, bold: st.bold });
    text = "";
  };

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c !== ESC) { text += input[i]; continue; }
    // ESC — only handle CSI ('[') sequences; drop a bare ESC or other introducers
    if (input[i + 1] !== "[") { continue; }
    let j = i + 2;
    while (j < input.length && input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x3f) j++; // params
    const final = input[j];                       // the command byte (e.g. 'm')
    const body = input.slice(i + 2, j);
    if (final === "m") { flush(); applySgr(body.split(";").filter((x) => x !== "").map(Number), st); }
    // else: cursor/clear/etc. — consumed + dropped
    i = j; // skip the whole sequence (i++ then lands past `final`)
  }
  flush();
  return spans;
}

/** Strip ANSI entirely (for logging / plain copies). */
export function stripAnsi(input: string): string {
  return parseAnsi(input).map((s) => s.text).join("");
}
