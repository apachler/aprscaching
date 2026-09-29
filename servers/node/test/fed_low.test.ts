// SPDX-License-Identifier: AGPL-3.0-or-later
// The low-severity federation items: a signed ingest batch works once, erasing an account also erases
// its mirrored key bindings and moves, a mirrored account move needs the mover's signed proof, and
// standalone JSON signatures carry a domain prefix.
import { describe, it, expect, afterEach, vi } from "vitest";
import { accountActionMessage, ingestMessage, sha256Hex, stableStringify, SIG_DOMAIN } from "@aprscaching/shared";
import { verifySignedIngest } from "@aprscaching/gateway/keys";
import { verifyRotationRecord, verifyRegistry } from "@aprscaching/gateway/federation";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { newFedKey, instanceEnv, serve, stubFetch, type FedKey } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const nowS = () => Math.floor(Date.now() / 1000);
const b64u = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64url");
const sign = async (k: FedKey, text: string) =>
  b64u(await crypto.subtle.sign("Ed25519", k.priv, new TextEncoder().encode(text)));

async function registerKey(env: Env, callsign: string, key: FedKey) {
  await env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, created_at) VALUES (?, ?, ?)")
    .bind(callsign, key.pub, nowS())
    .run();
}

describe("signed ingest", () => {
  it("accepts a signed batch once and refuses its replay", async () => {
    const env = instanceEnv("a.example", await newFedKey());
    const dev = await newFedKey();
    await registerKey(env, "OE8BRW", dev);
    const packets = [{ raw: "OE8BRW>APRS:!4704.00N/01526.00E-" }];
    const at = nowS();
    const digest = await sha256Hex(stableStringify(packets));
    const sig = await sign(dev, SIG_DOMAIN.ingest + ingestMessage({ callsign: "OE8BRW", at, count: 1, digest }));
    const req = () =>
      new Request("https://a.example/ingest", {
        method: "POST",
        headers: { "x-acs-callsign": "OE8BRW", "x-acs-key": dev.pub, "x-acs-sig": sig, "x-acs-at": String(at) },
      });
    expect(await verifySignedIngest(req(), env, packets)).toEqual({ callsign: "OE8BRW" });
    expect(await verifySignedIngest(req(), env, packets)).toBeNull();
  });

  it("refuses a batch signed without the ingest domain prefix", async () => {
    const env = instanceEnv("a.example", await newFedKey());
    const dev = await newFedKey();
    await registerKey(env, "OE8BRW", dev);
    const packets = [{ raw: "OE8BRW>APRS:!4704.00N/01526.00E-" }];
    const at = nowS();
    const digest = await sha256Hex(stableStringify(packets));
    const sig = await sign(dev, ingestMessage({ callsign: "OE8BRW", at, count: 1, digest }));
    const req = new Request("https://a.example/ingest", {
      method: "POST",
      headers: { "x-acs-callsign": "OE8BRW", "x-acs-key": dev.pub, "x-acs-sig": sig, "x-acs-at": String(at) },
    });
    expect(await verifySignedIngest(req, env, packets)).toBeNull();
  });
});

describe("domain-separated standalone signatures", () => {
  it("verifies a prefixed rotation and registry, and refuses the unprefixed form", async () => {
    const a = await newFedKey();
    const b = await newFedKey();
    const at = nowS();
    const body = stableStringify({ key: b.pub, prevKey: a.pub, at });
    expect(
      await verifyRotationRecord({ key: b.pub, prevKey: a.pub, at, sig: await sign(a, SIG_DOMAIN.rotation + body) }),
    ).toBe(true);
    expect(await verifyRotationRecord({ key: b.pub, prevKey: a.pub, at, sig: await sign(a, body) })).toBe(false);
    const entries = [{ instance: "x.example", key: "K" }];
    const reg = stableStringify({ at, entries });
    expect(await verifyRegistry({ entries, at, sig: await sign(a, SIG_DOMAIN.registry + reg) }, a.pub)).toBe(true);
    expect(await verifyRegistry({ entries, at, sig: await sign(a, reg) }, a.pub)).toBe(false);
    // a signature made for one purpose never verifies for another
    expect(await verifyRegistry({ entries, at, sig: await sign(a, SIG_DOMAIN.rotation + reg) }, a.pub)).toBe(false);
  });
});

