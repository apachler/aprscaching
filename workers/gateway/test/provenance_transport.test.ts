// SPDX-License-Identifier: AGPL-3.0-or-later
// Every ingest port maps to one transport, and a port the gateway does not know records `unknown`. The
// guard: only a first-party on-air transport — a TNC or a MeshCom node on the operator's own ingest box,
// whose writes need INGEST_SECRET — can carry first-party attestation. An APRS-IS line or an unknown
// transport is never attested, whatever q-construct and site it names, because an APRS-IS passcode is public and anyone can
// inject `qAR,<site>`. A tunnel or licence-free carrier (AXUDP, AXIP, Meshtastic)
// and the browser bridge are never attested either. Tier A stays gated on attestation alone.
import { describe, it, expect } from "vitest";
import { Transport } from "@aprscaching/shared";
import { provenanceOf, parseAttestedSites, transportForPort, type RawProvenance } from "../src/provenance.js";
import { verifyFind, DEFAULT_POLICY, type CacheRow, type PositionRow } from "../src/verify.js";

describe("transportForPort", () => {
  it.each([
    ["aprs-is", "aprs-is"],
    ["kiss-tnc", "tnc"],
    ["soundcard", "tnc"],
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

  it("an unknown port records `unknown`", () => {
    expect(transportForPort("something-new", false)).toBe("unknown");
    expect(transportForPort("", false)).toBe("unknown");
  });
});

describe("transportOf on stored positions", () => {
  it("reads the recorded transport", () => {
    expect(provenanceOf({ heard_via: "rf", transport: "tnc" }).transport).toBe("tnc");
    expect(provenanceOf({ heard_via: "aprs_is", transport: "meshcom" }).transport).toBe("meshcom");
  });

  it("an absent or unrecognised value reads as unknown, whatever the row says it heard", () => {
    expect(provenanceOf({ heard_via: "rf", transport: null }).transport).toBe("unknown");
    expect(provenanceOf({ heard_via: "app" }).transport).toBe("unknown");
    expect(provenanceOf({ heard_via: "rf", transport: "carrier-pigeon" }).transport).toBe("unknown");
  });
});

// ---- trust guard -------------------------------------------------------------------------------
const TRANSPORTS: (string | null | undefined)[] = [...Transport.options, null, undefined, "carrier-pigeon", ""];
const HEARD: RawProvenance["heard_via"][] = ["rf", "aprs_is", "app"];
const PATHS = [null, "WIDE1-1", "WIDE1-1,qAR,OE8XXX", "WIDE2-1,qAO,OE8XXX", "TCPIP*,qAC,T2TEST", "TCPIP*,qAX,T2"];
const IGATES = [null, "OE8XXX", "DB0ZZZ"];
const SITE_SETS = [parseAttestedSites(""), parseAttestedSites("OE8XXX")];

const NEVER_ATTESTED = new Set(["axudp", "axip", "meshtastic"]);
const ON_AIR = new Set(["tnc", "meshcom"]);

describe("trust guard: only the site's own on-air ingest is attested", () => {
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

  it("an APRS-IS line or an unknown transport is never attested, whatever q-construct and site it names", () => {
    const sites = parseAttestedSites("OE8XXX");
    for (const transport of ["aprs-is", "unknown", "carrier-pigeon", null, undefined])
      for (const path of [null, "WIDE1-1", "WIDE1-1,qAR,OE8XXX", "WIDE2-1,qAO,OE8XXX"])
        expect(provenanceOf({ heard_via: "rf", path, igate_call: "OE8XXX", transport }, sites).firstPartyAttested).toBe(
          false,
        );
  });

  it("attestation needs an on-air transport and the site rule, across every input", () => {
    let cases = 0;
    let attested = 0;
    for (const heard_via of HEARD)
      for (const path of PATHS)
        for (const igate_call of IGATES)
          for (const sites of SITE_SETS) {
            // what the inputs alone allow, heard through the site's own TNC
            const onAir = provenanceOf({ heard_via, path, igate_call, transport: "tnc" }, sites).firstPartyAttested;
            for (const transport of TRANSPORTS) {
              const got = provenanceOf({ heard_via, path, igate_call, transport }, sites).firstPartyAttested;
              expect(got).toBe(ON_AIR.has(transport ?? "") ? onAir : false);
              if (got) attested++;
              cases++;
            }
          }
    expect(cases).toBe(HEARD.length * PATHS.length * IGATES.length * SITE_SETS.length * TRANSPORTS.length);
    expect(attested).toBeGreaterThan(0); // the guard is not vacuous
  });

  it("a find's tier depends on the transport only through attestation", () => {
    const cache: CacheRow = { id: 1, code: "AC-1", type: "traditional", lat: 47.07, lon: 15.42 };
    const sites = parseAttestedSites("OE8XXX");
    const now = 1_000_000;
    let tierA = 0;
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
          const onAir = run("tnc");
          const unattested = run("aprs-is");
          if (onAir[0] === "A") tierA++;
          for (const transport of TRANSPORTS)
            expect(run(transport)).toEqual(ON_AIR.has(transport ?? "") ? onAir : unattested);
        }
    expect(tierA).toBeGreaterThan(0); // Tier A is reachable through the on-air transports
    expect(DEFAULT_POLICY.minTier).toBe("B");
  });
});
