// SPDX-License-Identifier: MIT
/* global register, tool */
// Tool API 1.0 contract fixture: a tool that uses every 1.0 feature. Every later 1.x release must keep
// tools/e2e/tool-sandbox.mjs green against this file unchanged; a change that breaks it is a new major.
tool.on("on_frame", (p) =>
  tool.setPanel({ title: "Heard", nodes: [{ kind: "text", text: p.peerCall + " " + (p.text || "") }] }),
);
const sessions = [];
let lastRtt = "none";
tool.on("on_connect", (p) => {
  sessions.push(["connect", p.surface, p.channel, p.peerCall, p.myCall, p.direction, typeof p.reply].join(" "));
  if (p.reply) p.reply("Welcome " + p.peerCall);
});
tool.on("on_disconnect", (p) => sessions.push(["disconnect", p.channel, p.peerCall, typeof p.reply].join(" ")));
tool.subscribe("link.rtt", (d, from) => (lastRtt = d.ms + " " + from));
tool.provide("echo.upper", async (a) => String(a).toUpperCase());
register({
  colourRules: [{ srcPrefix: "DL", colorVar: "--st-user" }],
  panel: { title: "Contract", nodes: [{ kind: "text", text: "loaded" }] },
  decoders: [
    {
      id: "upper",
      label: "Upper",
      kind: "text",
      sample: "abc",
      placeholder: "text",
      decode: async (s) => String(s).toUpperCase(),
    },
  ],
  commands: {
    meta: () => [JSON.stringify(tool.api), String(tool.has("tx")), String(tool.has("no-such-feature"))],
    later: async (a) => {
      await new Promise((r) => setTimeout(r, 20));
      return ["later " + a];
    },
    tx: async () => [String(await tool.requestTx(">from a tool"))],
    beacon: async () => {
      try {
        return [String(await tool.scheduleBeacon({ comment: "QRV", intervalSec: 60 }))];
      } catch (e) {
        return ["refused: " + e.message];
      }
    },
    wp: () => {
      tool.setMapLayer({ id: "wp", points: [{ lat: 47, lon: 15, label: "home" }] });
      return ["ok"];
    },
    colours: () => {
      tool.setColourRules([{ src: "OE8APR", colorVar: "--warn" }]);
      return ["ok"];
    },
    ask: async () => [String(await tool.call("echo.upper", "abc"))],
    op: () => ["operator only"],
    ping: { run: () => ["pong"], remote: true },
    sessions: () => sessions.slice(),
    rtt: () => [lastRtt],
    pingreq: () => {
      tool.emit("link.ping.request", {});
      tool.emit("link.rtt", { ms: -1 }); // the app's alone: refused
      return ["requested"];
    },
  },
});
