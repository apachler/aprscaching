// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { createCache, type CacheSummary } from "../api.js";
import { TYPE_ORDER, TYPE_META } from "../cacheTypes.js";
import { maidenhead } from "../map/geo.js";
import { Panel, Row, Switch, Advanced } from "../ui/index.js";
import type { CacheType, FedScope } from "@aprscaching/shared";
import { usePlatform } from "../platform/PlatformContext.js";

const SCOPES: { v: FedScope; label: string; help: string }[] = [
  { v: "public", label: "Public", help: "Shared across the whole network." },
  { v: "unlisted", label: "Unlisted", help: "On the network map, but its description stays on this instance." },
  { v: "local-only", label: "Local only", help: "Never leaves this instance." },
];

/** A phone or tablet: the hider is usually standing at the spot, so the pin starts at the device fix. */
const touchFirst = (): boolean => window.matchMedia?.("(pointer: coarse)").matches ?? false;

/**
 * Hide a cache — sectioned form: location, basics, difficulty/terrain, and the optional details plus
 * rating/federation under Advanced. Submit is gated on a dropped pin + title + callsign.
 */
export function HidePanel(props: {
  draft: { lat: number; lon: number } | null;
  /** Drop the pin at a position (and bring the map there). */
  onPlace: (lat: number, lon: number) => void;
  onCancel: () => void;
  onCreated: (c: CacheSummary) => void;
}) {
  const { callsign } = usePlatform();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CacheType>("traditional");
  const [difficulty, setDifficulty] = useState(1.5);
  const [terrain, setTerrain] = useState(1.5);
  const [hint, setHint] = useState("");
  const [description, setDescription] = useState("");
  const [stationCall, setStationCall] = useState("");
  const [driveIn, setDriveIn] = useState(false);
  const [country, setCountry] = useState("");
  const [tags, setTags] = useState("");
  const [ratingPolicy, setRatingPolicy] = useState<"finders" | "all" | "off">("finders");
  const [rendezvous, setRendezvous] = useState(false);
  const [fedScope, setFedScope] = useState<FedScope>("public");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locErr, setLocErr] = useState<string | null>(null);
  const canLocate = typeof navigator !== "undefined" && !!navigator.geolocation;

  // the latest callbacks, so the one-shot auto-locate below never pins with a stale closure
  const placeRef = useRef(props.onPlace);
  placeRef.current = props.onPlace;
  const hasDraft = useRef(!!props.draft);
  hasDraft.current = !!props.draft;

  function locate(auto = false) {
    if (!navigator.geolocation) return;
    setLocating(true);
    setLocErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLocating(false);
        // a pin the hider already dropped by hand wins over a late automatic fix
        if (auto && hasDraft.current) return;
        placeRef.current(+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6));
      },
      (e) => {
        setLocating(false);
        if (!auto || e.code !== e.PERMISSION_DENIED)
          setLocErr(
            e.code === e.PERMISSION_DENIED
              ? "Location access is blocked — allow it in the browser, or tap the map instead."
              : "Couldn't get a location fix — tap the map instead.",
          );
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }
  useEffect(() => {
    if (touchFirst() && !hasDraft.current) locate(true);
  }, []);

  const ready = !!props.draft && title.trim().length > 0 && callsign.length >= 3;

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);

  async function submit() {
    if (!props.draft) return;
    setBusy(true);
    setErr(null);
    try {
      const { cache } = await createCache({
        title: title.trim(),
        type,
        difficulty,
        terrain,
        lat: props.draft.lat,
        lon: props.draft.lon,
        ownerCall: callsign,
        hint: hint.trim() || undefined,
        description: description.trim() || undefined,
        fedScope,
        stationCall: type === "aprs_living" ? stationCall.trim().toUpperCase() || undefined : undefined,
        driveIn: driveIn || undefined,
        country: country.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
        ratingPolicy,
        rendezvous: type === "aprs_living" ? rendezvous : undefined,
      });
      props.onCreated(cache);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel side="left" title="Hide a cache">
      <h4 className="set-subh">Location</h4>
      <p className="muted" role="status" aria-live="polite">
        {locating ? (
          "Getting your location…"
        ) : props.draft ? (
          <>
            Pin at{" "}
            <code>
              {props.draft.lat.toFixed(5)}, {props.draft.lon.toFixed(5)}
            </code>{" "}
            · grid <code>{maidenhead(props.draft.lat, props.draft.lon, 10)}</code> — drag it to adjust.
          </>
        ) : (
          <>Tap or click the map to drop the cache location{canLocate ? ", or use your location" : ""}.</>
        )}
      </p>
      {locErr && <p className="error">{locErr}</p>}
      {canLocate && (
        <div className="row">
          <button type="button" disabled={locating} onClick={() => locate()}>
            {locating ? "Locating…" : "Use my location"}
          </button>
        </div>
      )}
      <h4 className="set-subh">Basics</h4>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value as CacheType)} aria-describedby="hide-type-help">
          {TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
      </label>
      <p id="hide-type-help" className="muted fine">
        {TYPE_META[type].help}
      </p>
      {type === "aprs_living" && (
        <>
          <label>
            Station callsign (the beaconing station that <em>is</em> the cache)
            <input value={stationCall} onChange={(e) => setStationCall(e.target.value)} placeholder="OE8XYZ-9" />
          </label>
          <Row label="Log rendezvous when I meet other living caches">
            <Switch label="Log rendezvous" checked={rendezvous} onChange={setRendezvous} />
          </Row>
        </>
      )}
      <h4 className="set-subh">Difficulty &amp; terrain</h4>
      <div className="row">
        <label>
          Difficulty {difficulty.toFixed(1)}
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={difficulty}
            onChange={(e) => setDifficulty(+e.target.value)}
          />
        </label>
        <label>
          Terrain {terrain.toFixed(1)}
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={terrain}
            onChange={(e) => setTerrain(+e.target.value)}
          />
        </label>
      </div>
      <Advanced label="Advanced: hint, description, rating & sharing">
        <h4 className="set-subh">
          Details <span className="muted fw-normal">· all optional</span>
        </h4>
        <label>
          Hint <span className="muted">(optional)</span>
          <input value={hint} onChange={(e) => setHint(e.target.value)} />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <Row label="Drive-in (car-accessible)">
          <Switch label="Drive-in" checked={driveIn} onChange={setDriveIn} />
        </Row>
        <div className="row">
          <label>
            Country <span className="muted">(optional)</span>
            <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="AT" maxLength={56} />
          </label>
          <label>
            Tags <span className="muted">(optional)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="scenic, family, qrp" />
          </label>
        </div>
        {tagList.length > 0 && (
          <div className="badges">
            {tagList.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
        <h4 className="set-subh">Rating &amp; federation</h4>
        <label>
          Who can rate
          <select value={ratingPolicy} onChange={(e) => setRatingPolicy(e.target.value as "finders" | "all" | "off")}>
            <option value="finders">Finders only</option>
            <option value="all">Anyone signed in</option>
            <option value="off">Nobody (disabled)</option>
          </select>
        </label>
        <div className="badges" role="radiogroup" aria-label="Federation scope">
          {SCOPES.map((s) => (
            <button
              key={s.v}
              type="button"
              role="radio"
              aria-checked={fedScope === s.v}
              className={`chip-btn${fedScope === s.v ? " primary" : ""}`}
              onClick={() => setFedScope(s.v)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="muted">{SCOPES.find((s) => s.v === fedScope)?.help} The hint is never federated.</p>
      </Advanced>
      {err && <p className="error">{err}</p>}
      <div className="row end">
        <button onClick={props.onCancel}>Cancel</button>
        <button className="primary" disabled={!ready || busy} onClick={submit}>
          {busy ? "Hiding…" : "Hide cache"}
        </button>
      </div>
      {callsign.length < 3 && <p className="muted">Sign in to own a cache.</p>}
    </Panel>
  );
}
