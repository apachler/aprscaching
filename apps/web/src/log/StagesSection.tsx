// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { getStages, unlockStage, mediaUrl, privateClipUrl, type CacheStage } from "../api.js";
import { useFmt } from "../format.js";
import { Button, Icon } from "../ui/index.js";
import type { AppGeo } from "../api.js";
import { EVIDENCE_MAX_AGE_MS, toAppGeo } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";
import { stageRefusalText } from "./stageUnlock.js";

// Minimal WebNFC shapes (lib.dom doesn't ship them): just what we read off a tag.
interface NfcRecord {
  recordType: string;
  data?: BufferSource;
}
interface NfcReadingEvent {
  serialNumber?: string;
  message?: { records: NfcRecord[] };
}
interface NfcReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  onreading: (e: NfcReadingEvent) => void;
}

/** Audio-cache / multi-stage finder view — reveal the next locked stage (geo or on-request). */
export function StagesSection(props: { cacheId: number; callsign: string }) {
  const fmt = useFmt();
  const [stages, setStages] = useState<CacheStage[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const loc = useLocate();
  // the running NFC scan: stopped after its first reading, on Cancel, and when the view closes
  const scan = useRef<AbortController | null>(null);
  const stopScan = useCallback(() => {
    scan.current?.abort();
    scan.current = null;
  }, []);
  useEffect(() => stopScan, [stopScan]);
  const [scanning, setScanning] = useState(false);

  const [loadErr, setLoadErr] = useState(false);
  const load = useCallback(() => {
    setLoadErr(false);
    getStages(props.cacheId, props.callsign || undefined)
      .then((r) => setStages(r.stages))
      .catch(() => setLoadErr(true));
  }, [props.cacheId, props.callsign]);
  useEffect(() => {
    load();
  }, [load]);

  const finish = useCallback(
    async (stageNo: number, appGeo?: AppGeo, unlockCode?: string) => {
      try {
        const r = await unlockStage(props.cacheId, stageNo, props.callsign, appGeo, unlockCode);
        if (r.unlocked) {
          setCode("");
          setNote(
            r.offline ? "Unlocked from your offline pack; the instance confirms it when you are back online." : null,
          );
          load();
        } else setErr(stageRefusalText(r.reason, r.distanceM != null ? fmt.distance(r.distanceM) : undefined));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [props.cacheId, props.callsign, fmt, load],
  );

  async function reveal(stageNo: number) {
    if (props.callsign.length < 3) {
      setErr("Sign in to unlock stages.");
      return;
    }
    setBusy(stageNo);
    setErr(null);
    const stage = stages.find((s) => s.stageNo === stageNo);
    // geo stages take the device's own reading, stamped with its own time — never a typed coordinate
    if (stage?.unlock === "geo") {
      const got = await loc.locate(EVIDENCE_MAX_AGE_MS);
      if ("fix" in got) finish(stageNo, toAppGeo(got.fix));
      else setBusy(null);
    } else if (stage?.unlock === "nfc") {
      finish(stageNo, undefined, code.trim());
    } else {
      finish(stageNo);
    }
  }

  // WebNFC (Android Chromium): scan a tag and unlock with its serial/text. Manual code is the fallback.
  async function scanNfc(stageNo: number) {
    const NDEFReader = (window as unknown as { NDEFReader?: new () => NfcReader }).NDEFReader;
    if (!NDEFReader) {
      setErr("This device can't scan NFC — type the code instead.");
      return;
    }
    stopScan();
    const ctl = new AbortController();
    scan.current = ctl;
    setBusy(stageNo);
    setScanning(true);
    setErr(null);
    try {
      const reader = new NDEFReader();
      reader.onreading = (e: NfcReadingEvent) => {
        // one reading, one unlock: a tag held to the phone keeps reading, and each try counts against the hour
        if (ctl.signal.aborted) return;
        ctl.abort();
        if (scan.current === ctl) scan.current = null;
        setScanning(false);
        let tagCode = e.serialNumber ?? "";
        for (const rec of e.message?.records ?? []) {
          if (rec.recordType === "text" && rec.data) {
            try {
              tagCode = new TextDecoder().decode(rec.data);
              break;
            } catch {
              /* keep serial */
            }
          }
        }
        void finish(stageNo, undefined, tagCode);
      };
      await reader.scan({ signal: ctl.signal });
    } catch (e) {
      if (scan.current === ctl) scan.current = null;
      setScanning(false);
      setBusy(null);
      if (!ctl.signal.aborted) setErr((e as Error).message || "NFC scan failed.");
    }
  }

  function cancelScan() {
    stopScan();
    setScanning(false);
    setBusy(null);
  }

  // a failed load must not render the cache as stageless — say so, offer retry
  if (loadErr)
    return (
      <div className="stages">
        <h4>Stages</h4>
        <p className="muted error">Couldn't load this cache's stages.</p>
        <Button onClick={load}>Retry</Button>
      </div>
    );

  // the next actionable (locked) stage
  const nextLocked = stages.find((s) => s.stageNo > 0 && !s.unlocked);
  return (
    <div className="stages">
      <h4>
        Stages{" "}
        <span className="muted fw-normal">
          · {stages.filter((s) => s.unlocked).length}/{stages.length} unlocked
        </span>
      </h4>
      <ol className="stagelist">
        {stages.map((s) => (
          <li key={s.stageNo} className={s.unlocked ? "open" : "locked"}>
            <div className="row between">
              <strong>{s.stageNo === 0 ? "Start" : `Stage ${s.stageNo}`}</strong>
              <span className="muted">
                {s.unlocked ? (
                  "✓ unlocked"
                ) : (
                  <>
                    <Icon name="lock" cp437="LOCK" className="lead-ic" />
                    {s.unlock}
                  </>
                )}
              </span>
            </div>
            {s.clue && <div className="comment">{s.clue}</div>}
            {s.mediaUrl &&
              (s.stageNo === 0 || s.unlock === "audio" ? (
                <audio controls preload="none" src={mediaUrl(s.mediaUrl)} />
              ) : (
                <PrivateClip path={s.mediaUrl} stageNo={s.stageNo} />
              ))}
            {s.unlocked && s.lat != null && s.lon != null && (
              <div className="muted mt-1">
                <Icon name="place" cp437="" className="lead-ic" />
                <span className="mono">{fmt.coord(s.lat, s.lon)}</span> ·{" "}
                <a
                  href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  map ↗
                </a>
              </div>
            )}
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && s.unlock === "nfc" && (
              <div className="nfc-unlock mt-2">
                <div className="row gap-2">
                  <Button disabled={busy === s.stageNo} onClick={() => void scanNfc(s.stageNo)}>
                    <Icon name="signal" cp437="" className="lead-ic" />
                    {scanning && busy === s.stageNo ? "Hold the tag to the phone…" : "Scan NFC tag"}
                  </Button>
                  {scanning && busy === s.stageNo && <Button onClick={cancelScan}>Cancel</Button>}
                </div>
                <div className="row gap-2 mt-2">
                  <input
                    value={code}
                    placeholder="…or enter the tag code"
                    aria-label="Stage tag code"
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <Button
                    variant="primary"
                    disabled={busy === s.stageNo || !code.trim()}
                    onClick={() => reveal(s.stageNo)}
                  >
                    {busy === s.stageNo ? "Checking…" : "Unlock"}
                  </Button>
                </div>
              </div>
            )}
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && s.unlock !== "nfc" && (
              <Button
                variant="primary"
                className="mt-2"
                disabled={busy === s.stageNo}
                onClick={() => reveal(s.stageNo)}
              >
                {busy === s.stageNo ? "Checking…" : s.unlock === "geo" ? "I'm here — reveal" : "Reveal next stage"}
              </Button>
            )}
          </li>
        ))}
      </ol>
      <LocateStatus waiting={loc.waiting} problem={loc.problem} onCancel={loc.cancel} />
      {note && (
        <p className="inline-note" role="status">
          {note}
        </p>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/**
 * The clip of a stage that unlocks by location, tag or on request: only its unlocker and the owner may hear it, so
 * it loads on demand through the signed-in session and plays from a local copy (see privateClipUrl).
 */
function PrivateClip(props: { path: string; stageNo: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (url?.startsWith("blob:") && url !== props.path) URL.revokeObjectURL(url);
    },
    [url, props.path],
  );
  if (url) return <audio controls autoPlay src={url} />;
  return (
    <div className="row">
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setErr(null);
          privateClipUrl(props.path)
            .then(setUrl)
            .catch((e: Error) => setErr(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Loading…" : `Play stage ${props.stageNo} clip`}
      </Button>
      {err && (
        <span className="error fine" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}