describe("account moves and erasure across the network", () => {
  const A = "https://a.example";

  async function world() {
    const aKey = await newFedKey();
    const a = instanceEnv("a.example", aKey);
    const hub = instanceEnv("hub.example", await newFedKey());
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, 'a.example', ?, ?, 'trusted', 'manual')",
    )
      .bind(A, aKey.pub, JSON.stringify([{ x: aKey.pub }]))
      .run();
    stubFetch({ [A]: serve(a) });
    return { a, hub };
  }

  async function importMove(a: Env, dev: FedKey, proofKey: FedKey = dev) {
    const at = nowS();
    const sig = await sign(
      proofKey,
      accountActionMessage({ action: "migrate", callsign: "OE7MOV", instance: "a.example", at }),
    );
    return serve(a)(
      new Request("https://a.example/api/account/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: { v: 1, instance: "oe.origin", callsign: "OE7MOV", keys: [{ publicKey: dev.pub }], at },
          assertion: { key: proofKey.pub, sig, at },
        }),
      }),
    );
  }
  const moves = (hub: Env) =>
    hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_account_moves WHERE callsign = 'OE7MOV'").first<{ n: number }>();

  it("mirrors a move whose signed proof verifies under a key the mirror knows independently", async () => {
    const { a, hub } = await world();
    const dev = await newFedKey();
    await registerKey(hub, "OE7MOV", dev); // the mirror knows this key for the callsign on its own
    expect((await importMove(a, dev)).status).toBe(200);
    await syncAllPeers(hub);
    expect((await moves(hub))?.n).toBe(1);
  });

  it("does not mirror a move whose only key comes from the instance claiming the move", async () => {
    const { a, hub } = await world();
    const dev = await newFedKey();
    expect((await importMove(a, dev)).status).toBe(200);
    await syncAllPeers(hub);
    expect((await moves(hub))?.n).toBe(0);
  });

  it("does not mirror a move served without a proof", async () => {
    const { a, hub } = await world();
    const dev = await newFedKey();
    await registerKey(hub, "OE7MOV", dev);
    await a.DB.prepare(
      "INSERT INTO account_moves (callsign, from_instance, to_instance, ts) VALUES ('OE7MOV', 'oe.origin', 'a.example', ?)",
    )
      .bind(nowS())
      .run();
    await syncAllPeers(hub);
    expect((await moves(hub))?.n).toBe(0);
  });

  it("erasing an account purges its mirrored key bindings and moves", async () => {
    const { a, hub } = await world();
    const dev = await newFedKey();
    await registerKey(hub, "OE7MOV", dev);
    await importMove(a, dev);
    await syncAllPeers(hub);
    const keysBefore = await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_keys WHERE callsign = 'OE7MOV'").first<{
      n: number;
    }>();
    expect(keysBefore?.n).toBe(1);
    expect((await moves(hub))?.n).toBe(1);

    const at = nowS();
    const sig = await sign(
      dev,
      accountActionMessage({ action: "delete", callsign: "OE7MOV", instance: "a.example", at }),
    );
    const del = await serve(a)(
      new Request("https://a.example/api/account/OE7MOV/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: dev.pub, sig, at }),
      }),
    );
    expect(del.status).toBe(200);
    await syncAllPeers(hub);
    const keysAfter = await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_keys WHERE callsign = 'OE7MOV'").first<{
      n: number;
    }>();
    expect(keysAfter?.n).toBe(0);
    expect((await moves(hub))?.n).toBe(0);
    const local = await a.DB.prepare("SELECT COUNT(*) AS n FROM account_moves WHERE callsign = 'OE7MOV'").first<{
      n: number;
    }>();
    expect(local?.n).toBe(0);
  });
});

describe("account-move proofs cannot be replayed or vouched for by a colluder", () => {
  async function peer(instance: string, hub: Env) {
    const key = await newFedKey();
    const env = instanceEnv(instance, key);
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, 'trusted', 'manual')",
    )
      .bind(`https://${instance}`, instance, key.pub, JSON.stringify([{ x: key.pub }]))
      .run();
    return env;
  }
  const announce = async (env: Env, instance: string, dev: FedKey, at: number, ts = nowS()) => {
    const sig = await sign(dev, accountActionMessage({ action: "migrate", callsign: "OE7MOV", instance, at }));
    await env.DB.prepare(
      "INSERT INTO account_moves (callsign, from_instance, to_instance, ts, proof_key, proof_sig, proof_at) VALUES ('OE7MOV', NULL, ?, ?, ?, ?, ?)",
    )
      .bind(instance, ts, dev.pub, sig, at)
      .run();
  };
  const home = (hub: Env) =>
    hub.DB.prepare("SELECT to_instance FROM remote_account_moves WHERE callsign = 'OE7MOV'").first<{
      to_instance: string;
    }>();

  it("a former home re-announcing its old proof does not take the account back", async () => {
    const hub = instanceEnv("hub.example", await newFedKey());
    const o = await peer("o.example", hub);
    const p = await peer("p.example", hub);
    stubFetch({ "https://o.example": serve(o), "https://p.example": serve(p) });
    const dev = await newFedKey();
    await registerKey(hub, "OE7MOV", dev);
    await announce(o, "o.example", dev, nowS() - 7200);
    await syncAllPeers(hub);
    await announce(p, "p.example", dev, nowS() - 3600);
    await syncAllPeers(hub);
    expect((await home(hub))?.to_instance).toBe("p.example");
    await announce(o, "o.example", dev, nowS() - 7200, nowS() + 10); // the old proof, a fresh ts
    await syncAllPeers(hub);
    expect((await home(hub))?.to_instance).toBe("p.example");
  });

  it("a key published by an unvetted peer cannot vouch for a move", async () => {
    const hub = instanceEnv("hub.example", await newFedKey());
    const claimer = await peer("claim.example", hub);
    const dev = await newFedKey();
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES ('https://shill.example', 'shill.example', 'X', 'unvetted', 'discovered')",
    ).run();
    await hub.DB.prepare(
      "INSERT INTO remote_keys (global_id, origin, callsign, public_key, verified, mirrored_at) VALUES ('shill.example:key:1', 'shill.example', 'OE7MOV', ?, 0, 1)",
    )
      .bind(dev.pub)
      .run();
    stubFetch({ "https://claim.example": serve(claimer) });
    await announce(claimer, "claim.example", dev, nowS() - 60);
    await syncAllPeers(hub);
    expect(await home(hub)).toBeNull();
  });
});
