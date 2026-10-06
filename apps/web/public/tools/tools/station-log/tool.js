// SPDX-License-Identifier: MIT
/* global register, ipc */
// Station log: an example imported tool. The sandbox runs this file as the body of a function whose two
// parameters are `register` and `ipc`; `ipc` is undefined unless the user granted the 'ipc' permission.
// It lists the stations the built-in Station DB tool announces on the bus, and answers /seen and /whois.

const MAX = 10;
const seen = []; // newest first: { call, type, source }

function panel(extra = []) {
  return {
    title: "Station log",
    nodes: [
      ...extra,
      ...(seen.length
        ? [
            { kind: "kv", key: "Stations", value: String(seen.length) },
            {
              kind: "table",
              head: ["Call", "Type", "Via"],
              rows: seen.map((s) => [s.call, s.type || "-", s.source || "-"]),
            },
          ]
        : [{ kind: "text", text: "No stations yet. Enable Station DB and turn on live stations.", tone: "muted" }]),
    ],
  };
}

if (ipc) {
  // Station DB emits { call, type, source } for every station it hears.
  ipc.subscribe("station.seen", (data) => {
    const call = data && typeof data.call === "string" ? data.call : "";
    if (!call) return;
    const i = seen.findIndex((s) => s.call === call);
    if (i >= 0) seen.splice(i, 1);
    seen.unshift({ call, type: String(data.type || ""), source: String(data.source || "") });
    if (seen.length > MAX) seen.length = MAX;
    ipc.setPanel(panel());
  });
}

register({
  commands: {
    seen: () =>
      seen.length ? seen.map((s) => `${s.call}  ${s.type || "-"}  ${s.source || "-"}`) : ["No stations heard yet."],
    whois: (args) => {
      const call = args.trim().toUpperCase();
      if (!call) return ["Usage: /whois <callsign>"];
      if (!ipc) return ["Station log needs the ipc permission to ask Station DB."];
      // A command answers at once; the service's answer arrives later, so it goes to the panel.
      ipc.call("station.type", call).then((type) => {
        const known = typeof type === "string" && type !== "";
        ipc.setPanel(
          panel([{ kind: "kv", key: call, value: known ? type : "not heard", tone: known ? "ok" : "muted" }]),
        );
      });
      return [`Asked Station DB about ${call}; the answer shows in the panel.`];
    },
  },
  panel: panel(),
});
