// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getInstance, registerKey, logFind, type LogResult, type AppGeo } from "../api.js";
import { signAuthorship } from "../crypto.js";
import { useFmt } from "../format.js";
import { TierBadge, Ico } from "../ui/index.js";
import type { LogType } from "@aprsweb/shared";

/** One-tap log (the core action). The trust badge IS the feedback shown after the tap. */
export function LogForm(props: { cacheId: number; cacheCode: string; callsign: string; onLogged: () => void }) {
  const fmt = useFmt();
  const [busy, setBusy] = useState<LogType | null>(null);
  const [result, setResult] = useState<LogResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  // request the device fix (Tier-B path); resolve undefined if denied/unavailable so the tap still succeeds
  function getGeo(): Promise<AppGeo | undefined> {
    if (!navigator.geolocation) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) =>
          resolve({
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            accuracyM: p.coords.accuracy ?? 9999,
            ts: Math.floor(p.timestamp / 1000),
          }),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
  }

  async function doLog(logType: LogType, comment?: string) {
    if (props.callsign.length < 3) {
      setErr("Set your callsign in the top bar first.");
      return;
    }
    setBusy(logType);
    setErr(null);
    try {
      const appGeo = logType === "found" ? await getGeo() : undefined;
      let author;
      try {
        const instance = await getInstance();
        if (instance) {
          const at = Math.floor(Date.now() / 1000);
          author = await signAuthorship({ cache: props.cacheCode, instance, logger: props.callsign, logType, at });
          if (author) await registerKey({ callsign: props.callsign, publicKey: author.authorKey }).catch(() => {});
        }
      } catch {
        /* unsupported browser -> log unsigned */
      }
      const r = await logFind(props.cacheId, { loggerCall: props.callsign, logType, comment, appGeo, author });
      setResult(r);
      setNote("");
      setNoteOpen(false);
      props.onLogged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // the trust badge IS the feedback, shown after the tap (tap it for the "why")
  function tierBadge(r: LogResult) {
    if (r.logType !== "found") return null;
    if (!r.verified) return <TierBadge verified={false} prefix="Logged" title={r.reason ?? ""} />;
    const why = `Tier ${r.tier} · ${r.method ?? ""}${r.distanceM != null ? ` · ${fmt.distance(r.distanceM)}` : ""}${r.corroboratedBy ? ` · via ${r.corroboratedBy}` : ""}`;
    return <TierBadge tier={r.tier} prefix="Verified" title={why} />;
  }

  if (result) {
    const verb = result.logType === "found" ? "Logged" : result.logType === "dnf" ? "Marked DNF" : "Note posted";
    return (
      <div className="logresult">
        <div className="big">
          {result.queued ? "Saved" : verb} {result.logType === "found" && result.verified ? "✓" : ""}
        </div>
        {result.queued ? (
          <div className="muted mt-1">
            <Ico e="📴 " />
            offline — will sync when you're back online
          </div>
        ) : (
          <div className="tier">{tierBadge(result)}</div>
        )}
        {result.announced && <div className="muted mt-1">announced to APRS-IS</div>}
        {result.signerKey && (
          <div className="muted">
            signed with your device key <Ico e="✍" />
          </div>
        )}
        {result.logType === "found" &&
          (noteOpen ? (
            <div className="mt-3">
              <textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row end">
                <button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
                  Post
                </button>
              </div>
            </div>
          ) : (
            <button className="link mt-3" onClick={() => setNoteOpen(true)}>
              add a note
            </button>
          ))}
        <div className="mt-3">
          <button
            className="link"
            onClick={() => {
              setResult(null);
              setNote("");
              setNoteOpen(false);
            }}
          >
            log again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="logform">
      <button className="primary log-primary" disabled={!!busy} onClick={() => doLog("found")}>
        {busy === "found" ? "Logging…" : "✓ Log a find"}
      </button>
      <div className="row between mt-3">
        <button className="link" disabled={!!busy} onClick={() => doLog("dnf")}>
          {busy === "dnf" ? "…" : "Couldn't find it"}
        </button>
        <button className="link" onClick={() => setNoteOpen((v) => !v)}>
          Add a note
        </button>
      </div>
      {noteOpen && (
        <div className="mt-2">
          <textarea rows={2} placeholder="Note…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row end">
            <button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>
              Post note
            </button>
          </div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
