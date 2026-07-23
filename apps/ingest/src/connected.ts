// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * connected.ts — the connected-mode service stack over ONE frame link. The NET/ROM node
 * (NODES broadcasts + inbound circuits + connect-through), the session server answering AX.25
 * connects to the NODE and BBS callsigns, and the FBB forwarding scheduler all share whichever pipe
 * the operator has: a KISS TNC on RF, or an AXUDP port on the Internet leg (the interop environment
 * and BPQ/FBB crosslinks). Wiring only — every engine is the same pure code either way.
 */
import { SessionServer, type Service } from "@aprscaching/packet";
import { parseAddr } from "@aprscaching/ax25";
import type { FrameLink } from "./link.js";

export interface ConnectedStackOpts {
  link: FrameLink;
  gwBase: string;
  secret: string;
  env: NodeJS.ProcessEnv;
}

/** Wire the NET/ROM node + BBS services onto the link per env config. Returns true when anything started. */
export async function startConnectedServices(o: ConnectedStackOpts): Promise<boolean> {
  const { link, gwBase, secret, env } = o;
  const services: Service[] = [];
  const users = new Set<string>();

  if (env.NETROM_CALL && env.NETROM_ALIAS) {
    const { NetromNodeRunner } = await import("./netromnode.js");
    const node = new NetromNodeRunner(link, {
      mycall: env.NETROM_CALL,
      alias: env.NETROM_ALIAS,
      broadcastMs: env.NETROM_BROADCAST_MS ? Number(env.NETROM_BROADCAST_MS) : undefined,
      pathQuality: env.NETROM_PATH_QUALITY ? Number(env.NETROM_PATH_QUALITY) : undefined,
      inp3: env.NETROM_INP3 === "1",
      gatewayBase: gwBase,
      secret,
    });
    link.onRaw((b) => node.onRaw(b));
    node.start();
    // NODE_PERSONALITY picks the command surface (netrom | flexnet | tnn | baycom) — one routing
    // brain, the operator's preferred conversation.
    const { makeNodeSession } = await import("@aprscaching/packet");
    const nodeApp = (r: import("@aprscaching/ax25").Ax25Address) =>
      makeNodeSession(
        env.NODE_PERSONALITY,
        r.call,
        node.nodeStore(() => [...users]),
        env.NETROM_ALIAS!,
        env.NETROM_CALL!,
      );
    services.push({
      addr: parseAddr(env.NETROM_CALL),
      name: "NODE",
      app: nodeApp,
      onConnect: node.connectThrough(),
      // a neighbour node's L2 session multiplexes NET/ROM network packets (PID 0xCF) with the
      // plain-text CLI — BPQ runs its L4 circuits over the inter-node link, never as UI
      onNetrom: (packet, remote, sendNetrom) => node.onLinkNetrom(remote, packet, sendNetrom),
    });
    node.serveInbound(nodeApp); // also answer stations that connect a NET/ROM circuit TO us (L4 inbound)
    console.log(`[netrom] node CLI answering inbound connects on ${env.NETROM_CALL}`);
  }

  if (env.BBS_NODE_CALL) {
    const { gatewayBbsBackend, GatewayApi } = await import("./forwarder.js");
    const { CachedBbsStore, BbsSession, FbbGatedBbs, SessionStore } = await import("@aprscaching/packet");
    const backend = gatewayBbsBackend(gwBase, secret);
    const fwdApi = new GatewayApi(gwBase, secret);
    services.push({
      addr: parseAddr(env.BBS_NODE_CALL),
      name: "BBS",
      app: async (r) => {
        const store = new CachedBbsStore(r.call, backend);
        await store.refresh();
        const interactive = new BbsSession(r.call, store, env.BBS_NODE_CALL!);
        // A forwarding peer (FBB/BPQ/our scheduler) dialling this callsign answers the greeting SID
        // with its own — the gate then runs the F-protocol responder: accept its proposals into the
        // gateway (BID-deduped) and reverse-forward whatever the pool has routed to that peer.
        return new FbbGatedBbs(interactive, {
          makeStore: async () => new SessionStore(await fwdApi.pool(r.call), []),
          onSessionEnd: async (s) => {
            const st = s as InstanceType<typeof SessionStore>;
            for (const m of st.inbox) await fwdApi.inbound(m, `rf-fbb:${r.call}`);
            if (st.sentBids.length) await fwdApi.markSent(r.call, st.sentBids);
          },
        });
      },
    });
    console.log(`[bbs] BBS answering inbound connects on ${env.BBS_NODE_CALL} (FBB forwarding gate armed)`);
  }

  if (services.length) {
    const server = new SessionServer({
      send: (f) => {
        link.sendFrame(f);
      },
      services,
      onEvent: (e) => {
        console.log(`[l2] ${e.kind}: ${e.remote} -> ${e.service}`);
        if (e.kind === "connect") users.add(e.remote);
        else if (e.kind === "disconnect") users.delete(e.remote);
      },
    });
    link.onRaw((b) => server.onRaw(b));
    setInterval(() => server.poll(), 1000);
  }
  return services.length > 0;
}
