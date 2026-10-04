// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { updateCache, type CacheDetail, type UpdateCacheRequest } from "../api.js";
import { maidenhead, parseCoordinates } from "../map/geo.js";
import { Button, Panel, Row, Switch, Segmented, useToast, useConfirm } from "../ui/index.js";
import { TEXT_LIMITS, type CacheStatus, type FedScope, type RatingPolicy } from "@aprscaching/shared";
import { parseTags, refusalMessage, tagProblem } from "./formLimits.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { StagesEditor } from "./StagesEditor.js";
import { CountrySelect } from "./CountrySelect.js";

const STATUSES: { v: CacheStatus; label: string; help: string }[] = [
  { v: "active", label: "Active", help: "On the map and takes finds." },
  { v: "disabled", label: "Disabled", help: "Stays on the map, takes no finds: for a cache that needs repair." },
  { v: "archived", label: "Archived", help: "Off the map, takes no finds: for a cache that is gone." },
];
const SCOPES: { v: FedScope; label: string; help: string }[] = [
  { v: "public", label: "Public", help: "On the map, in search and shared with the network." },
  { v: "unlisted", label: "Unlisted", help: "Off maps and search; anyone with its link or code still opens it." },
  { v: "local-only", label: "Local only", help: "Listed here, never shared with the network." },
];

/** The fields the form edits, as the cache has them now. */
function fromDetail(c: CacheDetail) {
  return {
    title: c.title,
    status: c.status,
    difficulty: c.difficulty,
    terrain: c.terrain,
    hint: c.hint ?? "",
    description: c.description ?? "",
    driveIn: c.driveIn,
    country: c.country ?? "",
    tags: c.tags.join(", "),
    radioOnly: c.own?.minTrust === "A",
    ratingPolicy: c.rating.policy,
    fedScope: c.fedScope,
    rendezvous: !!c.own?.rendezvous,
  };
}

/**
 * Edit a cache — its owner's form, grouped as the hide form is: basics and status, location, details, then
 * verification, rating and sharing, and the stages. Only what changed is sent. Archiving asks first.
 */
