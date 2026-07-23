// SPDX-License-Identifier: MIT
/**
 * fedcompress.ts — the shared preset dictionary for the compact/beacon link tiers. Deflate with a
 * preset dictionary front-loads the vocabulary both ends already know, which is where the win is on
 * a 1200 Bd link: fedwire bodies repeat the same text keys and enum values in every record, and a
 * small page rarely repeats itself enough for plain deflate to learn them in-stream.
 *
 * The dictionary is DATA, versioned by id: both ends advertise `deflateDict1` in their LinkCaps and
 * negotiate it like any capability; a future vocabulary revision ships as `deflateDict2` beside it,
 * never mutating this one (the bytes are part of the wire contract — changing them breaks every
 * deployed link that negotiated the id). The deflate codec itself is runtime-owned and lives with
 * the link driver (the operator's ingest box — compact-tier RF links always terminate there).
 */

/** The capability id both ends advertise + negotiate (see LinkCaps in fedwire.ts). */
export const FED_DEFLATE_DICT_ID = "deflateDict1";

// zlib matches nearest-first, so the MOST frequent vocabulary sits at the END of the dictionary.
// Front: rarer enum values and JSON scaffolding (relay cargo travels as JSON text). Back: the body
// text keys every cache/find record carries.
const DICT_TEXT =
  // relay cargo scaffolding + feed page shape
  '{"ok":true,"kind":"feed","data":{"feed":"caches","since":0,"nextCursor":' +
  ',"complete":true,"items":[{"type":"cache","id":"' +
  '","cursor":,"data":{,"sig":"","signer":"' +
  // endpoint + peer vocabulary
  '"transport":"https","address":"http://","priority":' +
  '"transport":"44net","address":".ampr.org"' +
  "netrom bbs ax25 addresses instance publicKey callsign verified " +
  // record enum values
  "traditional virtual multi single living archived disabled dnf found webNotFound " +
  "accountMove tombstone bulletin targetId toInstance fromInstance postedAt expiresAt " +
  "fromCall toCall subject body bid " +
  // the per-record body keys (most frequent — nearest the end)
  "stationCall externalId minTrust fedScope description hint source status type title " +
  "ownerCall code createdAt updatedAt difficultyX10 terrainX10 distanceCm latE7 lonE7 ";

/** The `deflateDict1` preset dictionary bytes (immutable wire contract). */
export const FED_DEFLATE_DICT: Uint8Array = new TextEncoder().encode(DICT_TEXT);
