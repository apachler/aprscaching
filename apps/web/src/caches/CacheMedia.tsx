// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { getCacheMedia, addCacheMedia, deleteCacheMedia, mediaUrl, type CacheMediaItem } from "../api.js";
import { Ico } from "../ui/index.js";

/**
 * Cache media gallery (docs/26 F-3) — photos, audio and files an owner attaches to a cache (hints,
 * circuit diagrams, the audio sample). Public to view; the owner gets upload + delete. Images render
 * as thumbnails, audio as players, anything else as a download link. Lazy: only fetched when mounted
 * on the cache sheet.
 */
export function CacheMedia(props: { cacheId: number; isOwner: boolean; onToast: (m: string) => void }) {
  const [items, setItems] = useState<CacheMediaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    getCacheMedia(props.cacheId).then((r) => { if (live) setItems(r.media); }).catch(() => setItems([]));
    return () => { live = false; };
  }, [props.cacheId]);

  async function upload(file: File) {
    setBusy(true);
    try {
      const { item } = await addCacheMedia(props.cacheId, file, file.name);
      setItems((m) => [...(m ?? []), item]);
      props.onToast("Media added");
    } catch (e) { props.onToast((e as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  async function remove(id: number) {
    try { await deleteCacheMedia(props.cacheId, id); setItems((m) => (m ?? []).filter((x) => x.id !== id)); props.onToast("Media removed"); }
    catch (e) { props.onToast((e as Error).message); }
  }

  if (!items) return null;
  if (items.length === 0 && !props.isOwner) return null;

  return (
    <div className="cache-media">
      <div className="row between"><span className="ulabel">Media</span></div>
      {items.length > 0 && (
        <div className="media-grid">
          {items.map((it) => (
            <figure key={it.id} className="media-item">
              {it.kind === "image" ? <a href={mediaUrl(it.url)} target="_blank" rel="noreferrer noopener"><img src={mediaUrl(it.url)} alt={it.title ?? "cache photo"} loading="lazy" /></a>
                : it.kind === "audio" ? <audio controls preload="none" src={mediaUrl(it.url)} />
                : <a className="media-file" href={mediaUrl(it.url)} target="_blank" rel="noreferrer noopener"><Ico e="📎 " />{it.title ?? "file"}</a>}
              {props.isOwner && <button className="media-del" aria-label="Delete media" onClick={() => remove(it.id)}>✕</button>}
            </figure>
          ))}
        </div>
      )}
      {props.isOwner && (
        <div className="mt-2">
          <input ref={fileRef} type="file" accept="image/*,audio/*,.pdf,.txt,.zip" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
          {busy && <span className="muted fine"> uploading…</span>}
        </div>
      )}
    </div>
  );
}
