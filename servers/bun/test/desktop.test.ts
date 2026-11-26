// SPDX-License-Identifier: AGPL-3.0-or-later
// The desktop launcher (deploy/desktop/launcher.ts, run from source as `bun run launcher.ts` does in dev) keeps its
// data directory, which holds the database and the secrets, to its own user: a new one is created 0700 and an
// existing one is tightened to 0700, so other local users cannot read the database SQLite creates with the umask.
// Run with `bun test servers/bun/test` (the CI Bun conformance).
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "../../../deploy/desktop/launcher.ts");
const roots: string[] = [];
const running: Bun.Subprocess[] = [];
afterAll(() => {
  for (const p of running) p.kill();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = netServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Starts the launcher on DATA_DIR and waits for /health; throws with its stderr should it exit instead. */
async function launch(dataDir: string): Promise<void> {
  const port = await freePort();
  const proc = Bun.spawn([process.execPath, LAUNCHER], {
    // no PATH: the launcher finds no browser to open, and needs nothing else from it
    env: {
      HOME: dirname(dataDir),
      DATA_DIR: dataDir,
      PORT: String(port),
      APP_URL: `http://127.0.0.1:${port}`,
      UPDATE_CHECK: "0",
      DEVICEID_URL: "",
      FED_SYNC_INTERVAL_MS: "0",
      FED_RELAY_POLL_MS: "0",
      FED_MDNS: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(proc);
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null)
      throw new Error(`the launcher exited (${proc.exitCode}): ${await new Response(proc.stderr).text()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  throw new Error("the launcher did not answer /health");
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("the desktop data directory", () => {
  it("is created owner-only, and holds the database and the secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-desktop-"));
    roots.push(root);
    const dir = join(root, "share", "aprscaching");
    await launch(dir);
    expect(mode(dir).toString(8)).toBe("700");
    expect(existsSync(join(dir, "aprscaching.db"))).toBe(true);
    expect(existsSync(join(dir, "session.secret"))).toBe(true);
  }, 60_000);

  it("is tightened to owner-only when it exists readable by others", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-desktop-"));
    roots.push(root);
    const dir = join(root, "aprscaching");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    await launch(dir);
    expect(mode(dir).toString(8)).toBe("700");
  }, 60_000);
});
