import { useCallback, useEffect, useState } from "react";
import { getStages, unlockStage, mediaUrl, type CacheStage } from "../api.js";
import { useFmt } from "../format.js";
import type { AppGeo } from "../api.js";

/** Audio-cache / multi-stage finder view — reveal the next locked stage (geo or on-request). */
export function StagesSection(props: { cacheId: number; callsign: string }) {
  const fmt = useFmt();
  const [stages, setStages] = useState<CacheStage[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    getStages(props.cacheId, props.callsign || undefined).then((r) => setStages(r.stages)).catch(console.error);
  }, [props.cacheId, props.callsign]);
  useEffect(() => { load(); }, [load]);

  async function reveal(stageNo: number) {
    if (props.callsign.length < 3) { setErr("Set your callsign first."); return; }
    setBusy(stageNo); setErr(null);
    const finish = async (appGeo?: AppGeo) => {
      try {
        const r = await unlockStage(props.cacheId, stageNo, props.callsign, appGeo);
        if (r.unlocked) load();
        else setErr(r.reason === "too_far" ? `Too far — ${fmt.distance(r.distanceM ?? 0)} away.` : "Not unlocked yet.");
      } catch (e) { setErr((e as Error).message); }
      finally { setBusy(null); }
    };
    // geo stages need your live position; open/audio stages just unlock on request
    const stage = stages.find((s) => s.stageNo === stageNo);
    if (stage?.unlock === "geo" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy, ts: Math.floor(Date.now() / 1000) }),
        () => { setErr("Location permission needed to unlock this stage."); setBusy(null); },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } else { finish(); }
  }

  // the next actionable (locked) stage
  const nextLocked = stages.find((s) => s.stageNo > 0 && !s.unlocked);
  return (
    <div className="stages">
      <h4>Stages <span className="muted fw-normal">· {stages.filter((s) => s.unlocked).length}/{stages.length} unlocked</span></h4>
      <ol className="stagelist">
        {stages.map((s) => (
          <li key={s.stageNo} className={s.unlocked ? "open" : "locked"}>
            <div className="row between">
              <strong>{s.stageNo === 0 ? "Start" : `Stage ${s.stageNo}`}</strong>
              <span className="muted">{s.unlocked ? "✓ unlocked" : `🔒 ${s.unlock}`}</span>
            </div>
            {s.clue && <div className="comment">{s.clue}</div>}
            {s.mediaUrl && <audio controls preload="none" src={mediaUrl(s.mediaUrl)} />}
            {s.unlocked && s.lat != null && s.lon != null && (
              <div className="muted mt-1">
                📍 <span className="mono">{fmt.coord(s.lat, s.lon)}</span> · <a href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`} target="_blank" rel="noreferrer noopener">map ↗</a>
              </div>
            )}
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && (
              <button className="primary mt-2" disabled={busy === s.stageNo} onClick={() => reveal(s.stageNo)}>
                {busy === s.stageNo ? "Checking…" : s.unlock === "geo" ? "I'm here — reveal" : "Reveal next stage"}
              </button>
            )}
          </li>
        ))}
      </ol>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
