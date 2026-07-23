// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { STATION_ROLES, type StationRole } from "@aprscaching/shared";
import {
  listMyStations,
  createStation,
  updateStation,
  deleteStation,
  stationToCache,
  becomeACache,
  getStationWxKey,
  issueStationWxKey,
  type OperatedStation,
  type StationInput,
  type StationWxKey,
} from "../api.js";
import { useFmt } from "../format.js";
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadMore,
  copyText,
  useChoice,
  useConfirm,
  usePaged,
  useToast,
} from "../ui/index.js";
import { WxTxToggles } from "./WxTxToggles.js";

const ROLE_LABEL: Record<StationRole, string> = {
  weather: "Weather",
  digipeater: "Digipeater",
  igate: "IGate",
  node: "Node",
  relay: "Relay",
};

/**
 * Settings → My stations. Manage the operator's own stations — a home weather PWS, a
 * mountain-top digipeater / igate / node — each with its own callsign+SSID, explicit location,
 * description and roles. Weather-capable stations carry their own PWS push key. Paginated.
 */
export function MyStations(props: { callsign: string }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const stations = usePaged(
    (cursor) =>
      listMyStations(cursor).then((r) => ({ items: r.stations, nextCursor: r.nextCursor, hasMore: r.hasMore })),
    [props.callsign],
  );
  const base = props.callsign.toUpperCase().split("-")[0] ?? "";
  const [draft, setDraft] = useState<StationInput>({ callsign: base ? `${base}-` : "", roles: [] });

  async function add() {
    try {
      await createStation({ ...draft, callsign: draft.callsign?.trim().toUpperCase() });
      setDraft({ callsign: base ? `${base}-` : "", roles: [] });
      toast("Station added");
      stations.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function becomeCache() {
    const ok = await confirmDialog({
      title: "Become a cache",
      message: "Put yourself on the map as a live cache others can find when you beacon?",
      confirmLabel: "Become a cache",
    });
    if (!ok) return;
    try {
      const r = await becomeACache();
      toast(`You're a cache now: ${r.cache.code}`);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (props.callsign.length < 3) return <p className="muted">Sign in to manage your stations.</p>;
  return (
    <>
      <p className="muted">
        Your operated stations — a home weather PWS, a remote digipeater/igate/node on a mountain. Each has its own
        callsign, location and roles; weather-capable stations get a push key. The callsign need not be your own (clubs,
        inherited infrastructure). Set a location, or leave it blank to adopt a station already heard on the map — and
        tap any station pin to add it directly.
      </p>
      <p className="muted fine">
        Running infrastructure feeds the commons: every IGate and digi you operate helps corroborate other people's
        finds (Tier&nbsp;A). It's recognised, never gated.
      </p>
      <div className="row end">
        <button onClick={becomeCache}>★ Become a cache</button>
      </div>

      {stations.error && stations.items.length === 0 ? (
        <ErrorState onRetry={stations.reload} />
      ) : stations.items.length === 0 ? (
        <EmptyState>No stations yet — add your first below.</EmptyState>
      ) : (
        stations.items.map((s) => <StationCard key={s.id} station={s} onChanged={stations.reload} />)
      )}
      <LoadMore
        hasMore={stations.hasMore}
        loading={stations.loading}
        onClick={stations.loadMore}
        label="Load more stations"
      />

      <h4>Add a station</h4>
      <StationFields value={draft} onChange={setDraft} callsignEditable />
      <div className="row end mt-2">
        <button className="primary" onClick={add} disabled={!draft.callsign || draft.callsign.endsWith("-")}>
          Add station
        </button>
      </div>
    </>
  );
}

/** One station: a summary header + an edit disclosure (fields, save/remove, weather key). */
function StationCard(props: { station: OperatedStation; onChanged: () => void }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const choose = useChoice();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<StationInput>(toInput(props.station));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await updateStation(props.station.id, edit);
      toast("Station saved");
      props.onChanged();
      setOpen(false);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const ok = await confirmDialog({
      title: `Remove ${props.station.callsign}?`,
      message: "Its weather push key (if any) is revoked.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteStation(props.station.id);
      toast("Station removed");
      props.onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="station-card">
      <button className="station-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mono station-call">{props.station.callsign}</span>
        <span className="badges">
          {props.station.roles.map((r) => (
            <Badge key={r}>{ROLE_LABEL[r]}</Badge>
          ))}
        </span>
        <span className="muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="station-body">
          <StationFields value={edit} onChange={setEdit} />
          <div className="row between mt-2">
            <button className="danger" onClick={remove}>
              Remove
            </button>
            <button className="primary" onClick={save} disabled={busy}>
              Save
            </button>
          </div>
          <div className="row end mt-1">
            <button
              onClick={async () => {
                // a real three-way decision — Cancel commits nothing (ui-ux.md §1.8)
                const kind = await choose({
                  title: "Turn into a cache",
                  message: "A living cache follows this station's beacon; a fixed cache stays at its current position.",
                  choices: [
                    { label: "Living cache", value: "living", primary: true },
                    { label: "Fixed cache", value: "fixed" },
                  ],
                });
                if (kind == null) return;
                try {
                  const r = await stationToCache(props.station.id, { living: kind === "living" });
                  toast(`Cache created: ${r.cache.code}`);
                } catch (e) {
                  toast((e as Error).message);
                }
              }}
            >
              ⚑ Turn into a cache
            </button>
          </div>
          {props.station.roles.includes("weather") && <StationWxKeyPanel stationId={props.station.id} />}
        </div>
      )}
    </div>
  );
}

/** Shared field set for create + edit. Callsign is only editable on create. */
function StationFields(props: {
  value: StationInput;
  onChange: (v: StationInput) => void;
  callsignEditable?: boolean;
}) {
  const v = props.value;
  const set = (patch: Partial<StationInput>) => props.onChange({ ...v, ...patch });
  const toggleRole = (r: StationRole) => {
    const has = (v.roles ?? []).includes(r);
    set({ roles: has ? (v.roles ?? []).filter((x) => x !== r) : [...(v.roles ?? []), r] });
  };
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <>
      {props.callsignEditable && (
        <label>
          Callsign <span className="muted">(with SSID, e.g. OE8APR-1)</span>
          <input
            className="mono"
            value={v.callsign ?? ""}
            maxLength={11}
            placeholder="OE8APR-1"
            onChange={(e) => set({ callsign: e.target.value.toUpperCase() })}
          />
        </label>
      )}
      <div className="row gap-2">
        <label className="flex-1">
          Latitude{" "}
          <input
            className="mono"
            inputMode="decimal"
            value={v.lat ?? ""}
            placeholder="47.07"
            onChange={(e) => set({ lat: numOrNull(e.target.value) })}
          />
        </label>
        <label className="flex-1">
          Longitude{" "}
          <input
            className="mono"
            inputMode="decimal"
            value={v.lon ?? ""}
            placeholder="15.42"
            onChange={(e) => set({ lon: numOrNull(e.target.value) })}
          />
        </label>
      </div>
      <label>
        Description{" "}
        <input
          value={v.description ?? ""}
          maxLength={280}
          placeholder="Schöckl summit digipeater"
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <fieldset className="roles">
        <legend>Roles</legend>
        {STATION_ROLES.map((r) => (
          <label key={r} className="role-check">
            <input type="checkbox" checked={(v.roles ?? []).includes(r)} onChange={() => toggleRole(r)} />{" "}
            {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** Per-station weather PWS key: issue + copy the ready-to-paste Ecowitt / WU URLs. */
function StationWxKeyPanel(props: { stationId: number }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const [info, setInfo] = useState<StationWxKey | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setError(false);
    getStationWxKey(props.stationId)
      .then(setInfo)
      .catch(() => setError(true));
  };
  useEffect(load, [props.stationId]);
  async function issue() {
    if (
      info?.key &&
      !(await confirmDialog({
        title: "Issue a new key?",
        message: "The station stops reporting until you update its push URL with the new key.",
        confirmLabel: "Issue new key",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      setInfo(await issueStationWxKey(props.stationId));
      toast(info?.key ? "New key issued" : "Weather push enabled");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const copy = async (val: string, what: string) => {
    toast((await copyText(val)) ? `${what} copied` : "Copy failed — select the text and copy manually");
  };
  if (error)
    return (
      <div className="wx-key">
        <h5>Weather push</h5>
        <ErrorState onRetry={load}>Couldn't load this station's weather-push state.</ErrorState>
      </div>
    );
  return (
    <div className="wx-key">
      <h5>Weather push</h5>
      {!info?.key ? (
        <div className="row end">
          <button className="primary" onClick={issue} disabled={busy}>
            Enable weather push
          </button>
        </div>
      ) : (
        <>
          <label>
            Ecowitt — custom server path
            <span className="copyrow">
              <input
                className="mono"
                readOnly
                value={info.ecowittPath ?? ""}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                className="iconbtn"
                aria-label="Copy Ecowitt URL"
                onClick={() => void copy(info.ecowittPath ?? "", "Ecowitt URL")}
              >
                Copy
              </button>
            </span>
          </label>
          <label>
            Weather Underground — Rapidfire URL
            <span className="copyrow">
              <input className="mono" readOnly value={info.wuUrl ?? ""} onFocus={(e) => e.currentTarget.select()} />
              <button
                className="iconbtn"
                aria-label="Copy Weather Underground URL"
                onClick={() => void copy(info.wuUrl ?? "", "WU URL")}
              >
                Copy
              </button>
            </span>
          </label>
          <p className="muted fine">Last reading: {info.lastSeen ? fmt.dateTime(info.lastSeen) : "—"}.</p>
          <h5 className="mt-2">Transmit (optional)</h5>
          <WxTxToggles stationId={props.stationId} txIs={info.txIs} txCwop={info.txCwop} verified={info.verified} />
          <div className="row end">
            <button onClick={issue} disabled={busy}>
              Re-issue key
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function toInput(s: OperatedStation): StationInput {
  return {
    callsign: s.callsign,
    lat: s.lat,
    lon: s.lon,
    symbol: s.symbol,
    description: s.description ?? "",
    roles: s.roles,
  };
}
