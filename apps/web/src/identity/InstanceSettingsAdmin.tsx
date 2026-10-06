// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useState, type ReactNode } from "react";
import { errorText, getSiteSettings, resetSiteSetting, saveSiteSetting, type SiteSettingView } from "../api.js";
import { useFmt } from "../format.js";
import {
  Badge,
  Button,
  ChipToggle,
  ErrorState,
  Group,
  Segmented,
  Switch,
  TIER_NAME,
  useConfirm,
  useLoad,
  useToast,
} from "../ui/index.js";
import {
  controlKind,
  defaultText,
  draftOf,
  flagOn,
  groupStatus,
  isDirty,
  matches,
  sourceBadge,
  submission,
  type Draft,
  type Link,
} from "./instanceSettings.js";
import { ToolRegistriesAdmin } from "./ToolRegistriesAdmin.js";

/**
 * Instance admin → Instance settings: the policy values of this instance — game rules, API limits, retention,
 * imports, tools and their registries, the imprint, donation links and the update check — grouped, searchable with the admin panel's own
 * search, each with its source. A value the environment sets wins and shows read-only with the reason; any
 * other is saved here (stored in the database) or reset to its default. The gateway checks and audit-logs each
 * change; infrastructure and secrets stay in the environment and never appear here.
 */
export function InstanceSettingsAdmin(props: { q: string }) {
  const { data, error, reload, setData } = useLoad(() => getSiteSettings(), []);
  if (error && !data) return <ErrorState onRetry={reload}>Couldn&apos;t load the instance settings.</ErrorState>;
  if (!data)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  const replace = (s: SiteSettingView) =>
    setData((d) => d && { ...d, settings: d.settings.map((x) => (x.key === s.key ? s : x)) });
  const byGroup = (q: string) =>
    data.groups
      .map((g) => ({ ...g, settings: data.settings.filter((s) => s.group === g.id && matches(s, g.title, q)) }))
      .filter((g) => g.settings.length > 0);
  // the admin search shows this group for its own words too ("policy", "limits"); a word no setting carries
  // shows every setting rather than an empty group
  const narrowed = byGroup(props.q);
  const searching = props.q.trim() !== "" && narrowed.length > 0;
  const shown = narrowed.length > 0 ? narrowed : byGroup("");
  return (
    <>
      <p className="muted fine">
        A value set in the environment wins and shows here read-only; change it there and restart the gateway.
        Everything else is saved here and applies at once. Secrets and addresses stay in the environment.
      </p>
      {shown.map((g) => (
        // a search opens every group it matches; clearing it closes them again
        <Group key={`${g.id}:${searching}`} title={g.title} status={groupStatus(g.settings)} defaultOpen={searching}>
          {g.settings.map((s) => (
            <SettingRow key={s.key} setting={s} onSaved={replace} />
          ))}
          {g.id === "tools" && <ToolRegistriesAdmin />}
        </Group>
      ))}
    </>
  );
}

