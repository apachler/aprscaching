// SPDX-License-Identifier: AGPL-3.0-or-later
// deploy/setup.sh in its non-interactive mode: one run writes everything a working Docker instance needs,
// and a re-run never changes a value (least of all a secret) without being told to. In its interactive mode, on a
// terminal: the Cloudflare Tunnel token is read without echo and its current value is never shown.
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../deploy/setup.sh");
let envFile = "";

const run = (...args: string[]) =>
  execFileSync("bash", [SETUP, "--non-interactive", "--no-network", "--env-file", envFile, ...args], {
    encoding: "utf8",
  });
const runWith = (environment: Record<string, string>, ...args: string[]) =>
  execFileSync("bash", [SETUP, "--non-interactive", "--no-network", "--env-file", envFile, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });

// Runs setup.sh on a pseudo-terminal, as an operator does, and answers each prompt with the reply of the first
// [pattern, reply] rule whose pattern the prompt matches (a blank answer otherwise). Returns everything the terminal
// showed, the typed answers included as far as the terminal echoed them.
const PTY_DRIVER = String.raw`
import json, os, pty, re, select, sys, time
setup, rules, args = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp("bash", ["bash", setup, *args])
out, pending, deadline = b"", b"", time.monotonic() + 50
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.4)
    if ready:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out += data
        pending += data
        continue
    tail = pending.rsplit(b"\n", 1)[-1].decode(errors="replace")
    if tail.rstrip().endswith((":", "]")):
        os.write(fd, (next((r for p, r in rules if re.search(p, tail)), "") + "\n").encode())
        pending = b""
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
const onTerminal = (rules: [string, string][], ...args: string[]) =>
  execFileSync(
    "python3",
    ["-c", PTY_DRIVER, SETUP, JSON.stringify(rules), "--no-network", "--env-file", envFile, ...args],
    { encoding: "utf8", env: { ...process.env, TUNNEL_TOKEN: "" } },
  );
const env = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
};
const activeLines = (key: string) =>
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`)).length;

beforeEach(() => {
  envFile = path.join(mkdtempSync(path.join(tmpdir(), "setup-")), ".env");
});

