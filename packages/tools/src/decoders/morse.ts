/**
 * morse.ts — a pure CW (Morse) decoder (docs/26 F-5). Two layers: `decodeMorse` maps dot/dash tokens
 * to text, and `morseFromTiming` turns a keyed on/off envelope (the front-end a Web Audio tone
 * detector produces) into those tokens by classifying element/gap lengths against an estimated unit.
 * Both pure + unit-tested; the audio tone detection itself is browser-side (validate-at-deploy).
 */
const MORSE: Record<string, string> = {
  A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..",
  J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.",
  S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....",
  "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "=": "-...-", "-": "-....-",
  ":": "---...", "'": ".----.", "@": ".--.-.", "(": "-.--.", ")": "-.--.-",
};
const REV: Record<string, string> = Object.fromEntries(Object.entries(MORSE).map(([c, m]) => [m, c]));

/** Decode "…. . .-.. .-.. ---" (letters space-separated, words by " / " or a double space) → text. */
export function decodeMorse(input: string): string {
  return input.trim().split(/\s*\/\s*|\s{2,}/).map((word) =>
    word.trim().split(/\s+/).filter(Boolean).map((t) => REV[t] ?? "").join("")
  ).join(" ").trim();
}

/** Encode text → Morse tokens (letters space-separated, words by " / "). For tests + a sender tool. */
export function encodeMorse(text: string): string {
  return text.toUpperCase().split(/\s+/).filter(Boolean).map((word) =>
    [...word].map((c) => MORSE[c] ?? "").filter(Boolean).join(" ")
  ).join(" / ");
}

export interface KeyEvent { on: boolean; ms: number }

/**
 * Classify a keyed on/off envelope into Morse. `unit` (ms per dot) is estimated from the shortest ON
 * if not given. Thresholds: ON < 2u = dot else dash; OFF < 2u = intra-char, < 5u = letter gap, else
 * word gap. Robust enough for a clean tone; noisy/QSB signals are the browser DSP's problem.
 */
export function morseFromTiming(events: KeyEvent[], unit?: number): string {
  const ons = events.filter((e) => e.on).map((e) => e.ms);
  if (ons.length === 0) return "";
  const u = unit ?? Math.min(...ons);
  let out = "";
  for (const e of events) {
    if (e.on) out += e.ms < u * 2 ? "." : "-";
    else out += e.ms < u * 2 ? "" : e.ms < u * 5 ? " " : " / ";
  }
  return out.replace(/\s+/g, (m) => (m.includes("/") ? " / " : " ")).trim();
}
