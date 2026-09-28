// SPDX-License-Identifier: AGPL-3.0-or-later
// The recorded transport is display data. Every ingest port maps to one transport, and legacy rows without
// one keep the earlier derivation. The guard: a transport can only ever take attestation away — a tunnel
// or licence-free carrier (AXUDP, AXIP, Meshtastic) is never first-party attested — and no other
// transport value moves firstPartyAttested or a verification tier: Tier A stays gated on attestation alone.
import { describe, it, expect } from "vitest";
import { Transport } from "@aprscaching/shared";
import { provenanceOf, parseAttestedSites, transportForPort, type RawProvenance } from "../src/provenance.js";
import { verifyFind, DEFAULT_POLICY, type CacheRow, type PositionRow } from "../src/verify.js";

describe("transportForPort", () => {
  it.each([
    ["aprs-is", "aprs-is"],
    ["kiss-tnc", "tnc"],
    ["agwpe", "tnc"],
    ["hostmode", "tnc"],
    ["webserial-kiss", "browser-rf"],
    ["browser-rf", "browser-rf"],
    ["axudp", "axudp"],
    ["axip", "axip"],
    ["meshcom", "meshcom"],
    ["meshtastic", "meshtastic"],
  ])("port %s → %s", (port, transport) => {
    expect(transportForPort(port, false)).toBe(transport);
  });

  it("a signed browser batch is browser-rf whatever port it names", () => {
    expect(transportForPort("meshtastic", true)).toBe("browser-rf");
    expect(transportForPort("kiss-tnc", true)).toBe("browser-rf");
  });

  it("an unknown port records nothing", () => {
    expect(transportForPort("something-new", false)).toBeNull();
  });
});

describe("transportOf on stored positions", () => {
  it("reads the recorded transport", () => {
    expect(provenanceOf({ heard_via: "rf", transport: "tnc" }).transport).toBe("tnc");
    expect(provenanceOf({ heard_via: "aprs_is", transport: "meshcom" }).transport).toBe("meshcom");
  });

  it("legacy rows (NULL) and unrecognised values keep the earlier derivation", () => {
    expect(provenanceOf({ heard_via: "rf", transport: null }).transport).toBe("aprs-is");
    expect(provenanceOf({ heard_via: "app" }).transport).toBe("app");
    expect(provenanceOf({ heard_via: "rf", transport: "carrier-pigeon" }).transport).toBe("aprs-is");
  });
});

// ---- trust guard -------------------------------------------------------------------------------
const TRANSPORTS: (string | null | undefined)[] = [...Transport.options, null, undefined, "carrier-pigeon", ""];
const HEARD: RawProvenance["heard_via"][] = ["rf", "aprs_is", "app"];
const PATHS = [null, "WIDE1-1", "WIDE1-1,qAR,OE8XXX", "WIDE2-1,qAO,OE8XXX", "TCPIP*,qAC,T2TEST", "TCPIP*,qAX,T2"];
const IGATES = [null, "OE8XXX", "DB0ZZZ"];
const SITE_SETS = [parseAttestedSites(""), parseAttestedSites("OE8XXX")];

const NEVER_ATTESTED = new Set(["axudp", "axip", "meshtastic"]);

describe("trust guard: the transport never lifts attestation", () => {
  it("a tunnel or licence-free carrier is never attested, even heard as RF at an attested site", () => {
    const sites = parseAttestedSites("OE8XXX");
    for (const transport of NEVER_ATTESTED)
      for (const path of [null, "WIDE1-1", "WIDE1-1,qAR,OE8XXX", "WIDE2-1,qAO,OE8XXX"])
        expect(provenanceOf({ heard_via: "rf", path, igate_call: "OE8XXX", transport }, sites).firstPartyAttested).toBe(
          false,
        );
    // the same inputs on a local TNC are attested — the refusal is the transport's, not the inputs'
    expect(provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", transport: "tnc" }, sites).firstPartyAttested).toBe(
      true,
    );
  });

  it("every other transport leaves firstPartyAttested unchanged, across every other input", () => {
    let cases = 0;
    for (const heard_via of HEARD)
      for (const path of PATHS)
        for (const igate_call of IGATES)
          for (const sites of SITE_SETS) {
            const baseline = provenanceOf({ heard_via, path, igate_call }, sites).firstPartyAttested;
            for (const transport of TRANSPORTS) {
              const expected = NEVER_ATTESTED.has(transport ?? "") ? false : baseline;
              expect(provenanceOf({ heard_via, path, igate_call, transport }, sites).firstPartyAttested).toBe(expected);
              cases++;
            }
          }
    expect(cases).toBe(HEARD.length * PATHS.length * IGATES.length * SITE_SETS.length * TRANSPORTS.length);
  });

  it("a find's tier depends on the transport only through attestation", () => {
    const cache: CacheRow = { id: 1, code: "AC-1", type: "traditional", lat: 47.07, lon: 15.42 };
    const sites = parseAttestedSites("OE8XXX");
    const now = 1_000_000;
    for (const heard_via of ["rf", "aprs_is"] as const)
      for (const path of ["WIDE1-1,qAR,OE8XXX", "TCPIP*,qAC,T2TEST"])
        for (const igate_call of ["OE8XXX", "DB0ZZZ"]) {
          const run = (transport: string | null | undefined) => {
            const raw = { heard_via, path, igate_call, transport, ts: now - 60 };
            const row: PositionRow = {
              id: 1,
              callsign: "OE3PLY-7",
              ts: now - 60,
              lat: 47.07,
              lon: 15.42,
              heard_via,
              igate_call,
              firstPartyAttested: provenanceOf(raw, sites).firstPartyAttested,
            };
            const r = verifyFind(cache, undefined, {
              loggerPositions: [row],
              loggerOwnIgates: new Set(["OE3PLY"]),
              now,
            });
            return [r.tier, r.verified, r.method];
          };
          const baseline = run(undefined);
          const unattested = run("axudp");
          for (const transport of TRANSPORTS)
            expect(run(transport)).toEqual(NEVER_ATTESTED.has(transport ?? "") ? unattested : baseline);
        }
    expect(DEFAULT_POLICY.minTier).toBe("B");
  });
});
