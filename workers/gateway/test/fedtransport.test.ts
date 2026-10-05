// SPDX-License-Identifier: AGPL-3.0-or-later
// The sync transport tries a peer's addresses in priority order and keeps the first that answers: a 44Net name
// with a certificate over https and then plain http, a HAMNET host with a short timeout, then the next endpoint.
import { describe, it, expect } from "vitest";
import { mergeEndpoints, syncAddresses, syncTransportFor } from "../src/fedtransport.js";
import type { FedEndpoint } from "@aprscaching/shared";

/** A fetch that answers the listed bases and fails every other connection, recording what was tried. */
function net(reachable: string[]) {
  const tried: { url: string; timeout: boolean }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    tried.push({ url, timeout: !!init?.signal });
    if (reachable.some((b) => url.startsWith(`${b}/`))) return new Response(JSON.stringify({ at: url }));
    throw new TypeError(`fetch failed: ${url}`);
  };
  return { tried, fetchFn };
}

const endpoints = (list: unknown[]) => ({ endpoints: JSON.stringify(list) });

describe("syncTransportFor", () => {
  it("falls back from https to plain http on a 44Net name with a certificate", async () => {
    const { tried, fetchFn } = net(["http://aprscaching.oe8apr.ampr.org"]);
    const t = syncTransportFor(
      endpoints([{ transport: "44net", address: "https://aprscaching.oe8apr.ampr.org", priority: 10 }]),
      fetchFn,
    )!;
    expect(t.baseUrl).toBe("https://aprscaching.oe8apr.ampr.org");
    await t.fetchJson("/.well-known/aprscaching");
    expect(t.baseUrl).toBe("http://aprscaching.oe8apr.ampr.org");
    expect(t.kind).toBe("44net");
    expect(tried.map((x) => x.url)).toEqual([
      "https://aprscaching.oe8apr.ampr.org/.well-known/aprscaching",
      "http://aprscaching.oe8apr.ampr.org/.well-known/aprscaching",
    ]);
    // the address that answered carries the rest of the sync, without trying https again
    await t.get("/federation/caches");
    expect(tried.at(-1)!.url).toBe("http://aprscaching.oe8apr.ampr.org/federation/caches");
    expect(tried).toHaveLength(3);
  });

  it("uses a HAMNET endpoint a peer can reach, and moves on to the next endpoint when it cannot", async () => {
    const list = [
      { transport: "hamnet", address: "44.143.1.2", priority: 5 },
      { transport: "https", address: "https://aprs.example.net", priority: 10 },
    ];
    const onHamnet = net(["http://44.143.1.2"]);
    const a = syncTransportFor(endpoints(list), onHamnet.fetchFn)!;
    await a.get("/.well-known/aprscaching");
    expect(a.kind).toBe("hamnet");
    expect(a.baseUrl).toBe("http://44.143.1.2");

    const onInternet = net(["https://aprs.example.net"]);
    const b = syncTransportFor(endpoints(list), onInternet.fetchFn)!;
    await b.get("/.well-known/aprscaching");
    expect(b.kind).toBe("https");
    expect(onInternet.tried.map((x) => x.url)).toEqual([
      "http://44.143.1.2/.well-known/aprscaching",
      "https://aprs.example.net/.well-known/aprscaching",
    ]);
    expect(onInternet.tried.every((x) => x.timeout)).toBe(true);
  });

  it("keeps an address that answers with an error status: the peer is there", async () => {
    const fetchFn = async () => new Response("no", { status: 503 });
    const t = syncTransportFor(
      endpoints([
        { transport: "https", address: "https://a.example", priority: 1 },
        { transport: "https", address: "https://b.example", priority: 2 },
      ]),
      fetchFn,
    )!;
    await expect(t.fetchJson("/x")).rejects.toThrow(/503 .*https:\/\/a\.example\/x/);
    expect(t.baseUrl).toBe("https://a.example");
  });

  it("throws the last failure when no address answers, and has no transport for packet-only peers", async () => {
    const { fetchFn } = net([]);
    const t = syncTransportFor(endpoints([{ transport: "hamnet", address: "44.143.1.2", priority: 1 }]), fetchFn)!;
    await expect(t.get("/x")).rejects.toThrow(/fetch failed: http:\/\/44\.143\.1\.2\/x/);
    expect(syncTransportFor(endpoints([{ transport: "ax25", address: "OE8APR-7", priority: 1 }]), fetchFn)).toBeNull();
  });

  it("reaches a peer without an endpoint set at its url", async () => {
    const { fetchFn } = net(["https://peer.example"]);
    const t = syncTransportFor({ url: "https://peer.example/" }, fetchFn)!;
    await t.get("/x");
    expect(t.baseUrl).toBe("https://peer.example");
  });

  it("tries the row's url after its endpoint set, unless the set lists it", () => {
    const set = endpoints([{ transport: "https", address: "https://alt.example", priority: 10 }]);
    expect(syncAddresses({ ...set, url: "https://peer.example" }).map((a) => a.baseUrl)).toEqual([
      "https://alt.example",
      "https://peer.example",
    ]);
    expect(syncAddresses({ ...set, url: "https://alt.example" }).map((a) => a.baseUrl)).toEqual([
      "https://alt.example",
    ]);
    expect(syncAddresses({ ...set, url: "submit:spoke.example" }).map((a) => a.baseUrl)).toEqual([
      "https://alt.example",
    ]);
  });
});

describe("mergeEndpoints", () => {
  const dns: FedEndpoint = {
    transport: "44net",
    address: "aprscaching.oe8apr.ampr.org",
    priority: 10,
    verifiedVia: "ardc-lot",
  };
  const own: FedEndpoint = { transport: "https", address: "https://peer.example", priority: 40 };
  const said: FedEndpoint = { transport: "https", address: "https://said.example", priority: 30 };
  const url = "https://peer.example";

  it("a whole list replaces what the peer said, never what DNS attested or the row's own address", () => {
    const next: FedEndpoint = { transport: "hamnet", address: "44.143.1.2", priority: 20 };
    expect(mergeEndpoints([dns, own, said], [next], { url, replace: true })).toEqual([dns, next, own]);
  });

  it("a partial list adds and updates, and drops nothing", () => {
    const moved: FedEndpoint = { ...said, priority: 5 };
    expect(mergeEndpoints([dns, said], [moved], { url, replace: false })).toEqual([moved, dns]);
  });

  it("a peer cannot attest itself or move an attested endpoint", () => {
    const claim: FedEndpoint = {
      transport: "https",
      address: "https://x.example",
      priority: 1,
      verifiedVia: "ardc-lot",
    };
    const steal: FedEndpoint = { ...dns, priority: 1, verifiedVia: undefined };
    expect(mergeEndpoints([dns], [claim, steal], { url, replace: true })).toEqual([
      { transport: "https", address: "https://x.example", priority: 1 },
      dns,
    ]);
  });

  it("keeps a row's set bounded, lowest priority first to go", () => {
    const many = Array.from({ length: 40 }, (_, i): FedEndpoint => ({
      transport: "https",
      address: `https://p${i}.example`,
      priority: 50 + (i % 50),
    }));
    const out = mergeEndpoints([dns], many, { url, replace: true });
    expect(out).toHaveLength(16);
    expect(out[0]).toEqual(dns);
  });
});
