// SPDX-License-Identifier: AGPL-3.0-or-later
// The NET/ROM node's timing from env: a too-short interval would key the transmitter every few seconds, and
// a path quality outside 0–255 would corrupt every route learned through it. Every connect costs a service
// factory run and transmitted frames, and any station can send one from any call, so the services are capped.
import { describe, it, expect, vi } from "vitest";
import { MAX_SESSIONS_DEFAULT } from "@aprscaching/packet";
import { encodeFrame } from "@aprscaching/ax25";
import { netromSettings, startConnectedServices, NETROM_BROADCAST_MIN_MS } from "../src/connected.js";

describe("netromSettings", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});

  it("uses the defaults when unset or not a number", () => {
    expect(netromSettings({})).toEqual({ broadcastMs: 3_600_000, pathQuality: 192 });
    expect(netromSettings({ NETROM_BROADCAST_MS: "soon", NETROM_PATH_QUALITY: "good" })).toEqual({
      broadcastMs: 3_600_000,
      pathQuality: 192,
    });
  });

  it("floors the broadcast interval", () => {
    expect(netromSettings({ NETROM_BROADCAST_MS: "1000" }).broadcastMs).toBe(NETROM_BROADCAST_MIN_MS);
    expect(netromSettings({ NETROM_BROADCAST_MS: "900000" }).broadcastMs).toBe(900_000);
  });

  it("clamps the path quality to 0–255", () => {
    expect(netromSettings({ NETROM_PATH_QUALITY: "999" }).pathQuality).toBe(255);
    expect(netromSettings({ NETROM_PATH_QUALITY: "-5" }).pathQuality).toBe(0);
    expect(netromSettings({ NETROM_PATH_QUALITY: "128" }).pathQuality).toBe(128);
  });
});

describe("startConnectedServices", () => {
  it("answers a flood of connects from forged calls with a bounded number of frames", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let sent = 0;
      const subs: ((b: Uint8Array) => void)[] = [];
      const link = {
        sendFrame: () => {
          sent++;
          return true;
        },
        onRaw: (cb: (b: Uint8Array) => void) => subs.push(cb),
        offRaw: () => {},
      };
      await startConnectedServices({
        link: link as unknown as Parameters<typeof startConnectedServices>[0]["link"],
        gwBase: "http://127.0.0.1:1",
        secret: "",
        env: { NETROM_CALL: "OE8APR-7", NETROM_ALIAS: "TEST" },
      });
      const before = sent;
      for (let i = 0; i < 2000; i++) {
        const call = "S" + i.toString(36).toUpperCase().padStart(5, "0");
        const b = encodeFrame({
          dst: { call: "OE8APR", ssid: 7 },
          src: { call, ssid: 0 },
          command: true,
          type: "SABM",
          pf: true,
        });
        for (const s of subs) s(b);
      }
      // each admitted session answers UA and the node's greeting; the rest get no answer at all
      expect(sent - before).toBeLessThanOrEqual(2 * MAX_SESSIONS_DEFAULT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the BBS's forwarding gate", () => {
  it("runs the F-protocol only for an enabled partner with the caller's exact call and SSID", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/bbs/partners"))
          return json({
            partners: [
              { call: "OE1AAA-5", enabled: true },
              { call: "OE2BBB", enabled: false },
            ],
          });
        if (url.includes("/api/bbs/forward/pool")) return json({ messages: [] });
        return json({ messages: [] });
      }),
    );
    try {
      const sent: { dst: { call: string; ssid: number }; type: string; info?: Uint8Array }[] = [];
      const subs: ((b: Uint8Array) => void)[] = [];
      const link = {
        sendFrame: (f: (typeof sent)[number]) => {
          sent.push(f);
          return true;
        },
        onRaw: (cb: (b: Uint8Array) => void) => subs.push(cb),
        offRaw: () => {},
      };
      await startConnectedServices({
        link: link as unknown as Parameters<typeof startConnectedServices>[0]["link"],
        gwBase: "http://gateway.invalid",
        secret: "s",
        env: { BBS_NODE_CALL: "OE8BBS" },
      });
      const bbs = { call: "OE8BBS", ssid: 0 };
      const settle = () => new Promise((r) => setTimeout(r, 20));
      const answer = async (call: string, ssid: number) => {
        const src = { call, ssid };
        for (const s of subs) s(encodeFrame({ dst: bbs, src, command: true, type: "SABM", pf: true }));
        await settle();
        const info = new TextEncoder().encode("[FBB-7.0-BFHM$]\r");
        for (const s of subs)
          s(encodeFrame({ dst: bbs, src, command: true, type: "I", pf: false, ns: 0, nr: 0, pid: 0xf0, info }));
        await settle();
        return sent
          .filter((f) => f.dst.call === call && f.dst.ssid === ssid && f.type === "I")
          .map((f) => new TextDecoder().decode(f.info))
          .join("");
      };
      const partner = await answer("OE1AAA", 5);
      expect(partner).toMatch(/\[ACG-[^\]]*\]/); // the session ran: the BBS greeted with its SID
      expect(partner).not.toContain("Not a forwarding partner");
      expect(await answer("OE1AAA", 6)).toContain("Not a forwarding partner"); // wrong SSID
      expect(await answer("OE2BBB", 0)).toContain("Not a forwarding partner"); // disabled
      expect(await answer("OE3CCC", 0)).toContain("Not a forwarding partner"); // not listed
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
