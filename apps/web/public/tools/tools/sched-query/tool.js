// SPDX-License-Identifier: MIT
// Scheduled query (GPAUTO) 1.0.1, built by scripts/build.mjs from tools/sched-query/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // vendor/aprscaching/packages/tools/src/session-script.ts
  function splitTimeout(rest) {
    let i = rest.length;
    while (i > 0 && /\d/.test(rest[i - 1])) i--;
    const digitsStart = i;
    while (i > 0 && /\s/.test(rest[i - 1])) i--;
    const hasTimeout = digitsStart < rest.length && i < digitsStart;
    const text = hasTimeout ? rest.slice(0, i) : rest;
    if (/[\n\r\u2028\u2029]/.test(text)) return { text: rest.trim() };
    return { text: text.trim(), timeoutSec: hasTimeout ? Number(rest.slice(digitsStart)) : void 0 };
  }
  function parseScript(text) {
    const steps = [];
    for (const raw of String(text).split(/[\n;]/)) {
      const line = raw.trim().replace(/^\*\*\*/, "").trim();
      if (!line || line.startsWith("#") || /^rem\b/i.test(line)) continue;
      const sp = line.indexOf(" ");
      const op = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
      if (op === "connect" && rest) steps.push({ op: "connect", call: rest.toUpperCase() });
      else if (op === "send") steps.push({ op: "send", text: rest });
      else if (op === "waitfor" && rest) {
        const { text: text2, timeoutSec } = splitTimeout(rest);
        steps.push({ op: "waitfor", text: text2, timeoutSec });
      } else if (op === "wait") steps.push({ op: "wait", sec: Math.max(0, Number(rest) || 0) });
      else if (op === "disconnect" || op === "bye") steps.push({ op: "disconnect" });
    }
    return steps;
  }

  // tools/sched-query/src/index.js
  var MIN_MINUTES = 10;
  var NO_STEPS = "No steps. e.g. /gpauto connect HB9W-8; waitfor Cluster; send sh/dx; disconnect";
  var script = "";
  var everyMin = 0;
  var ticks = 0;
  async function runOnce(text) {
    const steps = parseScript(text);
    if (!steps.length) return NO_STEPS;
    let ok;
    try {
      ok = await tool.call("session.script", { steps });
    } catch (e) {
      return `Refused: ${e.message}`;
    }
    return ok ? `Running ${steps.length} steps…` : "Open the packet TNC first (no session service).";
  }
  function render(st) {
    tool.setPanel({
      title: "Scheduled query",
      nodes: st ? [
        {
          kind: "kv",
          key: "Status",
          value: `${st.status} (${st.step}/${st.total})`,
          tone: st.status === "error" ? "bad" : st.status === "done" ? "ok" : "accent"
        },
        ...st.note ? [{ kind: "text", text: st.note, tone: "muted" }] : [],
        ...(Array.isArray(st.captured) ? st.captured : []).slice(-10).map((l) => ({ kind: "text", text: String(l) }))
      ] : [{ kind: "text", text: "Idle. /gpauto <steps>  or  /gpauto every <min> <steps>.", tone: "muted" }]
    });
  }
  tool.subscribe("session.progress", (data) => render(data && typeof data === "object" ? data : void 0));
  register({
    commands: {
      gpauto: async (args) => {
        const a = args.trim();
        if (!a)
          return [
            script ? `Script set (${parseScript(script).length} steps). /gpauto run` : "No script. /gpauto <steps> or /gpauto every <min> <steps>"
          ];
        if (a.toLowerCase() === "off") {
          everyMin = 0;
          return ["Scheduled query off."];
        }
        const every = a.match(/^every\s+(\d+)\s+([\s\S]+)$/i);
        if (every) {
          if (!parseScript(every[2]).length) return [NO_STEPS];
          everyMin = Math.max(MIN_MINUTES, Number(every[1]));
          script = every[2];
          ticks = 0;
          return [`Scheduled every ${everyMin} min. ${await runOnce(script)}`];
        }
        if (a.toLowerCase() === "run")
          return [script ? await runOnce(script) : "No stored script — /gpauto <steps> first."];
        script = a;
        return [await runOnce(a)];
      }
    }
  });
  tool.on("on_tick", async () => {
    if (everyMin <= 0 || !script) return;
    ticks++;
    if (ticks < everyMin) return;
    ticks = 0;
    tool.log(`scheduled run: ${await runOnce(script)}`);
  });
  render();
})();
