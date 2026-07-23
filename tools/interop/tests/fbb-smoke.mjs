// SPDX-License-Identifier: AGPL-3.0-or-later
// F6FBB smoke: the real xfbbd answers its telnet port with the FBB banner and rejects an
// unregistered callsign (the registration gate) — proving the reference implementation is up and
// reachable before deeper forwarding drivers run. See tools/interop/README for the registration
// runbook (sysop console) that the full forwarding driver builds on.
import net from "node:net";

const HOST = process.env.FBB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.FBB_PORT ?? 6300);
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};

const banner = await new Promise((resolve) => {
  const s = net.connect(PORT, HOST);
  let out = "";
  s.on("data", (b) => {
    out += b.toString("latin1");
  });
  s.on("connect", () => setTimeout(() => s.write("OE1ACS\r"), 1000));
  s.on("error", () => resolve(out));
  setTimeout(() => {
    s.destroy();
    resolve(out);
  }, 6000);
});

ok(
  "FBB telnet answers with its banner",
  /BBS/.test(banner) && /Callsign/i.test(banner),
  JSON.stringify(banner.slice(0, 120)),
);
ok(
  "unregistered callsign is gated (registration required)",
  /Unregistered/i.test(banner),
  JSON.stringify(banner.slice(0, 200)),
);

console.log(failures ? `\nFBB SMOKE FAILED (${failures})` : "\nFBB SMOKE PASSED");
process.exit(failures ? 1 : 0);
