// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * federation_sync.ts — the federation consumer surface in one import: pulling peers (fedpull.ts),
 * admitting and applying signed frames (fedapply.ts), the peer table (fedpeers.ts) and push-to-hub
 * (fedpush.ts). Published as `@aprscaching/gateway/federation_sync`.
 */
export { MAX_PAGES, syncAllPeers, syncPeerByInstance, negotiateFeeds, handleFederationSync } from "./fedpull.js";
export { coalesceRun, newCoalescer, type Coalescer } from "./fedpull.js";
export {
  admitFrame,
  applyFrames,
  applyFedFrames,
  applyFedBbsBulletin,
  idInNamespace,
  upsertRemoteCache,
  upsertRemoteFind,
  type FrameGate,
  type FrameVerdict,
  type FedBbsApplyResult,
  type FedFramesResult,
} from "./fedapply.js";
export {
  TRUST_LEVELS,
  type TrustLevel,
  listEnabledPeers,
  keysForOrigin,
  handleFederationPeers,
  handlePeerTrust,
} from "./fedpeers.js";
export { handleFederationSubmit, pushToHub } from "./fedpush.js";
