// SPDX-License-Identifier: AGPL-3.0-or-later
// The box's callsigns against the gateway's: a station on the service call, and a receiving site the
// gateway does not attest, are both said in the log.
import { describe, it, expect } from "vitest";
import { callWarnings, stationCalls } from "../src/callroles.js";

describe("callsign checks against the gateway", () => {
  it("lists every station call, MeshCom nodes included", () => {
    const env = { DIGI_CALL: "oe8apr-10", NETROM_CALL: "OE8APR-5", MESHCOM_NODE: "192.168.1.50=OE8APR-12" };
    expect(stationCalls(env)).toEqual([
      { key: "DIGI_CALL", call: "OE8APR-10" },
      { key: "NETROM_CALL", call: "OE8APR-5" },
      { key: "MESHCOM_NODE", call: "OE8APR-12" },
    ]);
  });
  it("warns when a station uses the service call", () => {
    const w = callWarnings({ MESHCOM_NODE: "192.168.1.50=OE8APR-15" }, "OE8APR-15");
    expect(w).toEqual([expect.stringMatching(/^MESHCOM_NODE OE8APR-15 is the gateway's service call/)]);
  });
  it("warns when a receiving site of this box is not attested by the gateway", () => {
    const env = { KISS_TNC_HOST: "127.0.0.1", RF_SITE_CALL: "OE8APR-10", MESHCOM_NODE: "192.168.1.50=OE8APR-12" };
    expect(callWarnings(env, "OE8APR-15", ["OE8APR-10"])).toEqual([
      expect.stringMatching(/^MESHCOM_NODE OE8APR-12 is not in the gateway's FIRST_PARTY_SITES/),
    ]);
    expect(callWarnings(env, "OE8APR-15", ["OE8APR-10", "OE8APR-12"])).toEqual([]);
    // an older gateway names no sites: nothing to compare
    expect(callWarnings(env, "OE8APR-15")).toEqual([]);
  });
});
