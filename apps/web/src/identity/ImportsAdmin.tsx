// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { listImportedPlaces, removeImportedPlace, type ImportedPlace } from "../api.js";
import { useFmt } from "../format.js";
import { Badge, Button, EmptyState, ErrorState, useConfirm, useLoad, useToast } from "../ui/index.js";

/**
 * Imported places, for the sysop: find one by code, title or listing id, and remove it when its source or the
 * listing's owner asks (OpenCaching's terms provide for that). A removed listing stays out of every later import.
 * Imports themselves run from a script with the operator secret (Import heritage places in the manual).
 */
export function ImportsAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const list = useLoad(() => listImportedPlaces(query), [query]);

  const remove = async (p: ImportedPlace) => {
    if (
      !(await confirmDialog({
        title: `Remove ${p.code}?`,
        message: `"${p.title}" leaves this instance with its logs, ratings and media, and later imports of ${p.sourceName ?? p.source} skip it.`,
        confirmLabel: "Remove listing",
        danger: true,
      }))
    )
      return;
    try {
      await removeImportedPlace(p.id, note.trim());
      toast(`${p.code} removed`);
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const places = list.data?.places;
  const removed = list.data?.removed ?? [];
  return (
    <>
      <form
        className="partner-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(typed.trim());
        }}
      >
        <label>
          Find a place
          <input
            value={typed}
            placeholder="OC1234, a title or a reference"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <label>
          Reason for a removal (optional)
          <input
            value={note}
            maxLength={200}
            placeholder="Owner asked by mail, 2026-10-04"
            aria-describedby="import-note-help"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p id="import-note-help" className="muted fine">
          Kept with the removed listing, so you can answer the source later.
        </p>
        <div className="row end">
          <Button type="submit">Search</Button>
        </div>
      </form>
      {list.error ? (
        <ErrorState onRetry={list.reload}>Couldn&apos;t load the imported places.</ErrorState>
      ) : places === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : places.length === 0 ? (
        <EmptyState>
          {query ? "No imported place matches." : "No imported places yet. Run an import from a script first."}
        </EmptyState>
      ) : (
        <ul className="logs">
          {places.map((p) => (
            <li key={p.id}>
              <span className="mono">{p.code}</span> {p.title} <Badge>{p.sourceName ?? p.source}</Badge>
              {p.status === "archived" && <span className="muted"> · archived</span>}
              <Button variant="inline-danger" aria-label={`Remove ${p.code}`} onClick={() => void remove(p)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {removed.length > 0 && (
        <>
          <h4 className="set-subh">Removed listings</h4>
          <ul className="logs">
            {removed.map((r) => (
              <li key={`${r.source}-${r.externalId}`}>
                <span className="mono">{r.code ?? r.externalId}</span> <Badge>{r.source}</Badge>
                <div className="comment">
                  removed {fmt.date(r.removedAt)}
                  {r.note ? ` · ${r.note}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
