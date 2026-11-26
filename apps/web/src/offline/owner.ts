// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A player's private offline data on a shared device: the owner maintenance pack (every cache they own, unlisted
 * and local-only ones too) and the stage reveals they opened offline. Each is kept under the signed-in call the
 * offline queue is kept for (`acs.sync.owner`, written by api.ts `setQueueOwner`), read only while that call is
 * the stored owner, and deleted when the player signs out or another player signs in. Area packs hold only public
 * caches and stay for whoever uses the device next.
 */
import type { PackCache, StagePayload } from "@aprscaching/shared";
import type { OfflineStore, PackMeta } from "./store.js";

/** The signed-in call the queue and the private data belong to; the service worker reads the same key. */
export const OWNER_KEY = "acs.sync.owner";
const REVEALS_KEY = "acs.stages.unlocked";

const norm = (call: string | null | undefined) => call?.trim().toUpperCase() || null;

/** The stored owner, or null when no player is known (signed out, or a session the server no longer answers for). */
export async function storedOwner(store: OfflineStore): Promise<string | null> {
  return norm(await store.kvGet(OWNER_KEY));
}

/** A pack only its owner may read: the owner maintenance pack. */
export const isPrivatePack = (p: Pick<PackMeta, "area">) => !!p.area && "mine" in p.area;

/** The packs this device shows now: every public pack, and a private one only to the owner it was stored for. */
export async function shownPacks(store: OfflineStore): Promise<PackMeta[]> {
  const owner = await storedOwner(store);
  return (await store.packs()).filter((p) => !isPrivatePack(p) || (owner != null && norm(p.owner) === owner));
}

/** A pack's caches, read only when the pack is shown now: a list held since another player signed in reads none. */
export async function shownPackCaches(store: OfflineStore, packId: string): Promise<PackCache[]> {
  return (await shownPacks(store)).some((p) => p.id === packId) ? store.packCaches(packId) : [];
}

/** Stage reveals opened offline, keyed `cacheId:stageNo`, with the call they were opened under. */
interface Reveals {
  owner: string;
  unlocks: Record<string, StagePayload>;
}
async function readReveals(store: OfflineStore): Promise<Reveals | null> {
  try {
    const r = JSON.parse((await store.kvGet(REVEALS_KEY)) || "null") as Partial<Reveals> | null;
    return r && typeof r.owner === "string" && r.unlocks && typeof r.unlocks === "object" ? (r as Reveals) : null;
  } catch {
    return null;
  }
}

/** The stored owner's stage reveals; none with no owner known, and none of another player's. */
export async function ownReveals(store: OfflineStore): Promise<Record<string, StagePayload>> {
  const owner = await storedOwner(store);
  const r = await readReveals(store);
  return owner && r && norm(r.owner) === owner ? r.unlocks : {};
}

/** Keep a stage reveal for `owner`; another player's reveals on the device are replaced, never merged. */
export async function keepReveal(store: OfflineStore, owner: string, key: string, payload: StagePayload) {
  const r = await readReveals(store);
  const unlocks = r && norm(r.owner) === norm(owner) ? r.unlocks : {};
  unlocks[key] = payload;
  await store.kvSet(REVEALS_KEY, JSON.stringify({ owner: norm(owner), unlocks }));
}

/**
 * Delete every player's private data except `keep`'s: with `keep` null (a sign-out), all of it. The packs go with
 * their caches and images, so nothing of theirs is left to read from the device, not merely hidden.
 */
export async function forgetPrivateData(store: OfflineStore, keep: string | null): Promise<void> {
  const kept = norm(keep);
  for (const p of await store.packs()) if (isPrivatePack(p) && norm(p.owner) !== kept) await store.deletePack(p.id);
  const r = await readReveals(store);
  if (r ? norm(r.owner) !== kept : await store.kvGet(REVEALS_KEY)) await store.kvSet(REVEALS_KEY, "");
}
