// SPDX-License-Identifier: AGPL-3.0-or-later
// The self-host boot resolves SESSION_SECRET: an operator-set value wins (and must be strong and its own),
// otherwise one is generated once and kept beside the database, so a single box signs users in without
// any setup and keeps their sessions across restarts. The desktop app resolves all three secrets the
// same way, so it never runs on a public default.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSessionSecret, resolveInstanceSecrets } from "../src/secrets.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "acs-secrets-"));

describe("resolveSessionSecret", () => {
  it("uses a strong SESSION_SECRET from the environment and writes nothing", () => {
    const dir = tmp();
    const r = resolveSessionSecret({ SESSION_SECRET: "an-operator-chosen-secret", INGEST_SECRET: "ingest" }, dir);
    expect(r).toEqual({ ok: true, secret: "an-operator-chosen-secret", source: "env" });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a weak SESSION_SECRET or one shared with a machine secret", () => {
    const dir = tmp();
    expect(resolveSessionSecret({ SESSION_SECRET: "change-me" }, dir).ok).toBe(false);
    expect(resolveSessionSecret({ SESSION_SECRET: "same-value-1234", INGEST_SECRET: "same-value-1234" }, dir).ok).toBe(
      false,
    );
    expect(
      resolveSessionSecret({ SESSION_SECRET: "same-value-1234", OPERATOR_SECRET: "same-value-1234" }, dir).ok,
    ).toBe(false);
  });

  it("generates one beside the database when unset, owner-only, and reuses it", () => {
    const dir = tmp();
    const first = resolveSessionSecret({ INGEST_SECRET: "ingest" }, dir);
    expect(first.ok && first.source).toBe("generated");
    const file = path.join(dir, "session.secret");
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0);
    const again = resolveSessionSecret({ INGEST_SECRET: "ingest" }, dir);
    expect(again).toEqual({ ok: true, secret: first.ok ? first.secret : "", source: "file" });
    expect(first.ok && first.secret.length).toBeGreaterThanOrEqual(43);
  });
});

describe("resolveInstanceSecrets (the desktop app)", () => {
  it("generates distinct ingest, operator and session secrets on first run and keeps them", () => {
    const dir = tmp();
    const first = resolveInstanceSecrets({}, dir);
    if (!first.ok) throw new Error(first.error);
    const { INGEST_SECRET, OPERATOR_SECRET, SESSION_SECRET } = first.secrets;
    expect(new Set([INGEST_SECRET, OPERATOR_SECRET, SESSION_SECRET]).size).toBe(3);
    for (const v of [INGEST_SECRET, OPERATOR_SECRET, SESSION_SECRET]) expect(v.length).toBeGreaterThanOrEqual(43);
    expect(fs.readdirSync(dir).sort()).toEqual(["ingest.secret", "operator.secret", "session.secret"]);
    const again = resolveInstanceSecrets({}, dir);
    expect(again.ok && again.secrets).toEqual(first.secrets);
  });

  it("an operator-set value wins, and a public default is refused", () => {
    const dir = tmp();
    const set = resolveInstanceSecrets({ INGEST_SECRET: "my-own-ingest-secret" }, dir);
    expect(set.ok && set.secrets.INGEST_SECRET).toBe("my-own-ingest-secret");
    expect(resolveInstanceSecrets({ INGEST_SECRET: "change-me" }, tmp()).ok).toBe(false);
  });
});

describe("the Bun runtime resolves secrets with the same code", () => {
  it("servers/bun imports servers/node/src/secrets.ts rather than keeping a copy", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const bun = path.join(here, "../../bun");
    expect(fs.existsSync(path.join(bun, "secrets.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(bun, "server.ts"), "utf8")).toContain('from "../node/src/secrets.ts"');
  });
});
