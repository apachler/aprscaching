// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { API_BASE, createApiKey, errorText, listApiKeys, revokeApiKey, type ApiKey } from "../api.js";
import { useFmt } from "../format.js";
import {
  Button,
  CommandBlock,
  EmptyState,
  ErrorState,
  ManualLink,
  useConfirm,
  useLoad,
  useToast,
} from "../ui/index.js";

/**
 * Settings → Developer: the account's read-API keys. A key raises the read API's rate limit for an app or script
 * and gates nothing. The full key shows once, right after it is created; the list shows each key's prefix.
 */
export function ApiKeys() {
  const fmt = useFmt();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad(() => listApiKeys(), []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ key: string; name: string } | null>(null);

  const full = !!data && data.keys.length >= data.cap;
  async function create() {
    const n = name.trim();
    if (!n) {
      setFormErr("Name the key after the app or script that uses it.");
      return;
    }
    setBusy(true);
    setFormErr(null);
    try {
      const k = await createApiKey(n);
      setIssued({ key: k.key, name: k.name });
      setName("");
      toast("API key created");
      reload();
    } catch (e) {
      setFormErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: ApiKey) {
    const ok = await confirm({
      title: `Revoke the key "${k.name}"?`,
      message: `${k.prefix}… stops working at once. Anything that uses it falls back to the limit without a key.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeApiKey(k.id);
      toast("API key revoked");
      if (issued && k.prefix === issued.key.slice(0, k.prefix.length)) setIssued(null);
      reload();
    } catch (e) {
      toast(errorText(e));
    }
  }

  const base = API_BASE || window.location.origin;
  return (
    <>
      <p className="muted fine">
        A key lets an app or script make more requests. See the{" "}
        <ManualLink page="reference/api" anchor="public-read-api">
          read API
        </ManualLink>
        .
      </p>
      <div className="partner-form">
        <label>
          Key name
          <input
            placeholder="my logbook sync"
            value={name}
            maxLength={60}
            disabled={full}
            aria-invalid={!!formErr}
            aria-describedby="apikey-help"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
        </label>
        <p id="apikey-help" className="muted fine">
          {data
            ? full
              ? `You have ${data.cap} keys, the most this instance allows: revoke one to create another.`
              : `${data.keys.length} of ${data.cap} keys in use.`
            : "Name the key after the app or script that uses it."}
        </p>
        <div className="row end">
          <Button variant="primary" disabled={busy || !data || full} aria-busy={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create key"}
          </Button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}
      {issued && (
        <div role="status">
          <p>Copy the key for &quot;{issued.name}&quot; now: it is not shown again.</p>
          <CommandBlock label="Your new key" command={issued.key} copied="Key copied" />
          <CommandBlock
            label="Try it"
            command={`curl -H "Authorization: Bearer ${issued.key}" "${base}/api/v1/activity"`}
          />
          <div className="row end">
            <Button variant="inline" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      <h4 className="set-subh">Your keys</h4>
      {error ? (
        <ErrorState onRetry={reload}>Couldn&apos;t load your API keys.</ErrorState>
      ) : !data ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : data.keys.length === 0 ? (
        <EmptyState>No API keys yet. Create one above for an app or script that reads this instance.</EmptyState>
      ) : (
        <ul className="logs">
          {data.keys.map((k) => (
            <li key={k.id}>
              <span>{k.name}</span>
              <span className="muted">
                {" "}
                · <span className="mono">{k.prefix}…</span> · created {fmt.date(k.createdAt)} ·{" "}
                {k.lastUsedAt ? `last used ${fmt.date(k.lastUsedAt)}` : "never used"}
              </span>
              <Button variant="inline-danger" aria-label={`Revoke the key ${k.name}`} onClick={() => void revoke(k)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