function SettingRow(props: { setting: SiteSettingView; onSaved: (s: SiteSettingView) => void }) {
  const s = props.setting;
  const toast = useToast();
  const confirm = useConfirm();
  const fmt = useFmt();
  const id = useId();
  const kind = controlKind(s);
  const [draft, setDraft] = useState<Draft>(() => draftOf(s));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const locked = s.source === "env";
  const badge = sourceBadge(s);
  const errId = `${id}-err`;

  const apply = (next: SiteSettingView, message: string) => {
    props.onSaved(next);
    setDraft(draftOf(next));
    setErr(null);
    toast(message);
  };
  const save = async (value?: string) => {
    const r = value !== undefined ? { value } : submission(s, draft);
    if ("error" in r) {
      setErr(r.error);
      return;
    }
    setBusy(true);
    try {
      apply(await saveSiteSetting(s.key, r.value), `${s.label} saved`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    const ok = await confirm({
      title: `Reset ${s.label} to its default?`,
      message: `The value saved here is cleared and the default (${defaultText(s)}) applies at once.`,
      confirmLabel: "Reset",
    });
    if (!ok) return;
    setBusy(true);
    try {
      apply(await resetSiteSetting(s.key), `${s.label} reset to the default`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (d: Draft) => {
    setDraft(d);
    setErr(null);
  };
  // a switch and a choice take effect as they change; a field waits for Save
  const immediate = kind === "switch" || kind === "choice";
  const dirty = !immediate && isDirty(s, draft);

  return (
    <div className="iset" aria-busy={busy}>
      <div className="setrow">
        <div className="setrow-l">
          <div id={`${id}-label`}>{s.label}</div>
          <div className="muted setrow-help" id={`${id}-help`}>
            {s.hint}
          </div>
        </div>
        <div className="setrow-c">
          {kind === "switch" && (
            <Switch
              label={s.label}
              checked={flagOn(s.value)}
              disabled={locked || busy}
              onChange={(on) => void save(on ? "1" : "0")}
            />
          )}
          {kind === "choice" && (
            <Segmented
              label={s.label}
              value={s.value ?? ""}
              options={(s.values ?? []).map((v) => ({
                value: v,
                label: s.key === "MIN_TRUST" ? TIER_NAME[v as "A" | "B"] : v,
                disabled: locked || busy,
              }))}
              onChange={(v) => v !== s.value && void save(v)}
            />
          )}
        </div>
      </div>
      {!immediate && (
        <fieldset className="iset-edit" disabled={locked || busy} aria-labelledby={`${id}-label`}>
          <Editor setting={s} draft={draft} onChange={edit} invalid={!!err} describedBy={err ? errId : `${id}-help`} />
        </fieldset>
      )}
      <div className="iset-meta">
        <Badge kind={badge.kind} title={badge.title}>
          {badge.text}
        </Badge>
        {s.source === "site" && s.stored && (
          <span className="muted fine">
            by <span className="mono">{s.stored.by}</span>, {fmt.dateTime(s.stored.at)} · default: {defaultText(s)}
          </span>
        )}
        {s.source === "default" && <span className="muted fine">built-in value: {defaultText(s)}</span>}
        {locked && (
          <span className="muted fine">
            <span className="mono">{s.key}</span> is set in the environment, which wins: change it there and restart the
            gateway.
            {s.stored && ` A value saved here (${s.stored.value}) applies once the environment no longer sets it.`}
          </span>
        )}
        <span className="iset-actions">
          {s.source === "site" && (
            <Button variant="inline" disabled={busy} onClick={() => void reset()}>
              Reset to default
            </Button>
          )}
          {!immediate && !locked && (
            // the primary action only once there is something to save, so a page of settings has one at a time
            <Button
              variant={dirty ? "primary" : "secondary"}
              disabled={busy || !dirty}
              aria-busy={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </span>
      </div>
      {err && (
        <p className="error fine" role="alert" id={errId}>
          {err}
        </p>
      )}
    </div>
  );
}

/** The field a setting is edited in: a number with its unit, text, ticked ids, or a list of rows. */
function Editor(props: {
  setting: SiteSettingView;
  draft: Draft;
  onChange: (d: Draft) => void;
  invalid: boolean;
  describedBy: string;
}) {
  const s = props.setting;
  const aria = { "aria-invalid": props.invalid || undefined, "aria-describedby": props.describedBy };
  switch (controlKind(s)) {
    case "number":
      return (
        <label className="iset-num">
          <span className="sr-only">{s.label}</span>
          <input
            type="number"
            inputMode={s.type === "int" ? "numeric" : "decimal"}
            min={s.min ?? undefined}
            max={s.max ?? undefined}
            step={s.type === "int" ? 1 : "any"}
            value={props.draft as string}
            onChange={(e) => props.onChange(e.target.value)}
            {...aria}
          />
          {s.unit && <span className="muted">{s.unit}</span>}
          {s.min !== null && s.max !== null && (
            <span className="muted fine">
              {s.min}–{s.max}
            </span>
          )}
        </label>
      );
    case "options": {
      const ticked = props.draft as string[];
      return (
        <div className="badges" role="group" aria-label={s.label}>
          {(s.options ?? []).map((o) => (
            <ChipToggle
              key={o}
              pressed={ticked.includes(o)}
              onChange={(on) => props.onChange(on ? [...ticked, o] : ticked.filter((x) => x !== o))}
            >
              <span className="mono">{o}</span>
            </ChipToggle>
          ))}
        </div>
      );
    }
    case "contacts":
      return (
        <ListEditor
          rows={props.draft as string[]}
          empty=""
          addLabel="Add a contact"
          onChange={props.onChange}
          render={(v, set, n) => (
            <input
              type="text"
              inputMode="email"
              placeholder="security@example.net or https://example.net/security"
              aria-label={`Contact ${n}`}
              value={v}
              onChange={(e) => set(e.target.value)}
              {...aria}
            />
          )}
        />
      );
    case "links":
      return (
        <ListEditor<Link>
          rows={props.draft as Link[]}
          empty={{ label: "", url: "" }}
          addLabel="Add a link"
          onChange={props.onChange}
          render={(v, set, n) => (
            <>
              <input
                type="text"
                placeholder="Liberapay"
                aria-label={`Link ${n} label`}
                value={v.label}
                onChange={(e) => set({ ...v, label: e.target.value })}
                {...aria}
              />
              <input
                type="url"
                placeholder="https://liberapay.com/…"
                aria-label={`Link ${n} address`}
                value={v.url}
                onChange={(e) => set({ ...v, url: e.target.value })}
                {...aria}
              />
            </>
          )}
        />
      );
    case "retention": {
      const d = props.draft as Record<string, string>;
      return (
        <div className="iset-fields">
          {(s.fields ?? []).map((f) => (
            <label key={f.id}>
              {f.label}
              <span className="iset-num">
                <input
                  type="number"
                  inputMode="numeric"
                  min={f.min}
                  max={f.max}
                  step={1}
                  placeholder={String(f.default)}
                  value={d[f.id] ?? ""}
                  onChange={(e) => props.onChange({ ...d, [f.id]: e.target.value })}
                  {...aria}
                />
                <span className="muted">{f.unit}</span>
              </span>
            </label>
          ))}
          <p className="muted fine">A blank field keeps its default, shown greyed.</p>
        </div>
      );
    }
    default:
      return (
        <label className="iset-text">
          <span className="sr-only">{s.label}</span>
          <input
            type={s.format === "email" ? "email" : "text"}
            maxLength={s.maxLength ?? undefined}
            value={props.draft as string}
            onChange={(e) => props.onChange(e.target.value)}
            {...aria}
          />
        </label>
      );
  }
}

/** Rows of one kind, each removable, with an Add button below. */
function ListEditor<T>(props: {
  rows: T[];
  empty: T;
  addLabel: string;
  onChange: (rows: T[]) => void;
  render: (v: T, set: (v: T) => void, n: number) => ReactNode;
}) {
  const rows = props.rows.length ? props.rows : [props.empty];
  return (
    <div className="iset-list">
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            {props.render(r, (v) => props.onChange(rows.map((x, j) => (j === i ? v : x))), i + 1)}
            <Button
              variant="inline-danger"
              aria-label={`Remove row ${i + 1}`}
              onClick={() => props.onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <Button variant="inline" onClick={() => props.onChange([...rows, props.empty])}>
        {props.addLabel}
      </Button>
    </div>
  );
}
