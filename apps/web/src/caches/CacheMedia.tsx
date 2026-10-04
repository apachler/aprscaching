// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { MEDIA_LIMITS } from "@aprscaching/shared";
import { getCacheMedia, addCacheMedia, deleteCacheMedia, mediaUrl, type CacheMediaItem } from "../api.js";
import { mediaUploadProblem } from "../media/limits.js";
import { Button, Icon, useConfirm } from "../ui/index.js";

/**
 * Cache media gallery — photos, audio and files an owner attaches to a cache (hints,
 * circuit diagrams, the audio sample). Public to view; the owner gets upload + delete. Images render
 * as thumbnails, audio as players, anything else as a download link. Lazy: only fetched when mounted
 * on the cache sheet.
 */
export function CacheMedia(props: { cacheId: number; isOwner: boolean; onToast: (m: string) => void }) {
  const [items, setItems] = useState<CacheMediaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const confirmDialog = useConfirm();

  const [loadErr, setLoadErr] = useState(false);
  useEffect(() => {
    let live = true;
    let loaded: CacheMediaItem[] = [];
    setLoadErr(false);
    getCacheMedia(props.cacheId)
      .then((r) => {
        loaded = r.media;
        if (live) setItems(r.media);
        else revokeLocal(r.media);
      })
      .catch(() => {
        if (live) setLoadErr(true);
      });
    return () => {
      live = false;
      // an offline pack's images come as local object URLs: they go with the cache they were loaded for
      revokeLocal(loaded);
    };
  }, [props.cacheId]);

  async function upload(file: File) {
    // a photo is scaled before it goes up, so only its kind is checked here; a sound is sent as it is
    const problem = mediaUploadProblem(file.type, file.type.startsWith("image/") ? 1 : file.size);
    if (problem) {
      props.onToast(problem);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const { item } = await addCacheMedia(props.cacheId, file, file.name);
      setItems((m) => [...(m ?? []), item]);
      props.onToast("Media added");
    } catch (e) {
      props.onToast((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function remove(it: CacheMediaItem) {
    const ok = await confirmDialog({
      title: "Delete this media?",
      message: `${it.title ?? (it.kind === "image" ? "The photo" : "The file")} is removed from the cache for everyone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const id = it.id;
    try {
      await deleteCacheMedia(props.cacheId, id);
      setItems((m) => (m ?? []).filter((x) => x.id !== id));
      props.onToast("Media removed");
    } catch (e) {
      props.onToast((e as Error).message);
    }
  }

  if (loadErr)
    return (
      <p className="muted error">Couldn't load this cache's media — check your connection and reopen the cache.</p>
    );
  if (!items) return null;
  if (items.length === 0 && !props.isOwner) return null;

  return (
    <div className="cache-media">
      <div className="row between">
        <span className="ulabel">Media</span>
      </div>
      {items.length > 0 && (
        <div className="media-grid">
          {items.map((it) => (
            <figure key={it.id} className="media-item">
              {it.kind === "image" ? (
                <a href={mediaUrl(it.url)} target="_blank" rel="noreferrer noopener">
                  {/* the gallery loads the small copy; the photo itself opens on a tap */}
                  <img src={mediaUrl(it.thumbUrl ?? it.url)} alt={it.title ?? "cache photo"} loading="lazy" />
                </a>
              ) : it.kind === "audio" ? (
                <audio controls preload="none" src={mediaUrl(it.url)} />
              ) : (
                <a className="media-file" href={mediaUrl(it.url)} target="_blank" rel="noreferrer noopener">
                  <Icon name="attach" cp437="" className="lead-ic" />
                  {it.title ?? "file"}
                </a>
              )}
              {props.isOwner && (
                <Button
                  className="media-del"
                  aria-label={`Delete ${it.title ?? "media"}`}
                  onClick={() => void remove(it)}
                >
                  ✕
                </Button>
              )}
            </figure>
          ))}
        </div>
      )}
      {props.isOwner && items.length >= MEDIA_LIMITS.items && (
        <p className="muted fine">A cache holds at most {MEDIA_LIMITS.items} media items: delete one to add another.</p>
      )}
      {props.isOwner && items.length < MEDIA_LIMITS.items && (
        <div className="mt-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif,audio/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
          />
          {busy && <span className="muted fine"> uploading…</span>}
        </div>
      )}
    </div>
  );
}

/** Release the local object URLs (an offline pack's images) a media list holds. */
function revokeLocal(media: CacheMediaItem[]) {
  for (const m of media) if (m.url.startsWith("blob:")) URL.revokeObjectURL(m.url);
}
