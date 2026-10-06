// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The tool-registry views the Tools app and Instance settings share: the registries loaded and checked in the
 * browser, their grouped listings with each group's own states, a player's own registries, and the add flow,
 * which shows the key's fingerprint and pins it only once the person confirms it matches the publisher's.
 */
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { REGISTRIES_PER_ACCOUNT, registrySourceUrl, type ToolRegistryEntry } from "@aprscaching/shared";
import { authorityFingerprint, type RegistryPreview } from "@aprscaching/tools";
import {
  API_BASE,
  addToolRegistry,
  confirmToolRegistryKey,
  errorText,
  listToolRegistries,
  myToolRegistries,
  removeToolRegistry,
  updateToolRegistry,
  type EffectiveToolRegistry,
  type RegistryListScope,
  type ToolRegistryList,
} from "../api.js";
import { Badge, Button, Disclosure, ErrorState, Switch, useConfirm, useToast } from "../ui/index.js";
import {
  BUILTIN_FALLBACK,
  groupListings,
  loadRegistry,
  previewRegistrySource,
  type Listing,
  type LoadedRegistry,
} from "./registries.js";

/** A key's fingerprint, computed in the browser. */
function useFingerprint(key: string): string | null {
  const [fp, setFp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void authorityFingerprint(key).then((f) => live && setFp(f));
    return () => {
      live = false;
    };
  }, [key]);
  return fp;
}

function Fingerprint(props: { value: string | null; label?: string }) {
  return (
    <span className="reg-fp">
      {props.label ?? "Key"} <span className="mono">{props.value ?? "…"}</span>
    </span>
  );
}

