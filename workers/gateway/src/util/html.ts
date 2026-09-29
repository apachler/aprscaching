// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one escape for markup the gateway builds from data — HTML pages, SVG and XML documents alike.
 * It covers text and quoted-attribute contexts: `&`, `<`, `>`, `"` and `'` all become character
 * references, so an interpolated value can neither open a tag nor close the attribute it sits in.
 * `&#39;` (not `&apos;`) keeps the output valid HTML 4 as well as XML.
 */
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** A '<' followed by one of these opens a tag, an end tag, a comment or a processing instruction. */
const TAG_START = /[A-Za-z/!?]/;

/**
 * Plain text from user input: every complete `<…>` span is removed, and a '<' with no closing '>'
 * after it is dropped when it could still open a tag (so `<3` survives but `<script` cannot). One
 * left-to-right pass; the result holds no tag opener, so no second pass can uncover one.
 */
export function stripTags(s: string): string {
  let out = "";
  let noCloseAfter = -1; // once no '>' follows some index, none follows any later one
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "<") {
      out += c;
      continue;
    }
    if (noCloseAfter < 0) {
      const close = s.indexOf(">", i + 1);
      if (close >= 0) {
        i = close;
        continue;
      }
      noCloseAfter = i;
    }
    const next = s[i + 1];
    if (next !== undefined && (next === "<" || TAG_START.test(next))) continue;
    out += c;
  }
  return out;
}
