// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { addExclusion, liftExclusion, listExclusions, previewExclusion } from "../moderation/api.js";
import {
  EXCLUSION_CATEGORIES,
  exclusionCall,
  exclusionCategoryLabel,
  purgeLines,
  type ExclusionCategory,
} from "../moderation/logic.js";
import { useFmt } from "../format.js";
import { Badge, Button, EmptyState, ErrorState, useConfirm, useLoad, useToast } from "../ui/index.js";

/**
 * Excluded stations, for the sysop: a licensee who objects to the processing of their station's on-air data
 * (GDPR Art. 21) is kept out by base call, with every SSID. Adding one purges the station's stored rows, so the
 * confirm dialog first says what goes, and warns when a member holds the call: their account and finds stay, and
 * erasing them is the member's own tool. Every route behind it is sysop-gated on the server.
 */
export function ExclusionsAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const [typed, setTyped] = useState("");
  const [category, setCategory] = useState<ExclusionCategory>("objection");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useLoad(() => listExclusions(), []);

  const add = async () => {
    const call = exclusionCall(typed);
    if (!call) {
      setError("Enter a callsign, such as OE1ABC. An SSID is dropped: the exclusion covers every SSID.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const p = await previewExclusion(call);
      if (p.excluded) {
        setError(`${call} is already excluded.`);
        return;
      }
      const lines = purgeLines(p.counts);
      const ok = await confirmDialog({
        title: `Exclude ${call}?`,
        message: (
          <>
            <p>
              Nothing <span className="mono">{call}</span> sends under any SSID is stored or shown from now on, and this
              deletes what the instance holds of its own transmissions:
            </p>
            {lines.length ? (
              <ul>
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing stored yet.</p>
            )}
            <p className="muted fine">
              Other stations&apos; packets that name it in their path or as an addressee stay. The deletion cannot be
              undone.
            </p>
            {p.held && (
              <p className="inline-note bad" role="alert">
                An account here holds <span className="mono">{call}</span>. Its account, finds and caches stay, but its
                station leaves the map and its finds can no longer be verified by what this instance hears of it.
                Erasing the account is the member&apos;s own tool.
              </p>
            )}
          </>
        ),
        confirmLabel: "Exclude and delete",
        danger: true,
      });
      if (!ok) return;
      await addExclusion(call, category);
      toast(`${call} excluded`);
      setTyped("");
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const lift = async (call: string) => {
    if (
      !(await confirmDialog({
        title: `Lift the exclusion of ${call}?`,
        message: "What the instance hears from this station is stored and shown again. Deleted rows do not come back.",
        confirmLabel: "Lift exclusion",
      }))
    )
      return;
    try {
      await liftExclusion(call);
      toast(`${call} is no longer excluded`);
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const rows = list.data?.exclusions;
  return (
    <>
      <form
        className="partner-form"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label>
          Callsign
          <input
            className="mono"
            value={typed}
            placeholder="OE1ABC"
            spellCheck={false}
            autoCapitalize="characters"
            aria-describedby="exclusion-help"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        <label>
          Reason
          <select value={category} onChange={(e) => setCategory(e.target.value as ExclusionCategory)}>
            {EXCLUSION_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <p id="exclusion-help" className="muted fine">
          Covers every SSID of the call. The instance keeps only the call, the reason and the date, to honour the
          objection.
        </p>
        {error && (
          <p className="error fine" role="alert">
            {error}
          </p>
        )}
        <div className="row end">
          <Button type="submit" variant="danger" disabled={busy || !typed.trim()}>
            {busy ? "Checking…" : "Exclude…"}
          </Button>
        </div>
      </form>
      {list.error ? (
        <ErrorState onRetry={list.reload}>Couldn&apos;t load the excluded stations.</ErrorState>
      ) : rows === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState>No station is excluded. Add one when its licensee objects.</EmptyState>
      ) : (
        <ul className="logs">
          {rows.map((r) => (
            <li key={r.callsign}>
              <div className="row between">
                <span>
                  <span className="mono">{r.callsign}</span> <Badge>{exclusionCategoryLabel(r.category)}</Badge>{" "}
                  {r.held && (
                    <Badge kind="warn" title="An account here holds this call">
                      account
                    </Badge>
                  )}
                </span>
                <Button
                  variant="inline-danger"
                  aria-label={`Lift the exclusion of ${r.callsign}`}
                  onClick={() => void lift(r.callsign)}
                >
                  Lift
                </Button>
              </div>
              <div className="muted fine">
                excluded {fmt.date(r.createdAt)}
                {r.createdBy ? (
                  <>
                    {" "}
                    by <span className="mono">{r.createdBy}</span>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
