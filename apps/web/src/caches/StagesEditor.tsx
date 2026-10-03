// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { MEDIA_LIMITS, mediaMB } from "@aprscaching/shared";
import { getStages, setStages, uploadStageClip, type CacheStage } from "../api.js";
import { parseCoordinates } from "../map/geo.js";
import { Button, useToast, useConfirm } from "../ui/index.js";

type Unlock = CacheStage["unlock"];
interface Draft {
  unlock: Unlock;
  clue: string;
  at: string;
  radiusM: number;
  secret: string;
}

const UNLOCKS: { v: Unlock; label: string; help: string }[] = [
  { v: "geo", label: "Location", help: "Opens when the finder stands within the radius of the stage before." },
  { v: "nfc", label: "NFC tag", help: "Opens with the tag's code: its serial, or nine or more random characters." },
  { v: "audio", label: "Audio clue", help: "Opens when the finder asks, after the clip." },
  { v: "open", label: "Open", help: "Opens when the finder asks." },
];
/** The shortest tag code that travels in offline packs, sealed (stageseal.ts). */
const NFC_OFFLINE_MIN = 9;

const fmtAt = (lat: number | null, lon: number | null) =>
  lat != null && lon != null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : "";

/**
 * The owner's stage list: the open start and the locked stages in order. Saving replaces the list; a finder who
 * unlocked a stage that changed unlocks it again, so the form says so before it saves. An audio stage's clip
 * uploads once the stage is saved.
 */
