// SPDX-License-Identifier: MIT
// The connected-mode sync binding in loopback: client and server wired line-to-line, caps
// negotiated from the greeting, pages pulled request/response, compression applied only when both
// ends negotiated it, and the page limit self-halving under the line budget.
import { describe, it, expect } from "vitest";
import { FedSyncApp, FedSyncLinkClient, type LinkPayloadCodec } from "../src/fedsync-link.js";
import { makeLineDriver, type LineApp, type LineReply } from "../src/link-app.js";
import { encodeFedSyncPage, FED_DEFLATE_DICT_ID, type LinkCaps } from "@aprscaching/shared";

const CAPS_VHF: LinkCaps = {
  mode: "sync",
  mtu: 1024,
  rateClass: "vhf1200",
  batchMax: 25,
  compress: [FED_DEFLATE_DICT_ID, "none"],
  recordSet: "compact",
};
const CAPS_NODICT: LinkCaps = { ...CAPS_VHF, compress: ["none"] };

/** A stand-in payload codec (byte-flip) — the real zlib codec is driver-owned and tested in ingest. */
const flip: LinkPayloadCodec = {
  compress: (b) => b.map((x) => x ^ 0xff),
  decompress: (b) => b.map((x) => x ^ 0xff),
};

/** Wire a client to a server app, line to line, the way a circuit would. */
function loop(app: FedSyncApp, clientCaps: LinkCaps, codec?: LinkPayloadCodec) {
  const client: FedSyncLinkClient = new FedSyncLinkClient(
    clientCaps,
    {
      sendLine: (line) => {
        void Promise.resolve(app.handle(line)).then((r) => {
          for (const l of r.lines) client.onLine(l);
        });
      },
    },
    codec,
  );
  const helloDone = client.hello();
  for (const l of app.greeting()) client.onLine(l);
  return { client, helloDone };
}

const page = (frames: Uint8Array[], next = 7, complete = true) => encodeFedSyncPage("oe.pub", next, complete, frames);

describe("fedsync link protocol", () => {
  it("negotiates caps from the greeting and pulls a page", async () => {
    const served = page([Uint8Array.from([1, 2, 3])]);
    const app = new FedSyncApp(CAPS_VHF, async () => served, flip);
    const { client, helloDone } = loop(app, { ...CAPS_VHF, rateClass: "ipHi", batchMax: 500 }, flip);
    const caps = await helloDone;
    expect(caps.rateClass).toBe("vhf1200"); // slower side wins
    expect(caps.batchMax).toBe(25);
    expect(caps.compress[0]).toBe(FED_DEFLATE_DICT_ID);
    const got = await client.pull("cache", 0, 100);
    expect([...got]).toEqual([...served]);
  });

  it("skips compression when one end lacks the dictionary", async () => {
    const served = page([Uint8Array.from([9, 9])]);
    let compressed = 0;
    const counting: LinkPayloadCodec = {
      compress: (b) => {
        compressed++;
        return b;
      },
      decompress: (b) => b,
    };
    const app = new FedSyncApp(CAPS_VHF, async () => served, counting);
    const { client, helloDone } = loop(app, CAPS_NODICT, counting);
    const caps = await helloDone;
    expect(caps.compress[0]).toBe("none");
    expect([...(await client.pull("cache", 0, 10))]).toEqual([...served]);
    expect(compressed).toBe(0); // negotiated none → codec untouched
  });

  it("halves the page limit until the reply fits the line budget", async () => {
    const limits: number[] = [];
    const app = new FedSyncApp(
      CAPS_VHF,
      async (_t, _s, limit) => {
        limits.push(limit);
        // an oversized page until the server asks for few enough records
        return limit > 6 ? page([new Uint8Array(9000)]) : page([Uint8Array.from([5])]);
      },
      flip,
    );
    const { client, helloDone } = loop(app, CAPS_VHF, flip);
    await helloDone;
    const got = await client.pull("cache", 0, 25);
    expect(limits).toEqual([25, 12, 6]);
    expect(got.length).toBeGreaterThan(0);
  });

  it("refuses a request before hello and reports unknown feeds", async () => {
    const app = new FedSyncApp(CAPS_VHF, async () => null, flip);
    const early = await app.handle("ACSL1 R AAAA");
    expect(early.lines[0]).toContain("E hello first");
    expect(early.disconnect).toBe(true);

    const { client, helloDone } = loop(new FedSyncApp(CAPS_VHF, async () => null, flip), CAPS_VHF, flip);
    await helloDone;
    await expect(client.pull("nope", 0, 5)).rejects.toThrow(/unknown feed/);
  });

  it("the client ignores non-protocol lines (node banners) without disturbing a pending pull", async () => {
    const served = page([Uint8Array.from([4])]);
    const app = new FedSyncApp(CAPS_VHF, async () => served, flip);
    const { client, helloDone } = loop(app, CAPS_VHF, flip);
    await helloDone;
    const pulling = client.pull("cache", 0, 5);
    client.onLine("Welcome to OE8XBB node. Type ? for help.");
    expect([...(await pulling)]).toEqual([...served]);
  });
});

describe("line driver with an async app", () => {
  it("processes lines strictly in order even when handles resolve out of order", async () => {
    const sent: string[] = [];
    const delays: Record<string, number> = { one: 30, two: 1 };
    const app: LineApp = {
      greeting: () => ["hi"],
      handle: (input): Promise<LineReply> =>
        new Promise((resolve) => setTimeout(() => resolve({ lines: [`ack ${input}`] }), delays[input] ?? 0)),
    };
    const driver = makeLineDriver(app, {
      send: (b) => sent.push(new TextDecoder().decode(b)),
      disconnect: () => {},
    });
    driver.onUp();
    driver.onData(new TextEncoder().encode("one\rtwo\r"));
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toEqual(["hi\r", "ack one\r", "ack two\r"]); // arrival order, not resolution order
  });

  it("a sync app still gets synchronous replies (no behavior change)", () => {
    const sent: string[] = [];
    const app: LineApp = { greeting: () => ["go"], handle: (i) => ({ lines: [`=${i}`] }) };
    const driver = makeLineDriver(app, {
      send: (b) => sent.push(new TextDecoder().decode(b)),
      disconnect: () => {},
    });
    driver.onUp();
    driver.onData(new TextEncoder().encode("a\rb\r"));
    expect(sent).toEqual(["go\r", "=a\r", "=b\r"]); // replies emitted before onData returns
  });
});