// Each test runs the bash script, which shells out to node for the secrets: seconds on a loaded machine.
describe("deploy/setup.sh --non-interactive", { timeout: 60_000 }, () => {
  it("writes the operator, public URL, feed, site call and generated secrets for a public domain", () => {
    const out = run(
      "--call",
      "oe8apr",
      "--passcode",
      "12345",
      "--filter",
      "r/47/15/100",
      "--domain",
      "aprs.example.net",
      "--site-call",
      "OE8APR-10",
    );
    const e = env();
    expect(e.ADMIN_CALLSIGNS).toBe("OE8APR");
    expect(e.APRSIS_CALLSIGN).toBe("OE8APR");
    expect(e.APRSIS_PASSCODE).toBe("12345");
    expect(e.APRSIS_FILTER).toBe("r/47/15/100");
    expect(e.DOMAIN).toBe("aprs.example.net");
    expect(e.APP_URL).toBe("https://aprs.example.net");
    expect(e.RF_SITE_CALL).toBe("OE8APR-10");
    expect(e.FIRST_PARTY_SITES).toBe("OE8APR-10");
    expect(e.INGEST_SECRET).toMatch(/^[0-9a-f]{48}$/);
    expect(e.OPERATOR_SECRET).toMatch(/^[0-9a-f]{48}$/);
    expect(e.OPERATOR_SECRET).not.toBe(e.INGEST_SECRET);
    const key = JSON.parse(Buffer.from(e.FED_PRIVATE_KEY!, "base64").toString()) as { pkcs8: string; pub: string };
    expect(key.pkcs8 && key.pub).toBeTruthy();
    // the commented template lines were filled in place, not duplicated
    for (const k of ["ADMIN_CALLSIGNS", "APP_URL", "FIRST_PARTY_SITES", "RF_SITE_CALL"]) expect(activeLines(k)).toBe(1);
    // the next steps name the published health URL and the operator commands
    expect(out).toContain("curl -fsS https://aprs.example.net/health");
    expect(out).not.toContain(":8080");
    expect(out).toContain("docker compose exec gateway node tools/admin/verify-call.mjs OE8APR");
  });

  it("an off-grid LAN box gets a plain-http APP_URL, Caddy on :80 and the sign-in link command", () => {
    const out = run("--call", "OE8APR", "--lan-host", "192.168.1.10");
    const e = env();
    expect(e.DOMAIN).toBe(":80");
    expect(e.APP_URL).toBe("http://192.168.1.10");
    expect(e.RF_SITE_CALL).toBeUndefined();
    expect(out).toContain("curl -fsS http://192.168.1.10/health");
    expect(out).toContain("docker compose exec gateway node tools/admin/signin-link.mjs OE8APR");
  });

  it("a Cloudflare Tunnel keeps Caddy on :80 behind an https APP_URL and starts with the home override", () => {
    const out = runWith({ TUNNEL_TOKEN: "eyJtoken" }, "--call", "OE8APR", "--domain", "aprs.example.net");
    const e = env();
    expect(e.DOMAIN).toBe(":80");
    expect(e.APP_URL).toBe("https://aprs.example.net");
    expect(e.TUNNEL_TOKEN).toBe("eyJtoken");
    expect(out).toContain("compose.home.yml");
  });

  it("is idempotent: a re-run keeps every secret and every value it is not told to replace", () => {
    run("--call", "OE8APR", "--domain", "aprs.example.net", "--site-call", "OE8APR-10");
    const first = env();
    const out = run("--call", "OE8XYZ", "--domain", "other.example.net", "--site-call", "OE8XYZ-10");
    const second = env();
    for (const k of [
      "INGEST_SECRET",
      "OPERATOR_SECRET",
      "FED_PRIVATE_KEY",
      "ADMIN_CALLSIGNS",
      "APP_URL",
      "DOMAIN",
      "RF_SITE_CALL",
    ])
      expect(second[k]).toBe(first[k]);
    expect(out).toContain("kept ADMIN_CALLSIGNS");
    // --yes replaces the plain values; secrets are still never regenerated
    run("--call", "OE8XYZ", "--domain", "other.example.net", "--yes");
    const third = env();
    expect(third.ADMIN_CALLSIGNS).toBe("OE8XYZ");
    expect(third.APP_URL).toBe("https://other.example.net");
    expect(third.DOMAIN).toBe("other.example.net");
    expect(third.INGEST_SECRET).toBe(first.INGEST_SECRET);
    expect(third.OPERATOR_SECRET).toBe(first.OPERATOR_SECRET);
  });

  it("replacing the operator keeps further admin calls, and a new site keeps the other listed sites", () => {
    writeFileSync(
      envFile,
      "ADMIN_CALLSIGNS=OE8APR,OE8ABC\nRF_SITE_CALL=OE8APR-10\nFIRST_PARTY_SITES=OE8APR-10,OE8APR-12\n",
    );
    run("--call", "OE8XYZ", "--domain", "aprs.example.net", "--site-call", "OE8XYZ-10", "--yes");
    const e = env();
    expect(e.ADMIN_CALLSIGNS).toBe("OE8XYZ,OE8ABC");
    expect(e.RF_SITE_CALL).toBe("OE8XYZ-10");
    expect(e.FIRST_PARTY_SITES).toBe("OE8XYZ-10,OE8APR-12");
  });

  it("keeps values an operator wrote by hand before the first run", () => {
    writeFileSync(envFile, "INGEST_SECRET=my-own-ingest-secret\nAPP_URL=https://hand.example.net\n");
    run("--call", "OE8APR", "--domain", "aprs.example.net");
    const e = env();
    expect(e.INGEST_SECRET).toBe("my-own-ingest-secret");
    expect(e.APP_URL).toBe("https://hand.example.net");
    expect(e.ADMIN_CALLSIGNS).toBe("OE8APR");
  });

  it("refuses to run without a callsign", () => {
    expect(() => run("--domain", "aprs.example.net")).toThrow();
  });

  it("refuses the tunnel token on the command line, where ps and the shell history show it", () => {
    expect(() => run("--call", "OE8APR", "--domain", "aprs.example.net", "--tunnel-token", "eyJargv")).toThrow(
      /TUNNEL_TOKEN in the environment/,
    );
    expect(readFileSync(envFile, { encoding: "utf8", flag: "a+" })).not.toContain("eyJargv");
  });
});

describe("deploy/setup.sh on a terminal", { timeout: 120_000 }, () => {
  const TUNNEL: [string, string] = ["Choose 1-3 \\[1\\]", "2"];
  const HOST: [string, string] = ["Public hostname", "aprs.example.net"];

  it("reads the tunnel token without echo", () => {
    const shown = onTerminal([TUNNEL, HOST, ["Cloudflare Tunnel token", "eyJtyped"]], "--call", "OE8APR");
    expect(shown).toContain("Cloudflare Tunnel token");
    expect(shown).toContain("Public hostname (e.g. aprs.example.net): aprs.example.net");
    expect(shown).not.toContain("eyJtyped");
    expect(env().TUNNEL_TOKEN).toBe("eyJtyped");
    expect(env().DOMAIN).toBe(":80");
  });

  it("never shows the current token, and a blank answer keeps it", () => {
    writeFileSync(envFile, "ADMIN_CALLSIGNS=OE8APR\nAPP_URL=https://aprs.example.net\nTUNNEL_TOKEN=eyJcurrent\n");
    const shown = onTerminal([TUNNEL]);
    expect(shown).not.toContain("eyJcurrent");
    expect(shown).toContain("Cloudflare Tunnel token (blank = keep the current one): ");
    expect(env().TUNNEL_TOKEN).toBe("eyJcurrent");
  });

  it("replaces the current token only when told to, without showing either", () => {
    writeFileSync(envFile, "ADMIN_CALLSIGNS=OE8APR\nAPP_URL=https://aprs.example.net\nTUNNEL_TOKEN=eyJcurrent\n");
    const shown = onTerminal([TUNNEL, ["Cloudflare Tunnel token", "eyJnew"], ["TUNNEL_TOKEN is already set", "y"]]);
    expect(shown).toContain("TUNNEL_TOKEN is already set (value hidden)");
    expect(shown).not.toMatch(/eyJcurrent|eyJnew/);
    expect(env().TUNNEL_TOKEN).toBe("eyJnew");
  });
});
