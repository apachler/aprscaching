/**
 * The source link's commit from a checkout the service user does not own: bare metal's checkout is root's, and
 * git refuses a repository owned by another user unless it is named safe. GIT_TEST_ASSUME_DIFFERENT_OWNER makes
 * git treat the test's own repository as another user's. The machine's system and global git config are shut out,
 * as a root-owned install with no safe.directory has them: a CI runner's config names its checkouts safe, which
 * would let git read the repository whatever its owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHead } from "../src/host.js";

const ISOLATION = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } as const;
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
beforeEach(() => {
  for (const [k, v] of Object.entries(ISOLATION)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  for (const k of Object.keys(ISOLATION)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "githead-"));
  dirs.push(dir);
  const git = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  git("init --quiet");
  git("-c user.name=t -c user.email=t@example.org -c commit.gpgsign=false commit --quiet --allow-empty -m one");
  return { dir, head: git("rev-parse HEAD").toString().trim() };
}

describe("gitHead", () => {
  it("names the commit of a checkout the service owns", () => {
    const { dir, head } = repo();
    expect(gitHead(dir)).toBe(head);
  });

  it("names the commit of a checkout another user owns", () => {
    const { dir, head } = repo();
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    expect(execSync("git rev-parse HEAD 2>&1 || true", { cwd: dir }).toString()).toContain("dubious ownership");
    expect(gitHead(dir)).toBe(head);
  });

  it("names nothing outside a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "githead-none-"));
    dirs.push(dir);
    expect(gitHead(dir)).toBeUndefined();
  });
});
