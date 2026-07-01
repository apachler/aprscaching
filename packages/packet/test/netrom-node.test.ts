import { describe, it, expect } from "vitest";
import { NetromNode } from "../src/netrom-node.js";
import { encodeNodesBroadcast, decodeNodesBroadcast, combineQuality, type NodesDest } from "../src/netrom-wire.js";

const A = (call: string, ssid = 0) => ({ call, ssid });
const ME = { call: A("OE8NOD", 1), alias: "OENODE" };

/** Build a NODES broadcast info field as if a neighbour sent it advertising `dests`. */
function bcastFrom(senderAlias: string, dests: NodesDest[]): Uint8Array {
  return encodeNodesBroadcast(senderAlias, dests)[0]!;
}

describe("NET/ROM node routing engine (docs/29 F2)", () => {
  it("learns the neighbour directly and each advertised dest at combined quality", () => {
    const node = new NetromNode(ME, { pathQuality: 200 });
    // OE9SRC advertises a route to OE3FAR at broadcast quality 180
    const info = bcastFrom("SRC", [{ dest: A("OE3FAR"), alias: "FAR", neighbor: A("OE9SRC"), quality: 180 }]);
    const learned = node.consume(info, A("OE9SRC"), "kiss-tnc");
    expect(learned).toBe(2);   // the neighbour itself + the advertised OE3FAR

    const neigh = node.best("OE9SRC")!;
    expect(neigh.quality).toBe(200);               // directly-heard neighbour = path quality
    expect(neigh.port).toBe("kiss-tnc");

    const far = node.best("OE3FAR")!;
    expect(far.neighbor.call).toBe("OE9SRC");      // reachable via the neighbour
    expect(far.quality).toBe(combineQuality(180, 200));
  });

  it("keeps the higher-quality route and finds by alias", () => {
    const node = new NetromNode(ME, { pathQuality: 255 });
    node.consume(bcastFrom("N1", [{ dest: A("OE3FAR"), alias: "FAR", neighbor: A("OE1N1"), quality: 100 }]), A("OE1N1"));
    node.consume(bcastFrom("N2", [{ dest: A("OE3FAR"), alias: "FAR", neighbor: A("OE2N2"), quality: 250 }]), A("OE2N2"));
    expect(node.best("FAR")!.quality).toBe(combineQuality(250, 255)); // the better one won, found by alias
  });

  it("advertises ourself + top-N best routes, round-tripping through the decoder", () => {
    const node = new NetromNode(ME, { topN: 2, pathQuality: 200 });
    for (const [call, q] of [["OE1A", 60], ["OE2B", 200], ["OE3C", 120]] as const)
      node.consume(bcastFrom("X", [{ dest: A(call), alias: call, neighbor: A(call), quality: q }]), A(call));
    const frames = node.broadcast();
    const decoded = decodeNodesBroadcast(frames[0]!)!;
    expect(decoded.senderAlias).toBe("OENODE");
    const dests = decoded.dests.map((d) => `${d.dest.call}-${d.dest.ssid}`);
    expect(dests[0]).toBe("OE8NOD-1");            // ourself advertised first
    expect(decoded.dests[0]!.quality).toBe(0);    // quality 0 → receiver substitutes its own path quality
    // only the top-2 learned neighbours by quality follow (each was heard directly at pathQuality 200)
    expect(decoded.dests.length).toBe(3);         // self + 2
  });

  it("decays obsolescence and drops stale routes but keeps locked ones", () => {
    const node = new NetromNode(ME);
    node.consume(bcastFrom("N", [{ dest: A("OE3FAR"), alias: "FAR", neighbor: A("OE1N"), quality: 100 }]), A("OE1N"));
    node.lock({ dest: A("OE7PIN"), alias: "PIN", neighbor: A("OE7PIN"), quality: 255 });
    for (let i = 0; i < 6; i++) node.decay();      // obsolescence starts at 6
    expect(node.best("OE3FAR")).toBeNull();        // learned route decayed away
    expect(node.best("OE7PIN")).not.toBeNull();    // locked route survives
  });
});
