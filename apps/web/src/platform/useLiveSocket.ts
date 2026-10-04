// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "../api.js";

/**
 * The live WebSocket: geofence prompts ("you're near a cache") and live station deltas.
 *
 * It reconnects on close/error with exponential backoff plus jitter, so a server restart or a network
 * blip does not silently stop live features until the page is reloaded. The retry timer is local to
 * the effect and cleared on cleanup; `stopped` keeps a reconnect from racing the unmount. `onOpen`
 * runs on every (re)connect with `send`, so the caller re-subscribes; `send` drops a message while
 * disconnected.
 */
/**
 * The live socket's absolute ws(s):// URL. The WebSocket constructor takes no relative URL in every browser, so an
 * empty API base (the API on the page's own origin) resolves against the page.
 */
export function liveSocketUrl(apiBase: string, page: { href: string }): string {
  const url = new URL(`${apiBase}/ws?region=global`, page.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function useLiveSocket(handlers: {
  onOpen: (send: (msg: unknown) => void) => void;
  onMessage: (msg: unknown) => void;
}): { send: (msg: unknown) => void } {
  const ws = useRef<WebSocket | null>(null);
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  const send = useCallback((msg: unknown) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retryMs = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      const delay = Math.min(retryMs, 30_000) * (0.5 + Math.random());
      retryMs = Math.min(retryMs * 2, 30_000);
      reconnectTimer = setTimeout(connect, delay);
    };
    const connect = () => {
      if (stopped) return;
      let s: WebSocket;
      try {
        s = new WebSocket(liveSocketUrl(API_BASE, location));
      } catch {
        // a URL the browser refuses, or a socket it will not open now: try again later, like a dropped one
        retry();
        return;
      }
      ws.current = s;
      s.addEventListener("open", () => {
        retryMs = 1000; // reachable again → reset the backoff
        h.current.onOpen(send);
      });
      s.addEventListener("message", (e) => {
        try {
          h.current.onMessage(JSON.parse(e.data));
        } catch {
          /* a malformed frame is dropped */
        }
      });
      s.addEventListener("error", () => {
        try {
          s.close();
        } catch {
          /* close → schedules the reconnect */
        }
      });
      s.addEventListener("close", () => {
        if (stopped || ws.current !== s) return;
        ws.current = null;
        retry();
      });
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws.current?.close();
      } catch {
        /* */
      }
      ws.current = null;
    };
  }, [send]);

  return { send };
}
