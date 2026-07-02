// SPDX-License-Identifier: AGPL-3.0-or-later
// Example imported tool (docs/design/28 §7) — demonstrates the full contribution set across the Worker bridge:
// a command, a declarative colour rule, an initial panel, and a decoder. Runs sandboxed; no host access.
register({
  commands: {
    hello: (args) => [`Hello ${args || "world"} from the imported hello-tool!`],
  },
  colourRules: [
    { srcPrefix: "OE", colorVar: "--st-user" },   // tint OE-prefixed stations in the monitor
  ],
  panel: {
    title: "Hello tool",
    nodes: [
      { kind: "text", text: "An imported, signed tool running in a Worker sandbox.", tone: "muted" },
      { kind: "badge", text: "sandboxed", tone: "ok" },
    ],
  },
  decoders: [
    { id: "rot13", label: "ROT13", kind: "text", decode: (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)) },
  ],
});
