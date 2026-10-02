// SPDX-License-Identifier: AGPL-3.0-or-later
import { Sheet } from "../ui/index.js";
import { SearchSuggest } from "./SearchSuggest.js";
import type { SearchHitCache, SearchHitStation } from "@aprscaching/shared";

/**
 * Search on a narrow screen, where the top bar has no room for the field: a sheet from the top with the same search
 * (caches, stations, a grid locator). Picking a result closes it and flies the map there.
 */
export function SearchSheet(props: {
  q: string;
  onSearch: (v: string) => void;
  onSearchSubmit: (v: string) => void;
  onPickCache: (hit: SearchHitCache) => void;
  onPickStation: (hit: SearchHitStation) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Search" edge="top" onClose={props.onClose} showTitle={false}>
      <SearchSuggest
        idBase="sheet-search"
        className="in-sheet"
        autoFocus
        q={props.q}
        onChange={props.onSearch}
        onSubmitRaw={(v) => {
          props.onSearchSubmit(v);
          props.onClose();
        }}
        onPickCache={(h) => {
          props.onPickCache(h);
          props.onClose();
        }}
        onPickStation={(h) => {
          props.onPickStation(h);
          props.onClose();
        }}
      />
    </Sheet>
  );
}
