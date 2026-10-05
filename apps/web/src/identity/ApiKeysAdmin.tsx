// SPDX-License-Identifier: AGPL-3.0-or-later
import { adminRevokeApiKey, errorText, listAllApiKeys, type ApiKey } from "../api.js";
import { useFmt } from "../format.js";
import { Button, EmptyState, ErrorState, useConfirm, useLoad, useToast } from "../ui/index.js";

/**
 * Instance admin → API keys: every read-API key on the instance, with its owner, most recently used first. The
 * sysop revokes a key that is misused, such as one that scrapes; its owner may create another within the cap.
 */
export function ApiKeysAdmin() {
  const fmt = useFmt();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad(() => listAllApiKeys(), []);

  async function revoke(k: ApiKey & { owner: string | null }) {
    const ok = await confirm({
      title: `Revoke the key "${k.name}"?`,
      message: `${k.prefix}…${k.owner ? ` of ${k.owner}` : ""} stops working at once. Its owner sees it gone from their list.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await adminRevokeApiKey(k.id);
      toast("API key revoked");
      reload();
    } catch (e) {
      toast(errorText(e));
    }
  }

  if (error) return <ErrorState onRetry={reload}>Couldn&apos;t load the API keys.</ErrorState>;
  if (!data)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  return (
    <>
      <p className="muted fine">
        Members create keys under Settings → Developer, up to {data.cap} each (
        <span className="mono">API_KEYS_PER_ACCOUNT</span>). A key raises the read-API rate limit and gates nothing.
      </p>
      {data.keys.length === 0 ? (
        <EmptyState>No member has created an API key yet.</EmptyState>
      ) : (
        <ul className="logs">
          {data.keys.map((k) => (
            <li key={k.id}>
              <span className="mono">{k.owner ?? "?"}</span>
              <span className="muted">
                {" "}
                · {k.name} · <span className="mono">{k.prefix}…</span> · created {fmt.date(k.createdAt)} ·{" "}
                {k.lastUsedAt ? `last used ${fmt.date(k.lastUsedAt)}` : "never used"}
              </span>
              <Button
                variant="inline-danger"
                aria-label={`Revoke the key ${k.name} of ${k.owner ?? "an unknown owner"}`}
                onClick={() => void revoke(k)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
