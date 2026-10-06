// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import type { ToolRegistryEntry } from "@aprscaching/shared";
import {
  API_BASE,
  adminToolRegistries,
  errorText,
  removeToolRegistry,
  updateToolRegistry,
  type EffectiveToolRegistry,
} from "../api.js";
import { Badge, Button, ErrorState, useConfirm, useLoad, useToast } from "../ui/index.js";
import { loadRegistry, type RegistryState } from "../tools/registries.js";
import { RegistryAddForm, RegistryRow, useReconfirm } from "../tools/RegistryViews.js";

/**
 * Instance settings → Tools → Registries: the tool registries every player's Tools app lists. The project
 * registry bundled with the app comes first and can be switched off; the sysop adds others by address, each pinned
 * to the key whose fingerprint they compared. Each row shows whether its file currently verifies under the pinned
 * key, and a "key changed" row offers to confirm the new key. While TOOL_REGISTRIES sets the list in the
 * environment, it shows read-only.
 */
export function ToolRegistriesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad(() => adminToolRegistries(), []);
  const reconfirm = useReconfirm("admin", reload);
  const [states, setStates] = useState<Record<string, RegistryState>>({});

  // check each switched-on registry the way players' browsers do, so a changed key shows here too
  useEffect(() => {
    if (!data) return;
    let live = true;
    for (const reg of data.registries) {
      if (!reg.enabled) continue;
      const eff: EffectiveToolRegistry = { ...reg, proxied: data.proxy && !reg.builtin && !reg.url.startsWith("/") };
      setStates((s) => ({ ...s, [reg.id]: { kind: "loading" } }));
      void loadRegistry(eff, API_BASE, location.href).then((st) => live && setStates((s) => ({ ...s, [reg.id]: st })));
    }
    return () => {
      live = false;
    };
  }, [data]);

  if (error && !data) return <ErrorState onRetry={reload}>Couldn&apos;t load the tool registries.</ErrorState>;
  if (!data)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  const locked = data.source === "env";
  const toggle = async (r: ToolRegistryEntry, on: boolean) => {
    try {
      await updateToolRegistry("admin", r.id, { enabled: on });
      toast(`${r.label} switched ${on ? "on" : "off"}.`);
      reload();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const remove = async (r: ToolRegistryEntry) => {
    const ok = await confirm({
      title: `Remove ${r.label}?`,
      message: "Its tools leave every player's Registry list. Tools players imported from it run until they reload.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeToolRegistry("admin", r.id);
      toast(`Removed ${r.label}.`);
      reload();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const status = (r: ToolRegistryEntry) => {
    if (!r.enabled) return <span className="muted fine">Switched off</span>;
    const st = states[r.id];
    if (!st || st.kind === "loading") return <span className="muted fine">Checking…</span>;
    if (st.kind === "ok")
      return (
        <span className="fine">
          <Badge kind="found">verifies</Badge> {st.entries.length} {st.entries.length === 1 ? "tool" : "tools"}
          {st.stale && " · the copy this instance kept"}
        </span>
      );
    if (st.kind === "key-changed")
      return (
        <span className="fine" role="alert">
          <Badge kind="dnf">key changed</Badge> now signed by <span className="mono">{st.fingerprint}</span>; hidden
          from players until you confirm it.{" "}
          {!locked && (
            <Button variant="inline" onClick={() => void reconfirm(r, st.authority, st.fingerprint)}>
              Compare and confirm…
            </Button>
          )}
        </span>
      );
    if (st.kind === "invalid") return <Badge kind="dnf">signature check failed</Badge>;
    if (st.kind === "none") return <span className="muted fine">not served</span>;
    return <span className="error fine">{st.error}</span>;
  };

  return (
    <div className="iset">
      <div className="setrow-l">
        <div>Registries</div>
        <div className="muted setrow-help">
          The signed tool lists every player&apos;s Tools app shows. Tools run sandboxed in each player&apos;s browser,
          never on this instance.
        </div>
      </div>
      {locked && (
        <p className="muted fine">
          <Badge kind="warn">Set by the environment</Badge> <span className="mono">TOOL_REGISTRIES</span> sets this
          list: change it there and restart the gateway.
        </p>
      )}
      {data.envError && (
        <p className="error fine" role="alert">
          {data.envError}. No registry is listed until it is fixed.
        </p>
      )}
      <div className="tools-list">
        {data.registries.map((r) => (
          <RegistryRow
            key={r.id}
            reg={r}
            locked={locked}
            onToggle={(on) => void toggle(r, on)}
            onRemove={() => void remove(r)}
            extra={<div>{status(r)}</div>}
          />
        ))}
      </div>
      {!locked && data.registries.filter((r) => !r.builtin).length < data.max && (
        <RegistryAddForm scope="admin" proxy={data.proxy} onAdded={reload} />
      )}
    </div>
  );
}
