import { useState } from "react";
import { createCache, type CacheSummary } from "../api.js";
import { TYPE_ORDER, TYPE_META } from "../cacheTypes.js";
import { maidenhead } from "../map/geo.js";
import { Panel, Row, Switch } from "../ui/index.js";
import type { CacheType, FedScope } from "@aprsweb/shared";

const SCOPES: { v: FedScope; label: string; help: string }[] = [
  { v: "public", label: "Public", help: "Shared across the whole network." },
  { v: "unlisted", label: "Unlisted", help: "On the network map, but its description stays on this instance." },
  { v: "local-only", label: "Local only", help: "Never leaves this instance." },
];

/** Hide a cache — sectioned form; submit is gated on a dropped pin + title + callsign. */
export function HidePanel(props: {
  callsign: string; draft: { lat: number; lon: number } | null;
  onCancel: () => void; onCreated: (c: CacheSummary) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CacheType>("single");
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

  const ready = !!props.draft && title.trim().length > 0 && props.callsign.length >= 3;

  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12);

  async function submit() {
    if (!props.draft) return;
    setBusy(true); setErr(null);
    try {
      const { cache } = await createCache({
        title: title.trim(), type, difficulty, terrain,
        lat: props.draft.lat, lon: props.draft.lon,
        ownerCall: props.callsign,
        hint: hint.trim() || undefined,
        description: description.trim() || undefined,
        fedScope,
        stationCall: type === "aprs_living" ? (stationCall.trim().toUpperCase() || undefined) : undefined,
        driveIn: driveIn || undefined,
        country: country.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
        ratingPolicy,
        rendezvous: type === "aprs_living" ? rendezvous : undefined,
      });
      props.onCreated(cache);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Panel side="left" title="Hide a cache">
      <p className="muted">
        {props.draft
          ? <>Pin at <code>{props.draft.lat.toFixed(5)}, {props.draft.lon.toFixed(5)}</code> · grid <code>{maidenhead(props.draft.lat, props.draft.lon, 10)}</code> — drag to adjust.</>
          : <>Click the map to drop the cache location.</>}
      </p>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value as CacheType)}>
          {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
        </select>
      </label>
      {type === "aprs_living" && (
        <>
          <label>Station callsign (the beaconing station that <em>is</em> the cache)
            <input value={stationCall} onChange={(e) => setStationCall(e.target.value)} placeholder="OE8XYZ-9" />
          </label>
          <Row label="Log rendezvous when I meet other living caches">
            <Switch label="Log rendezvous" checked={rendezvous} onChange={setRendezvous} />
          </Row>
        </>
      )}
      <div className="row">
        <label>Difficulty {difficulty.toFixed(1)}
          <input type="range" min={1} max={5} step={0.5} value={difficulty}
                 onChange={(e) => setDifficulty(+e.target.value)} /></label>
        <label>Terrain {terrain.toFixed(1)}
          <input type="range" min={1} max={5} step={0.5} value={terrain}
                 onChange={(e) => setTerrain(+e.target.value)} /></label>
      </div>
      <label>Hint<input value={hint} onChange={(e) => setHint(e.target.value)} /></label>
      <label>Description
        <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} /></label>
      <Row label="Drive-in (car-accessible)">
        <Switch label="Drive-in" checked={driveIn} onChange={setDriveIn} />
      </Row>
      <div className="row">
        <label>Country<input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="AT" maxLength={56} /></label>
        <label>Tags<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="scenic, family, qrp" /></label>
      </div>
      {tagList.length > 0 && <div className="badges">{tagList.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
      <label>Who can rate
        <select value={ratingPolicy} onChange={(e) => setRatingPolicy(e.target.value as "finders" | "all" | "off")}>
          <option value="finders">Finders only</option>
          <option value="all">Anyone signed in</option>
          <option value="off">Nobody (disabled)</option>
        </select>
      </label>
      <h4>Federation</h4>
      <div className="badges" role="radiogroup" aria-label="Federation scope">
        {SCOPES.map((s) => (
          <button key={s.v} type="button" role="radio" aria-checked={fedScope === s.v}
            className={`chip-btn${fedScope === s.v ? " primary" : ""}`} onClick={() => setFedScope(s.v)}>{s.label}</button>
        ))}
      </div>
      <p className="muted">{SCOPES.find((s) => s.v === fedScope)?.help} The hint is never federated.</p>
      {err && <p className="error">{err}</p>}
      <div className="row end">
        <button onClick={props.onCancel}>Cancel</button>
        <button className="primary" disabled={!ready || busy} onClick={submit}>
          {busy ? "Hiding…" : "Hide cache"}
        </button>
      </div>
      {props.callsign.length < 3 && <p className="muted">Set your callsign (top bar) to own a cache.</p>}
    </Panel>
  );
}
