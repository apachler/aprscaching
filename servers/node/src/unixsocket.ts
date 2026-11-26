// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gateway's Unix socket (GATEWAY_SOCKET): the same gateway as the TCP port, on a filesystem path, for the
 * local callers that carry a secret — the operator's scripts (OPERATOR_SECRET) and the ingest on the same
 * machine (INGEST_SECRET). On Android every app with the INTERNET permission shares loopback and may bind
 * the gateway's TCP port while it is free (a restart, the boot delay), so a secret sent to 127.0.0.1 can
 * reach another app. A socket file in a directory only this user can open has no port to squat.
 *
 * Always a filesystem path: an abstract-namespace socket (a name starting with a NUL byte, or `@` as some
 * tools write it) has no file permissions and is reachable by every app on the device.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type http from "node:http";

/** Why `p` cannot be the gateway's socket, or null when it can. */
export function socketPathError(p: string): string | null {
  if (p.includes("\0") || p.startsWith("@"))
    return "GATEWAY_SOCKET must be a filesystem path, not an abstract socket name: every app can reach those";
  if (!path.isAbsolute(p)) return `GATEWAY_SOCKET must be an absolute path, not "${p}"`;
  // sockaddr_un holds 108 bytes with the terminating NUL; a longer path fails to bind with a vague error.
  if (Buffer.byteLength(p) > 107) return `GATEWAY_SOCKET is longer than 107 bytes: ${p}`;
  return null;
}

/**
 * The socket's directory exists, is a real directory (not a link) owned by this user, and has mode 0700, so
 * no other user can open the socket or put a file of their own at its path. Throws when it cannot be made so.
 */
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error(`${dir} belongs to another user (uid ${st.uid})`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Clear the path for a new listener: nothing there, or a socket file nobody answers on (left by a gateway that
 * was killed) is removed. A socket a process still answers on, or anything other than a socket, stays, and
 * the start fails: a second gateway must not take the first one's socket, nor a typo delete a file.
 */
async function clearStale(p: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${p} exists and is not a socket; it is left as it is`);
  const answered = await new Promise<boolean>((resolve) => {
    const c = net.connect({ path: p });
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
  if (answered) throw new Error(`another process listens on ${p}`);
  fs.unlinkSync(p);
}

/** Listen on the socket at `p`: its private directory, a stale file cleared, the file itself 0600. */
export async function listenUnix(server: http.Server, p: string): Promise<void> {
  const problem = socketPathError(p);
  if (problem) throw new Error(problem);
  privateDir(path.dirname(p));
  await clearStale(p);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(p, 0o600);
}
