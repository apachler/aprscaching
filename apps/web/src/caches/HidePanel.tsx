// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { createCache, listMyStations, type CacheSummary } from "../api.js";
import { TYPE_ORDER, TYPE_META } from "../cacheTypes.js";
import { maidenhead, parseCoordinates } from "../map/geo.js";
import { NAV_MAX_AGE_MS, locationSupport } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";
import { Button, Panel, Row, Switch, Advanced, Segmented, useLoad } from "../ui/index.js";
import { TEXT_LIMITS, dxccOfCall, type CacheType, type FedScope } from "@aprscaching/shared";
import { parseTags, refusalMessage, tagProblem } from "./formLimits.js";
import { CountrySelect } from "./CountrySelect.js";
import { usePlatform } from "../platform/PlatformContext.js";

const SCOPES: { v: FedScope; label: string; help: string }[] = [
  { v: "public", label: "Public", help: "Shared across the whole network." },
  { v: "unlisted", label: "Unlisted", help: "Off maps and search; anyone with its link or code still opens it." },
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
  // a living cache follows one of your own stations (Settings → My stations), never someone else's beacon
  const { data: myStations } = useLoad(
    () => (type === "aprs_living" && callsign ? listMyStations().then((r) => r.stations) : Promise.resolve([])),
    [type, callsign],
  );
  const [driveIn, setDriveIn] = useState(false);
  // most hide in their own country: start from the one the callsign names
  const [country, setCountry] = useState(() => dxccOfCall(callsign)?.prefix ?? "");
  const [tags, setTags] = useState("");
  const [ratingPolicy, setRatingPolicy] = useState<"finders" | "all" | "off">("finders");
  const [rendezvous, setRendezvous] = useState(false);
  const [radioOnly, setRadioOnly] = useState(false);
  const [fedScope, setFedScope] = useState<FedScope>("public");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loc = useLocate();
  const canLocate = locationSupport() !== "unsupported";
  const [typed, setTyped] = useState("");
  const [typedErr, setTypedErr] = useState(false);

  // the latest callbacks, so the one-shot auto-locate below never pins with a stale closure
  const placeRef = useRef(props.onPlace);
  placeRef.current = props.onPlace;
  const hasDraft = useRef(!!props.draft);
  hasDraft.current = !!props.draft;

  async function locate(auto = false) {
    const got = await loc.locate(NAV_MAX_AGE_MS);
    if (!("fix" in got)) {
      // an automatic attempt stays quiet when location is blocked: the map and the typed field remain
      if (auto && "problem" in got && got.problem === "denied") loc.clearProblem();
      return;
    }
    // a pin the hider already dropped by hand wins over a late automatic fix
    if (auto && hasDraft.current) return;
    placeRef.current(+got.fix.lat.toFixed(6), +got.fix.lon.toFixed(6));
  }
  // on a phone the hider usually stands at the spot: start from the device fix, once, on open
  const autoLocate = useRef(locate);
  useEffect(() => {
    if (touchFirst() && !hasDraft.current) void autoLocate.current(true);
  }, []);

  // A hider places the cache; a typed coordinate proves nothing and is not asked to.
  function placeTyped() {
    const c = parseCoordinates(typed);
    setTypedErr(!c);
    if (!c) return;
    loc.cancel();
    props.onPlace(+c.lat.toFixed(6), +c.lon.toFixed(6));
    setTyped("");
  }

  const ready = !!props.draft && title.trim().length > 0 && callsign.length >= 3;

  const tagList = parseTags(tags);
  const tagErr = tagProblem(tagList);

  async function submit() {
    if (!props.draft) return;
    if (type === "aprs_living" && !stationCall) {
      setErr("Pick the station this living cache follows.");
      return;
    }
    if (tagErr) {
      setErr(tagErr);
      return;
    }
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
        country: country || undefined,
        tags: tagList.length ? tagList : undefined,
        ratingPolicy,
        rendezvous: type === "aprs_living" ? rendezvous : undefined,
        minTrust: radioOnly ? "A" : undefined,
      });
      props.onCreated(cache);
    } catch (e) {
      setErr(refusalMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel side="left" title="Hide a cache">
      <h4 className="set-subh">Location</h4>
      <p className="muted" role="status" aria-live="polite">
        {props.draft ? (
          <>
            Pin at{" "}
            <code>
              {props.draft.lat.toFixed(5)}, {props.draft.lon.toFixed(5)}
            </code>{" "}
            · grid <code>{maidenhead(props.draft.lat, props.draft.lon, 10)}</code> — drag it to adjust.
          </>
        ) : (
          <>Tap or click the map to drop the cache location{canLocate ? ", use your location" : ""}, or type it.</>
        )}
      </p>
      <LocateStatus waiting={loc.waiting} problem={loc.problem} onCancel={loc.cancel} />
      {canLocate && (
        <div className="row">
          <Button type="button" disabled={!!loc.waiting} onClick={() => void locate()}>
            {loc.waiting ? "Locating…" : "Use my location"}
          </Button>
        </div>
      )}
      <form
        className="row coord-entry"
        onSubmit={(e) => {
          e.preventDefault();
          placeTyped();
        }}
      >
        <label>
          Coordinates
          <input
            value={typed}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="47.07355, 15.43785 or JN77rb"
            aria-invalid={typedErr || undefined}
            aria-describedby="hide-coord-help"
            onChange={(e) => {
              setTyped(e.target.value);
              setTypedErr(false);
            }}
          />
        </label>
        <Button type="submit" disabled={!typed.trim()}>
          Place pin
        </Button>
      </form>
      <p id="hide-coord-help" className={typedErr ? "error fine" : "muted fine"}>
        {typedErr
          ? "Not a coordinate. Type decimal degrees (lat, lon) or a Maidenhead locator."
          : "Decimal degrees (lat, lon) or a Maidenhead locator."}
      </p>
      <h4 className="set-subh">Basics</h4>
      <label>
        Title
        <input value={title} maxLength={TEXT_LIMITS.title} onChange={(e) => setTitle(e.target.value)} />
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
          {myStations && myStations.length > 0 ? (
            <label>
              Station (the beaconing station that <em>is</em> the cache)
              <select value={stationCall} onChange={(e) => setStationCall(e.target.value)}>
                <option value="">Pick one of your stations</option>
                {myStations.map((s) => (
                  <option key={s.id} value={s.callsign}>
                    {s.callsign}
                    {s.description ? ` — ${s.description}` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted fine" role="status">
              A living cache follows one of your own stations. Add the station under{" "}
              <strong>Settings → My stations</strong> first, or use <strong>Become a cache</strong> there to follow your
              own beacon.
            </p>
          )}
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
          <input value={hint} maxLength={TEXT_LIMITS.hint} onChange={(e) => setHint(e.target.value)} />
        </label>
        <label>
          Description <span className="muted">(optional)</span>
          <textarea
            value={description}
            rows={3}
            maxLength={TEXT_LIMITS.description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <Row label="Drive-in (car-accessible)">
          <Switch label="Drive-in" checked={driveIn} onChange={setDriveIn} />
        </Row>
        <div className="row">
          <CountrySelect value={country} onChange={setCountry} optional />
          <label>
            Tags <span className="muted">(optional)</span>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="scenic, family, qrp"
              aria-invalid={!!tagErr}
              aria-describedby={tagErr ? "hide-tags-err" : undefined}
            />
          </label>
        </div>
        {tagErr && (
          <p className="error fine" id="hide-tags-err">
            {tagErr}
          </p>
        )}
        {tagList.length > 0 && (
          <div className="badges">
            {tagList.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
        <h4 className="set-subh">Verification, rating &amp; federation</h4>
        <Row
          label="Radio-verified finds only"
          help="A find counts as verified only when a receiving station heard the finder there. Off: this instance's minimum applies."
        >
          <Switch label="Radio-verified finds only" checked={radioOnly} onChange={setRadioOnly} />
        </Row>
        <label>
          Who can rate
          <select value={ratingPolicy} onChange={(e) => setRatingPolicy(e.target.value as "finders" | "all" | "off")}>
            <option value="finders">Finders only</option>
            <option value="all">Anyone signed in</option>
            <option value="off">Nobody (disabled)</option>
          </select>
        </label>
        <Segmented
          label="Federation scope"
          look="chips"
          value={fedScope}
          onChange={setFedScope}
          options={SCOPES.map((sc) => ({ value: sc.v, label: sc.label }))}
        />
        <p className="muted">{SCOPES.find((s) => s.v === fedScope)?.help} The hint is never federated.</p>
      </Advanced>
      {err && <p className="error">{err}</p>}
      <div className="row end">
        <Button onClick={props.onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!ready || busy} onClick={submit}>
          {busy ? "Hiding…" : "Hide cache"}
        </Button>
      </div>
      {callsign.length < 3 && <p className="muted">Sign in to own a cache.</p>}
    </Panel>
  );
}