export function StagesEditor(props: {
  cacheId: number;
  ownerCall: string;
  /** The cache's own position, where the start begins. */
  start: { lat: number; lon: number } | null;
}) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [saved, setSaved] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [offline, setOffline] = useState<{ stageNo: number; offline: boolean; reason?: string }[]>([]);

  useEffect(() => {
    let live = true;
    getStages(props.cacheId)
      .then((r) => {
        if (!live) return;
        const start = {
          unlock: "open" as Unlock,
          clue: "",
          at: fmtAt(props.start?.lat ?? null, props.start?.lon ?? null),
        };
        const loaded = r.stages.map((s) => ({
          unlock: s.unlock,
          clue: s.clue ?? "",
          at: fmtAt(s.lat, s.lon),
          radiusM: s.radiusM,
          secret: s.secret ?? "",
        }));
        // the open start is stage 0; a list that lacks one gets it, so the rows are numbered as the stages are
        const startRow = { ...start, radiusM: 60, secret: "" };
        setRows(r.stages[0]?.stageNo === 0 ? loaded : [startRow, ...loaded]);
        setSaved(r.stages[0]?.stageNo === 0 ? loaded.length : 0);
      })
      .catch(() => live && setErr("Couldn't load the stages — try again."));
    return () => {
      live = false;
    };
  }, [props.cacheId, props.start?.lat, props.start?.lon]);

  const edit = (i: number, patch: Partial<Draft>) =>
    setRows((rs) => rs && rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  /** The list as the API takes it, or the first problem. */
  function payload() {
    if (!rows) return null;
    const out = [];
    for (const [n, r] of rows.entries()) {
      const at = r.at.trim() ? parseCoordinates(r.at) : null;
      if (r.at.trim() && !at) return `${n === 0 ? "The start" : `Stage ${n}`}: not a coordinate.`;
      if (r.unlock === "nfc" && !r.secret.trim()) return `Stage ${n}: an NFC stage needs its tag code.`;
      out.push({
        stageNo: n,
        unlock: n === 0 ? "open" : r.unlock,
        clue: r.clue.trim() || undefined,
        lat: at ? +at.lat.toFixed(6) : undefined,
        lon: at ? +at.lon.toFixed(6) : undefined,
        radiusM: r.radiusM,
        secret: r.unlock === "nfc" ? r.secret.trim() : undefined,
      });
    }
    return out;
  }

  async function save() {
    const p = payload();
    if (typeof p === "string" || !p) {
      setErr(p ?? null);
      return;
    }
    if (
      saved > 0 &&
      !(await confirmDialog({
        title: "Save the stages?",
        message: "Finders who unlocked a stage you changed, or one after it, unlock those stages again.",
        confirmLabel: "Save stages",
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const r = await setStages(props.cacheId, props.ownerCall, p);
      setOffline(r.offline);
      setSaved(p.length);
      toast(`${p.length - 1} stage${p.length === 2 ? "" : "s"} saved`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(n: number, file: File | undefined) {
    if (!file) return;
    if (file.size > MEDIA_LIMITS.audio) {
      toast(`The clip is over ${mediaMB(MEDIA_LIMITS.audio)}.`);
      return;
    }
    try {
      await uploadStageClip(props.cacheId, n, props.ownerCall, file);
      toast(`Clip for stage ${n} uploaded`);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="stages-edit-h">
      <h4 className="set-subh" id="stages-edit-h">
        Stages
      </h4>
      {!rows ? (
        err ? (
          <p className="error">{err}</p>
        ) : (
          <p className="muted">Loading the stages…</p>
        )
      ) : (
        <>
          <p className="muted fine">
            Finders unlock the stages in order. A find needs the last one unlocked, and is checked at its position.
          </p>
          <ol className="stage-edit-list">
            {rows.map((r, n) => (
              <li key={n} className="stage-edit">
                <strong>{n === 0 ? "Start (open to everyone)" : `Stage ${n}`}</strong>
                {n > 0 && (
                  <label>
                    Unlocks by
                    <select value={r.unlock} onChange={(e) => edit(n, { unlock: e.target.value as Unlock })}>
                      {UNLOCKS.map((u) => (
                        <option key={u.v} value={u.v}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {n > 0 && <p className="muted fine">{UNLOCKS.find((u) => u.v === r.unlock)?.help}</p>}
                <label>
                  Position
                  <input
                    value={r.at}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="47.07355, 15.43785 or JN77rb"
                    onChange={(e) => edit(n, { at: e.target.value })}
                  />
                </label>
                <label>
                  Clue <span className="muted">(optional)</span>
                  <textarea value={r.clue} rows={2} onChange={(e) => edit(n, { clue: e.target.value })} />
                </label>
                {rows[n + 1]?.unlock === "geo" && (
                  <label>
                    Radius in metres: the next stage opens within it
                    <input
                      type="number"
                      min={10}
                      max={500}
                      value={r.radiusM}
                      onChange={(e) => edit(n, { radiusM: Math.max(10, Math.min(500, +e.target.value || 60)) })}
                    />
                  </label>
                )}
                {r.unlock === "nfc" && n > 0 && (
                  <>
                    <label>
                      Tag code
                      <input
                        value={r.secret}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => edit(n, { secret: e.target.value })}
                      />
                    </label>
                    {r.secret.trim().length > 0 && r.secret.trim().length < NFC_OFFLINE_MIN && (
                      <p className="muted fine">Shorter than {NFC_OFFLINE_MIN} characters: it unlocks online only.</p>
                    )}
                  </>
                )}
                {r.unlock === "audio" && n > 0 && (
                  <label>
                    Audio clip <span className="muted">(up to {mediaMB(MEDIA_LIMITS.audio)})</span>
                    <input
                      type="file"
                      accept="audio/*"
                      disabled={n >= saved}
                      onChange={(e) => void upload(n, e.target.files?.[0])}
                    />
                    {n >= saved && <span className="muted fine">Save the stages first.</span>}
                  </label>
                )}
                {r.unlock === "nfc" && offline.find((o) => o.stageNo === n && !o.offline && o.reason) && (
                  <p className="muted fine">Online only: {offline.find((o) => o.stageNo === n)?.reason}</p>
                )}
              </li>
            ))}
          </ol>
          <div className="row">
            <Button
              onClick={() =>
                setRows((rs) => rs && [...rs, { unlock: "geo", clue: "", at: "", radiusM: 60, secret: "" }])
              }
            >
              Add a stage
            </Button>
            {rows.length > 1 && (
              <Button onClick={() => setRows((rs) => rs && rs.slice(0, -1))}>Remove the last stage</Button>
            )}
          </div>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <div className="row end">
            <Button variant="primary" disabled={busy || rows.length < 2} onClick={() => void save()}>
              {busy ? "Saving…" : "Save stages"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
