// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A guard for runs that may overlap where only the newest may write its result. Each call starts a run and
 * returns a check that stays true until the next run starts: requests settle in arrival order, so without
 * it a slow answer to an earlier run replaces a newer one. Pure.
 */
export function latestOnly(): () => () => boolean {
  let seq = 0;
  return () => {
    const mine = ++seq;
    return () => mine === seq;
  };
}

/** A gate that lets one call through per `ms`, so a notice repeated by every pan shows once. Pure. */
export function onceEvery(ms: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < ms) return false;
    last = t;
    return true;
  };
}
