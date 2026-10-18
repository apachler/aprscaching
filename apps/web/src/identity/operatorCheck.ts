// SPDX-License-Identifier: AGPL-3.0-or-later

/** What the operator check knows: the account is this instance's sysop, its call awaits verification, it answered. */
export interface OperatorState {
  sysop: boolean;
  pending: boolean;
  known: boolean;
}

/**
 * Ask whether the signed-in account is this instance's operator. The answer belongs to the account it was
 * asked for: the surface starts hidden for every new check (another account, a switch to another call), and
 * the returned cancel drops an answer that lands after the session moved on. The server gates every sysop
 * write on its own; this only decides what the UI shows. Pure apart from `ask`.
 */
export function startOperatorCheck(
  signedIn: boolean,
  ask: () => Promise<{ sysop?: boolean; pending?: string }>,
  set: (s: OperatorState) => void,
): () => void {
  if (!signedIn) {
    set({ sysop: false, pending: false, known: true });
    return () => {};
  }
  let live = true;
  set({ sysop: false, pending: false, known: false });
  ask().then(
    (r) => {
      if (live) set({ sysop: !!r.sysop, pending: r.pending === "verify", known: true });
    },
    () => {
      if (live) set({ sysop: false, pending: false, known: true });
    },
  );
  return () => {
    live = false;
  };
}
