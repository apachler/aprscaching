import { useCallback, useEffect, useState } from "react";
import { getStages, unlockStage, mediaUrl, type CacheStage } from "../api.js";
import { useFmt } from "../format.js";
import type { AppGeo } from "../api.js";

// Minimal WebNFC shapes (lib.dom doesn't ship them): just what we read off a tag.
interface NfcRecord { recordType: string; data?: BufferSource }
interface NfcReadingEvent { serialNumber?: string; message?: { records: NfcRecord[] } }
interface NfcReader { scan(): Promise<void>; onreading: (e: NfcReadingEvent) => void }

/** Audio-cache / multi-stage finder view — reveal the next locked stage (geo or on-request). */
export function StagesSection(props: { cacheId: number; callsign: string }) {
  const fmt = useFmt();
  const [stages, setStages] = useState<CacheStage[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const load = useCallback(() => {
    getStages(props.cacheId, props.callsign || undefined).then((r) => setStages(r.stages)).catch(console.error);
  }, [props.cacheId, props.callsign]);
  useEffect(() => { load(); }, [load]);

  const finish = useCallback(async (stageNo: number, appGeo?: AppGeo, unlockCode?: string) => {
    try {
      const r = await unlockStage(props.cacheId, stageNo, props.callsign, appGeo, unlockCode);
      if (r.unlocked) { setCode(""); load(); }
      else if (r.reason === "too_far") setErr(`Too far — ${fmt.distance(r.distanceM ?? 0)} away.`);
      else if (r.reason === "bad_code") setErr("That tag/code doesn't match this stage.");
      else if (r.reason === "no_code") setErr("Scan the NFC tag or enter its code.");
      else setErr("Not unlocked yet.");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }, [props.cacheId, props.callsign, fmt, load]);

  async function reveal(stageNo: number) {
    if (props.callsign.length < 3) { setErr("Set your callsign first."); return; }
    setBusy(stageNo); setErr(null);
    const stage = stages.find((s) => s.stageNo === stageNo);
    // geo stages need your live position; nfc stages a tag/code; open/audio unlock on request
    if (stage?.unlock === "geo" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish(stageNo, { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy, ts: Math.floor(Date.now() / 1000) }),
        () => { setErr("Location permission needed to unlock this stage."); setBusy(null); },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } else if (stage?.unlock === "nfc") {
      finish(stageNo, undefined, code.trim());
    } else { finish(stageNo); }
  }

  // WebNFC (Android Chromium): scan a tag and unlock with its serial/text. Manual code is the fallback.
  async function scanNfc(stageNo: number) {
    const NDEFReader = (window as unknown as { NDEFReader?: new () => NfcReader }).NDEFReader;
    if (!NDEFReader) { setErr("This device can't scan NFC — type the code instead."); return; }
    setBusy(stageNo); setErr(null);
    try {
      const reader = new NDEFReader();
      await reader.scan();
      reader.onreading = (e: NfcReadingEvent) => {
        let tagCode = e.serialNumber ?? "";
        for (const rec of e.message?.records ?? []) {
          if (rec.recordType === "text" && rec.data) { try { tagCode = new TextDecoder().decode(rec.data); break; } catch { /* keep serial */ } }
        }
        finish(stageNo, undefined, tagCode);
      };
    } catch (e) { setErr((e as Error).message || "NFC scan failed."); setBusy(null); }
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
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && s.unlock === "nfc" && (
              <div className="nfc-unlock mt-2">
                <div className="row gap-2">
                  <button disabled={busy === s.stageNo} onClick={() => scanNfc(s.stageNo)}>📶 Scan NFC tag</button>
                </div>
                <div className="row gap-2 mt-2">
                  <input value={code} placeholder="…or enter the tag code" aria-label="Stage tag code" onChange={(e) => setCode(e.target.value)} />
                  <button className="primary" disabled={busy === s.stageNo || !code.trim()} onClick={() => reveal(s.stageNo)}>
                    {busy === s.stageNo ? "Checking…" : "Unlock"}
                  </button>
                </div>
              </div>
            )}
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && s.unlock !== "nfc" && (
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
