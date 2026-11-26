// SPDX-License-Identifier: AGPL-3.0-or-later
// Where the operator tools (signin-link.mjs, verify-call.mjs, mail-test.mjs) reach the gateway, and the one
// request they send it with the operator secret.
//
//   BASE             a gateway URL; set, it wins.
//   GATEWAY_SOCKET   the gateway's Unix socket (a Pocket station's .env sets it): the request goes through
//                    that file and never to a TCP port. On a phone every app shares loopback and may hold
//                    the gateway's port while it is free, so a secret sent to 127.0.0.1 can reach another app.
//   otherwise        the gateway on this host, http://127.0.0.1:$PORT (PORT defaulting to 8787).
import http from "node:http";

const SOCKET = process.env.BASE ? "" : (process.env.GATEWAY_SOCKET ?? "").trim();

/** The gateway as the tools name it in a message: its URL, or the socket's path. */
export const GATEWAY = SOCKET
  ? `the gateway's socket ${SOCKET}`
  : (process.env.BASE ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, "");

/** POST a JSON body to `path` with the operator secret; resolves to a Web Response. */
export function operatorPost(path, secret, body) {
  const headers = { "content-type": "application/json", "x-operator-secret": secret };
  const payload = JSON.stringify(body);
  if (!SOCKET) return fetch(`${GATEWAY}${path}`, { method: "POST", headers, body: payload });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path, method: "POST", headers: { ...headers, host: "localhost" } });
    req.setTimeout(30_000, () => req.destroy(new Error("no answer in 30 s")));
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 502;
        // a Response refuses a body on a null-body status
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status }));
      });
    });
    req.end(payload);
  });
}
