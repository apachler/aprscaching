// SPDX-License-Identifier: AGPL-3.0-or-later
// The legs of a stored packet's route and the reason for its tier: only an attested site's own receiver supports
// Tier A; every APRS-IS line stays Tier C, one naming the attested site included.
import { describe, expect, it } from "vitest";
import type { PacketRouteInfo } from "@aprscaching/shared";
import { routeView } from "../src/packet/route.js";

const route = (over: Partial<PacketRouteInfo>): PacketRouteInfo => ({
  src: "OE6GHJ-7",
  path: "",
  heardVia: "rf",
  transport: "tnc",
  site: "OE6XGR-10",
  attested: false,
  siteAttested: false,
  ts: 0,
  ...over,
});

const roles = (r: PacketRouteInfo) => routeView(r).hops.map((h) => `${h.role}:${h.call ?? ""}:${h.state}`);

describe("routeView", () => {
  it("draws an RF-only frame the attested site heard as Tier A, with no APRS-IS leg", () => {
    const v = routeView(route({ path: "OE6XGR-2*,WIDE2-1", attested: true, siteAttested: true }));
    expect(v.evidence).toBe("A");
    expect(roles(route({ path: "OE6XGR-2*,WIDE2-1", attested: true }))).toEqual([
      "origin:OE6GHJ-7:plain",
      "digipeater:OE6XGR-2:plain",
      "digipeater:WIDE2-1:unused",
      "receiver:OE6XGR-10:attested",
      "gateway::plain",
    ]);
    expect(v.why).toMatch(/OE6XGR-10's own receiver.*Tier A/);
  });

  it("keeps qAR naming the attested site at Tier C and says why", () => {
    const v = routeView(
      route({ path: "WIDE1-1,qAR,OE6XGR-10", transport: "aprs-is", attested: false, siteAttested: true }),
    );
    expect(v.evidence).toBe("C");
    expect(v.hops.map((h) => h.role)).toEqual(["origin", "digipeater", "igate", "aprs-is", "gateway"]);
    expect(v.hops.find((h) => h.role === "aprs-is")).toMatchObject({ call: "qAR", state: "untrusted" });
    expect(v.why).toMatch(/naming OE6XGR-10, an attested site.*public passcode.*Tier C/);
  });

  it("names a stranger's IGate for qAO", () => {
    const v = routeView(route({ path: "WIDE2-1,qAO,DB0XYZ-10", transport: "aprs-is", site: "DB0XYZ-10" }));
    expect(v.hops.find((h) => h.role === "igate")?.call).toBe("DB0XYZ-10");
    expect(v.why).toMatch(/DB0XYZ-10 copied it to APRS-IS \(qAO\).*Tier C/);
  });

  it("reads TCPIP*,qAC as written straight to APRS-IS, naming the server", () => {
    const v = routeView(
      route({ path: "TCPIP*,qAC,T2AUSTRIA", heardVia: "aprs_is", transport: "aprs-is", site: "T2AUSTRIA" }),
    );
    expect(roles(route({ path: "TCPIP*,qAC,T2AUSTRIA", heardVia: "aprs_is", transport: "aprs-is" }))).toEqual([
      "origin:OE6GHJ-7:plain",
      "internet:TCPIP:untrusted",
      "aprs-is:qAC:untrusted",
      "gateway::plain",
    ]);
    expect(v.hops.find((h) => h.role === "aprs-is")?.sub).toBe("server T2AUSTRIA");
    expect(v.why).toMatch(/straight to APRS-IS \(qAC\)/);
  });

  it("keeps qAS and qAX at Tier C", () => {
    for (const q of ["qAS", "qAX"]) {
      const v = routeView(route({ path: `${q},T2GRAZ`, heardVia: "aprs_is", transport: "aprs-is", site: null }));
      expect(v.evidence).toBe("C");
      expect(v.why).toContain(`over APRS-IS (${q})`);
    }
  });

  it("marks every hop up to the last `*` as used, generic requests included", () => {
    const v = routeView(route({ path: "OE6XGR-2,WIDE1*,WIDE2-1", attested: true }));
    expect(v.hops.slice(1, 4).map((h) => [h.call, h.state, h.label])).toEqual([
      ["OE6XGR-2", "plain", "Digipeater"],
      ["WIDE1", "plain", "Path request, used"],
      ["WIDE2-1", "unused", "Not taken"],
    ]);
  });

  it("keeps an RF hearing by a receiver the instance does not attest at Tier C", () => {
    const v = routeView(route({ path: "", site: "OE6ABC" }));
    expect(v.evidence).toBe("C");
    expect(v.hops.find((h) => h.role === "receiver")).toMatchObject({ call: "OE6ABC", state: "untrusted" });
    expect(v.why).toMatch(/does not attest/);
  });

  it("keeps the sender's own browser bridge and internet links at Tier C", () => {
    expect(routeView(route({ transport: "browser-rf", site: null })).why).toMatch(/own browser radio bridge/);
    expect(routeView(route({ transport: "axudp" })).why).toMatch(/AXUDP link/);
  });
});