export function EditCachePanel(props: { detail: CacheDetail; onClose: () => void; onSaved: () => void }) {
  const c = props.detail;
  const { callsign } = usePlatform();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const start = fromDetail(c);
  const [f, setF] = useState(start);
  const set = <K extends keyof typeof start>(k: K, v: (typeof start)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [moveTo, setMoveTo] = useState("");
  const [moveErr, setMoveErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const living = c.type === "aprs_living";
  const staged = c.type === "multi" || c.type === "audio" || c.stageCount > 0;

  const tagList = parseTags;
  const tagErr = tagProblem(tagList(f.tags));

  /** What changed, as the API takes it. */
  function changes(): UpdateCacheRequest | null {
    const b: UpdateCacheRequest = {};
    if (f.title.trim() !== start.title) b.title = f.title.trim();
    if (f.status !== start.status) b.status = f.status;
    if (f.difficulty !== start.difficulty) b.difficulty = f.difficulty;
    if (f.terrain !== start.terrain) b.terrain = f.terrain;
    if (f.hint !== start.hint) b.hint = f.hint.trim();
    if (f.description !== start.description) b.description = f.description.trim();
    if (f.driveIn !== start.driveIn) b.driveIn = f.driveIn;
    if (f.country !== start.country) b.country = f.country;
    if (tagList(f.tags).join(",") !== tagList(start.tags).join(",")) b.tags = tagList(f.tags);
    if (f.radioOnly !== start.radioOnly) b.minTrust = f.radioOnly ? "A" : null;
    if (f.ratingPolicy !== start.ratingPolicy) b.ratingPolicy = f.ratingPolicy;
    if (f.fedScope !== start.fedScope) b.fedScope = f.fedScope;
    if (living && f.rendezvous !== start.rendezvous) b.rendezvous = f.rendezvous;
    if (moveTo.trim()) {
      const at = parseCoordinates(moveTo);
      if (!at) return null;
      b.lat = +at.lat.toFixed(6);
      b.lon = +at.lon.toFixed(6);
    }
    return b;
  }

  async function save() {
    const b = changes();
    if (!b) {
      setMoveErr(true);
      return;
    }
    if (!f.title.trim()) {
      setErr("A cache needs a title.");
      return;
    }
    if (tagErr) {
      setErr(tagErr);
      return;
    }
    if (Object.keys(b).length === 0) {
      props.onClose();
      return;
    }
    if (
      b.status === "archived" &&
      !(await confirmDialog({
        title: `Archive ${c.code}?`,
        message: "It leaves the map and takes no more finds. You can set it active again here.",
        confirmLabel: "Archive",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      await updateCache(c.id, b);
      toast(`${c.code} saved`);
      props.onSaved();
    } catch (e) {
      setErr(refusalMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={`Edit ${c.code}`} onClose={props.onClose}>
      <h4 className="set-subh">Basics</h4>
      <label>
        Title
        <input value={f.title} maxLength={TEXT_LIMITS.title} onChange={(e) => set("title", e.target.value)} />
      </label>
      <Segmented
        label="Status"
        look="chips"
        value={f.status}
        onChange={(v) => set("status", v)}
        options={STATUSES.map((s) => ({ value: s.v, label: s.label }))}
      />
      <p className="muted fine">{STATUSES.find((s) => s.v === f.status)?.help}</p>
      <div className="row">
        <label>
          Difficulty {f.difficulty.toFixed(1)}
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={f.difficulty}
            onChange={(e) => set("difficulty", +e.target.value)}
          />
        </label>
        <label>
          Terrain {f.terrain.toFixed(1)}
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={f.terrain}
            onChange={(e) => set("terrain", +e.target.value)}
          />
        </label>
      </div>

      {!living && (
        <>
          <h4 className="set-subh">Location</h4>
          {c.lat != null && c.lon != null && (
            <p className="muted">
              Now at{" "}
              <code>
                {c.lat.toFixed(5)}, {c.lon.toFixed(5)}
              </code>{" "}
              · grid <code>{maidenhead(c.lat, c.lon, 10)}</code>
            </p>
          )}
          <label>
            Move to <span className="muted">(optional)</span>
            <input
              value={moveTo}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="47.07355, 15.43785 or JN77rb"
              aria-invalid={moveErr || undefined}
              aria-describedby="edit-move-help"
              onChange={(e) => {
                setMoveTo(e.target.value);
                setMoveErr(false);
              }}
            />
          </label>
          <p id="edit-move-help" className={moveErr ? "error fine" : "muted fine"}>
            {moveErr
              ? "Not a coordinate. Type decimal degrees (lat, lon) or a Maidenhead locator."
              : "Decimal degrees (lat, lon) or a Maidenhead locator. Leave it empty to keep the cache where it is."}
          </p>
        </>
      )}

      <h4 className="set-subh">
        Details <span className="muted fw-normal">· all optional</span>
      </h4>
      <label>
        Hint
        <input value={f.hint} maxLength={TEXT_LIMITS.hint} onChange={(e) => set("hint", e.target.value)} />
      </label>
      <label>
        Description
        <textarea
          value={f.description}
          rows={3}
          maxLength={TEXT_LIMITS.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </label>
      <Row label="Drive-in (car-accessible)">
        <Switch label="Drive-in" checked={f.driveIn} onChange={(v) => set("driveIn", v)} />
      </Row>
      <div className="row">
        <CountrySelect value={f.country} onChange={(v) => set("country", v)} />
        <label>
          Tags
          <input
            value={f.tags}
            onChange={(e) => set("tags", e.target.value)}
            placeholder="scenic, family, qrp"
            aria-invalid={!!tagErr}
            aria-describedby={tagErr ? "edit-tags-err" : undefined}
          />
        </label>
      </div>
      {tagErr && (
        <p className="error fine" id="edit-tags-err">
          {tagErr}
        </p>
      )}

      <h4 className="set-subh">Verification, rating &amp; sharing</h4>
      <Row
        label="Radio-verified finds only"
        help="A find counts as verified only when a receiving station heard the finder there. Off: this instance's minimum applies."
      >
        <Switch label="Radio-verified finds only" checked={f.radioOnly} onChange={(v) => set("radioOnly", v)} />
      </Row>
      {living && (
        <Row label="Log rendezvous when I meet other living caches">
          <Switch label="Log rendezvous" checked={f.rendezvous} onChange={(v) => set("rendezvous", v)} />
        </Row>
      )}
      <label>
        Who can rate
        <select value={f.ratingPolicy} onChange={(e) => set("ratingPolicy", e.target.value as RatingPolicy)}>
          <option value="finders">Finders only</option>
          <option value="all">Anyone signed in</option>
          <option value="off">Nobody (disabled)</option>
        </select>
      </label>
      <Segmented
        label="Federation scope"
        look="chips"
        value={f.fedScope}
        onChange={(v) => set("fedScope", v)}
        options={SCOPES.map((s) => ({ value: s.v, label: s.label }))}
      />
      <p className="muted fine">{SCOPES.find((s) => s.v === f.fedScope)?.help} The hint is never shared.</p>

      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row end">
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || callsign.length < 3} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>

      {staged && (
        <StagesEditor
          cacheId={c.id}
          ownerCall={callsign}
          start={c.lat != null && c.lon != null ? { lat: c.lat, lon: c.lon } : null}
        />
      )}
    </Panel>
  );
}