/** Every registry this visitor sees, each loaded and checked against its pinned key on its own. */
export function useToolRegistries() {
  const [list, setList] = useState<ToolRegistryList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedRegistry[]>([]);
  const [tick, setTick] = useState(0);

  const loadOne = useCallback((reg: EffectiveToolRegistry, live: () => boolean) => {
    setLoaded((cur) => cur.map((x) => (x.reg.id === reg.id ? { ...x, state: { kind: "loading" } } : x)));
    void loadRegistry(reg, API_BASE, location.href).then((state) => {
      if (live()) setLoaded((cur) => cur.map((x) => (x.reg.id === reg.id ? { ...x, state } : x)));
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const live = () => alive;
    void (async () => {
      let l: ToolRegistryList;
      try {
        l = await listToolRegistries();
        setListError(null);
      } catch (e) {
        // without the gateway, the registry bundled with the app still loads
        l = { registries: [BUILTIN_FALLBACK], players: { allowed: false, signedIn: false, stored: 0 }, proxy: false };
        setListError(errorText(e));
      }
      if (!alive) return;
      const initial = await Promise.all(
        l.registries.map(async (reg) => ({
          reg,
          fingerprint: await authorityFingerprint(reg.authority),
          state: { kind: "loading" } as const,
        })),
      );
      if (!alive) return;
      setList(l);
      setLoaded(initial);
      for (const reg of l.registries) loadOne(reg, live);
    })();
    return () => {
      alive = false;
    };
  }, [tick, loadOne]);

  return {
    list,
    listError,
    loaded,
    reload: () => setTick((t) => t + 1),
    retry: (reg: EffectiveToolRegistry) => loadOne(reg, () => true),
  };
}

const scopeBadge = (reg: ToolRegistryEntry) =>
  reg.scope === "account" ? (
    <Badge kind="warn" title="Added by you, not checked by this instance">
      yours
    </Badge>
  ) : (
    <Badge title="Configured by this instance's sysop">instance</Badge>
  );

/** A listing matches the filter when its name, title or description contains every word of it. */
function listingMatches(l: Listing, filter: string): boolean {
  const hay = `${l.entry.name} ${l.entry.title} ${l.entry.description ?? ""}`.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** The tools of every registry, grouped by registry, each group with its own state. */
export function RegistryGroups(props: {
  loaded: LoadedRegistry[];
  /** The names of the tools this player installed: their listings say so instead of offering an install. */
  installed: ReadonlySet<string>;
  /** Only listings matching these words show. */
  filter?: string;
  onInstall: (l: Listing) => void;
  onRetry: (reg: EffectiveToolRegistry) => void;
  onReconfirm: (reg: EffectiveToolRegistry, authority: string, fingerprint: string | null) => void;
}) {
  const filter = props.filter?.trim() ?? "";
  const groups = groupListings(props.loaded, location.href).map((g) => ({
    ...g,
    shown: filter ? g.listings.filter((l) => listingMatches(l, filter)) : g.listings,
  }));
  return (
    <>
      {groups.map(({ reg: l, listings, shown }) => (
        <section key={l.reg.id} className="tool-sub reg-group" aria-busy={l.state.kind === "loading"}>
          <header className="reg-head">
            <strong>{l.reg.label}</strong> {scopeBadge(l.reg)}
            <Fingerprint value={l.fingerprint} />
          </header>
          {l.reg.scope === "account" && <p className="muted fine">Added by you, not checked by this instance.</p>}
          <RegistryBody
            l={l}
            listings={listings}
            shown={shown}
            filter={filter}
            installed={props.installed}
            onInstall={props.onInstall}
            onRetry={() => props.onRetry(l.reg)}
            onReconfirm={props.onReconfirm}
          />
        </section>
      ))}
    </>
  );
}

function RegistryBody(props: {
  l: LoadedRegistry;
  listings: Listing[];
  shown: Listing[];
  filter: string;
  installed: ReadonlySet<string>;
  onInstall: (l: Listing) => void;
  onRetry: () => void;
  onReconfirm: (reg: EffectiveToolRegistry, authority: string, fingerprint: string | null) => void;
}) {
  const { l } = props;
  const who = l.reg.scope === "account" ? "you confirm" : "the sysop confirms";
  switch (l.state.kind) {
    case "loading":
      return (
        <p className="muted fine" role="status">
          Loading {l.reg.label}…
        </p>
      );
    case "none":
      return <p className="muted fine">This instance serves no project registry.</p>;
    case "failed":
      return (
        <ErrorState onRetry={props.onRetry}>
          Couldn&apos;t load {l.reg.label}: {l.state.error}. The other registries are not affected.
        </ErrorState>
      );
    case "format":
      return (
        <ErrorState onRetry={props.onRetry}>
          {l.reg.label} can&apos;t be read: {l.state.error}. Its tools are not listed until this instance is updated.
        </ErrorState>
      );
    case "invalid":
      return (
        <ErrorState onRetry={props.onRetry}>
          {l.reg.label} failed its signature check under the pinned key, so its tools are not listed.
          {l.reg.scope === "instance" && " Tell the instance's sysop."}
        </ErrorState>
      );
    case "key-changed": {
      const st = l.state;
      return (
        <div className="tool-prompt" role="alert">
          <p>
            <strong>Key changed.</strong> The registry is now signed by key{" "}
            <span className="mono">{st.fingerprint ?? "?"}</span>, not the pinned{" "}
            <span className="mono">{l.fingerprint ?? "?"}</span>. Its tools stay hidden until {who} the new key.
          </p>
          {l.reg.scope === "account" && (
            <Button onClick={() => props.onReconfirm(l.reg, st.authority, st.fingerprint)}>
              Compare and confirm the new key…
            </Button>
          )}
        </div>
      );
    }
    case "ok":
      if (l.state.entries.length === 0) return <p className="muted fine">This registry lists no tools yet.</p>;
      return (
        <>
          {l.state.stale && (
            <p className="muted fine">
              The registry&apos;s host can&apos;t be reached; this is the copy this instance kept.
            </p>
          )}
          {props.listings.length === 0 && <p className="muted fine">Every tool it lists is shown above.</p>}
          {props.listings.length > 0 && props.shown.length === 0 && (
            <p className="muted fine">No tool here matches &ldquo;{props.filter}&rdquo;.</p>
          )}
          {props.shown.map((x) => (
            <div key={`${x.entry.name}:${x.manifestUrl}`} className="tool-row">
              <div className="tool-meta">
                <strong>{x.entry.title}</strong>{" "}
                <span className="muted fine">
                  v{x.entry.version} · {x.entry.author}
                </span>
                {x.entry.description && <div className="muted fine">{x.entry.description}</div>}
                {x.sources.length > 1 && <div className="muted fine">Listed by {x.sources.join(", ")}</div>}
              </div>
              {props.installed.has(x.entry.name) ? (
                <Badge kind="found" title="This tool is in your tools above">
                  Installed
                </Badge>
              ) : (
                <Button onClick={() => props.onInstall(x)} hint={`Check ${x.entry.title} and approve its permissions`}>
                  Install…
                </Button>
              )}
            </div>
          ))}
        </>
      );
  }
}

/**
 * Add a registry: check the address, fetch the file once (through this instance while it carries registries),
 * show its key's fingerprint, the number of tools and a sample, and pin the key only on the person's word.
 */
export function RegistryAddForm(props: {
  scope: RegistryListScope;
  proxy: boolean;
  onAdded: () => void;
  children?: ReactNode;
}) {
  const toast = useToast();
  const id = useId();
  const [spec, setSpec] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; spec: string; p: RegistryPreview } | null>(null);

  const check = async () => {
    const where = registrySourceUrl(spec);
    if ("error" in where) {
      setErr(where.error);
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await previewRegistrySource(where.spec, where.url, props.proxy, API_BASE);
    setBusy(false);
    if (!r.ok) setErr(r.error);
    else setPreview({ url: where.url, spec: where.spec, p: r.preview });
  };
  const pin = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const reg = await addToolRegistry(props.scope, {
        spec: preview.spec,
        authority: preview.p.authority,
        label: label.trim() || undefined,
      });
      toast(`Added ${reg.label}, pinned to key ${preview.p.fingerprint}.`);
      setSpec("");
      setLabel("");
      setPreview(null);
      props.onAdded();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reg-add" aria-busy={busy}>
      {!preview ? (
        <>
          <label htmlFor={`${id}-spec`}>Registry address</label>
          <input
            id={`${id}-spec`}
            value={spec}
            onChange={(e) => {
              setSpec(e.target.value);
              setErr(null);
            }}
            placeholder="github:owner/repo or https://…/registry.json"
            className="mono"
            aria-invalid={!!err || undefined}
            aria-describedby={err ? `${id}-err` : `${id}-help`}
            onKeyDown={(e) => {
              if (e.key === "Enter") void check();
            }}
          />
          <p className="muted fine" id={`${id}-help`}>
            <span className="mono">github:owner/repo[/path][@tag]</span>, a GitHub Pages address, or any https address.
          </p>
          <label htmlFor={`${id}-label`}>
            Label <span className="muted fine">(optional)</span>
          </label>
          <input id={`${id}-label`} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <div className="row gap-2">
            <Button variant="primary" disabled={busy || !spec.trim()} onClick={() => void check()}>
              {busy ? "Fetching…" : "Fetch and show its key"}
            </Button>
          </div>
        </>
      ) : (
        <div className="tool-prompt">
          <p className="mono fine">{preview.url}</p>
          <p>
            Key fingerprint: <strong className="mono reg-fp-big">{preview.p.fingerprint}</strong>
          </p>
          <p className="muted fine">
            Lists {preview.p.count} {preview.p.count === 1 ? "tool" : "tools"}
            {preview.p.titles.length > 0 &&
              `: ${preview.p.titles.join(", ")}${preview.p.count > preview.p.titles.length ? ", …" : ""}`}
          </p>
          <p>
            Compare this fingerprint with the one the registry&apos;s publisher gives you, in their README, on their
            site or in person. Pin it only if every digit matches: this instance then trusts only this key for the
            registry.
          </p>
          <div className="row gap-2 end">
            <Button disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void pin()}>
              It matches: pin and add
            </Button>
          </div>
        </div>
      )}
      {err && (
        <p className="error fine" role="alert" id={`${id}-err`}>
          {err}
        </p>
      )}
      {props.children}
    </div>
  );
}

/** Confirm a registry's new key after a "key changed": show both fingerprints and ask. */
export function useReconfirm(scope: RegistryListScope, after: () => void) {
  const confirm = useConfirm();
  const toast = useToast();
  return async (reg: ToolRegistryEntry, authority: string, fingerprint: string | null) => {
    const pinned = await authorityFingerprint(reg.authority);
    const ok = await confirm({
      title: `Confirm the new key of ${reg.label}?`,
      message: (
        <>
          <p>
            Pinned key: <span className="mono">{pinned ?? "?"}</span>
            <br />
            New key: <strong className="mono">{fingerprint ?? "?"}</strong>
          </p>
          <p>
            Confirm only if the publisher told you, through a channel you trust, that they changed the key and gave you
            this fingerprint. Otherwise someone else may be signing the registry.
          </p>
        </>
      ),
      confirmLabel: "It matches: pin the new key",
      danger: true,
    });
    if (!ok) return;
    try {
      await confirmToolRegistryKey(scope, reg.id, authority);
      toast(`${reg.label} is pinned to key ${fingerprint}.`);
      after();
    } catch (e) {
      toast(errorText(e));
    }
  };
}

/** One registry in a managed list: label, address, key, on/off and Remove. */
export function RegistryRow(props: {
  reg: ToolRegistryEntry;
  locked?: boolean;
  onToggle?: (on: boolean) => void;
  onRemove?: () => void;
  extra?: ReactNode;
}) {
  const fp = useFingerprint(props.reg.authority);
  const r = props.reg;
  return (
    <div className="tool-row">
      <div className="tool-meta">
        <strong>{r.label}</strong> {r.builtin && <Badge title="Bundled with every release">bundled</Badge>}
        <div className="muted fine mono reg-url">{r.spec}</div>
        <div className="fine">
          <Fingerprint value={fp} />
        </div>
        {props.extra}
      </div>
      <div className="tool-ctl">
        {props.onRemove && !r.builtin && (
          <Button variant="inline-danger" disabled={props.locked} onClick={props.onRemove}>
            Remove
          </Button>
        )}
        {props.onToggle && (
          <Switch label={r.label} checked={r.enabled} disabled={props.locked} onChange={props.onToggle} />
        )}
      </div>
    </div>
  );
}

/** The signed-in player's own registries, in the Tools app. */
export function MyRegistries(props: { list: ToolRegistryList; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [mine, setMine] = useState<ToolRegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    myToolRegistries()
      .then((r) => live && (setMine(r.registries), setError(null)))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [tick]);
  const changed = () => {
    setTick((t) => t + 1);
    props.onChanged();
  };
  const remove = async (r: ToolRegistryEntry) => {
    const ok = await confirm({
      title: `Remove ${r.label}?`,
      message: "Its tools leave the Registry list. Tools you imported from it keep running until you reload.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeToolRegistry("my", r.id);
      toast(`Removed ${r.label}.`);
      changed();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const toggle = async (r: ToolRegistryEntry, on: boolean) => {
    try {
      await updateToolRegistry("my", r.id, { enabled: on });
      changed();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const allowed = props.list.players.allowed;
  const count = mine?.length ?? props.list.players.stored;
  if (!allowed && count === 0) return null;

  return (
    <div className="tool-sub">
      <Disclosure variant="section" label={`Your registries (${count} of ${REGISTRIES_PER_ACCOUNT})`}>
        {!allowed && (
          <p className="muted fine">
            This instance doesn&apos;t let players add tool registries now. Yours are kept, not fetched, and come back
            if the sysop allows them again. You can still remove them.
          </p>
        )}
        {error && (
          <ErrorState onRetry={() => setTick((t) => t + 1)}>Couldn&apos;t load your registries: {error}</ErrorState>
        )}
        {mine?.length === 0 && <p className="muted fine">You have added no registry.</p>}
        <div className="tools-list">
          {mine?.map((r) => (
            <RegistryRow
              key={r.id}
              reg={r}
              onToggle={allowed ? (on) => void toggle(r, on) : undefined}
              onRemove={() => void remove(r)}
            />
          ))}
        </div>
        {allowed && count < REGISTRIES_PER_ACCOUNT && (
          <RegistryAddForm scope="my" proxy={props.list.proxy} onAdded={changed}>
            <p className="muted fine">
              A registry you add is for you alone, and this instance does not check it. Its tools still run sandboxed in
              your browser and ask for every gated permission.
            </p>
          </RegistryAddForm>
        )}
      </Disclosure>
    </div>
  );
}
