// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
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
  updateCache,
  type OperatedStation,
  type StationInput,
} from "../api.js";
import { useFmt } from "../format.js";
import {
  Button,
  Badge,
  EmptyState,
  ErrorState,
  LoadMore,
  Row,
  Switch,
  copyText,
  useChoice,
  useConfirm,
  useLoad,
  usePaged,
  useToast,
  InfoTip,
  Disclosure,
} from "../ui/index.js";
import { TERMS } from "../terms.js";
import { WxTxToggles } from "./WxTxToggles.js";
import { SerialWeather } from "./SerialWeather.js";

const ROLE_LABEL: Record<StationRole, string> = {
  weather: "Weather",
  digipeater: "Digipeater",
  igate: "IGate",
  node: "Node",
  repeater: "Repeater",
};

/** A station callsign to show as an example: the operator's own base call with an SSID. */
const example = (base: string, ssid: number) => `${base || "N0CALL"}-${ssid}`;

/**
 * Settings → My stations. Manage the operator's own stations — a home weather PWS, a
 * mountain-top digipeater / igate / node — each with its own callsign+SSID, explicit location,
 * description and roles. Each weather station carries its own PWS push key, issued when it is added; **Add a
 * weather station** fills in the `-13` weather SSID and the Weather role. Paginated.
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
  // the weather station just added, whose push URLs show under the form at once
  const [addedWx, setAddedWx] = useState<{ id: number; callsign: string } | null>(null);

  async function add() {
    try {
      const r = await createStation({ ...draft, callsign: draft.callsign?.trim().toUpperCase() });
      setDraft({ callsign: base ? `${base}-` : "", roles: [] });
      setAddedWx(r.station.wx ? { id: r.station.id, callsign: r.station.callsign } : null);
      toast(r.station.wx ? "Weather station added: point it at its push URL" : "Station added");
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
        The stations you run: a weather station at home, a digipeater, IGate or node on a hill. Each has its own
        callsign, place and roles.
      </p>
      <Disclosure label="Which callsigns, and where a station sits">
        <p className="muted fine">
          A station&apos;s callsign is one of your own, verified: <span className="mono">{example(base, 9)}</span> needs{" "}
          <span className="mono">{base || "your call"}</span> on your account. A weather-only station needs no
          verification, since pushing weather needs no licence, and gets its own push key. A club station whose call you
          do not hold is listed for you by your sysop.
        </p>
        <p className="muted fine">
          Leave the place blank to adopt a station already heard on the map (a weather station then sits at your home
          locator), or tap any station pin to add it. A receiving station this instance attests makes other
          people&apos;s finds Radio-verified when it hears them: recognised, never gated.
        </p>
      </Disclosure>
      <div className="row end">
        <Button onClick={becomeCache}>★ Become a cache</Button>
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
      <div className="row between">
        <p className="muted fine">
          A weather station: fills in <span className="mono">{base ? `${base}-13` : "-13"}</span> and the Weather role.
        </p>
        <Button onClick={() => setDraft({ ...draft, callsign: base ? `${base}-13` : "", roles: ["weather"] })}>
          Add a weather station
        </Button>
      </div>
      <StationFields value={draft} onChange={setDraft} callsignEditable base={base} />
      <div className="row end mt-2">
        <Button variant="primary" onClick={add} disabled={!draft.callsign || draft.callsign.endsWith("-")}>
          Add station
        </Button>
      </div>
      {addedWx && (
        <div className="station-card">
          <p>
            <span className="mono">{addedWx.callsign}</span> is ready: point your weather station at one of these URLs.
          </p>
          <StationWxKeyPanel stationId={addedWx.id} />
        </div>
      )}
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
      <Button className="station-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="mono station-call">{props.station.callsign}</span>
        <span className="badges">
          {props.station.roles.map((r) => (
            <Badge key={r}>{ROLE_LABEL[r]}</Badge>
          ))}
        </span>
        <span className="muted">{open ? "▾" : "▸"}</span>
      </Button>
      {props.station.livingCaches?.map((c) => (
        <LivingCacheRow key={c.id} cache={c} />
      ))}
      {open && (
        <div className="station-body">
          <StationFields value={edit} onChange={setEdit} />
          <div className="row between mt-2">
            <Button variant="danger" onClick={remove}>
              Remove
            </Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              Save
            </Button>
          </div>
          <div className="row end mt-1">
            <Button
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
            </Button>
          </div>
          {props.station.roles.includes("weather") && <StationWxKeyPanel stationId={props.station.id} />}
        </div>
      )}
    </div>
  );
}

/** A living cache riding the station, with its rendezvous logging switched in place. */
function LivingCacheRow(props: { cache: NonNullable<OperatedStation["livingCaches"]>[number] }) {
  const toast = useToast();
  const [on, setOn] = useState(props.cache.rendezvous);
  const [busy, setBusy] = useState(false);
  async function flip(v: boolean) {
    setBusy(true);
    setOn(v);
    try {
      await updateCache(props.cache.id, { rendezvous: v });
      toast(v ? `${props.cache.code} logs rendezvous` : `${props.cache.code} stops logging rendezvous`);
    } catch (e) {
      setOn(!v);
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Row
      label={
        <>
          Living cache <span className="mono">{props.cache.code}</span> · {props.cache.title}
        </>
      }
      help="Log rendezvous: record when it meets another living cache that logs them."
    >
      <Switch
        label={`Log rendezvous for ${props.cache.code}`}
        checked={on}
        disabled={busy}
        onChange={(v) => void flip(v)}
      />
    </Row>
  );
}

/** Shared field set for create + edit. Callsign is only editable on create. */
function StationFields(props: {
  value: StationInput;
  onChange: (v: StationInput) => void;
  callsignEditable?: boolean;
  /** The operator's base call, for the examples. */
  base?: string;
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
          Callsign <span className="muted">(with SSID, e.g. {example(props.base ?? "", 1)})</span>{" "}
          <InfoTip text={TERMS.ssid} label="What is an SSID?" />
          <input
            className="mono"
            value={v.callsign ?? ""}
            maxLength={11}
            placeholder={example(props.base ?? "", 1)}
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
        <legend>
          Roles{" "}
          <InfoTip
            text="Weather: a weather station. Digipeater: repeats APRS packets on the air. IGate: copies what it hears to APRS-IS. Node: a packet node such as NET/ROM. Repeater: a voice repeater you run."
            label="What do the roles mean?"
          />
        </legend>
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
  // Until the current key has been read there is no knowing whether issuing would replace one, so the
  // issue button waits for a successful read.
  const {
    data: info,
    setData: setInfo,
    error,
    reload,
  } = useLoad(() => getStationWxKey(props.stationId), [props.stationId]);
  const [busy, setBusy] = useState(false);
  async function issue() {
    if (!info) return;
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
  if (!info)
    return (
      <div className="wx-key">
        <h5>Weather push</h5>
        {error ? (
          <ErrorState onRetry={reload}>Couldn't load this station's weather-push state.</ErrorState>
        ) : (
          <p className="muted" aria-busy="true">
            Loading…
          </p>
        )}
      </div>
    );
  return (
    <div className="wx-key">
      <h5>Weather push</h5>
      <p className="muted fine">
        Most consumer stations speak Ecowitt or Weather Underground: enter one of the URLs as the custom upload server.
        Pushing weather needs no licence.
      </p>
      {!info?.key ? (
        <div className="row end">
          <Button variant="primary" onClick={issue} disabled={busy}>
            Enable weather push
          </Button>
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
              <Button
                variant="icon-subtle"
                aria-label="Copy Ecowitt URL"
                onClick={() => void copy(info.ecowittPath ?? "", "Ecowitt URL")}
              >
                Copy
              </Button>
            </span>
          </label>
          <label>
            Weather Underground — Rapidfire URL
            <span className="copyrow">
              <input className="mono" readOnly value={info.wuUrl ?? ""} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="icon-subtle"
                aria-label="Copy Weather Underground URL"
                onClick={() => void copy(info.wuUrl ?? "", "WU URL")}
              >
                Copy
              </Button>
            </span>
          </label>
          <p className="muted fine">Last reading: {info.lastSeen ? fmt.dateTime(info.lastSeen) : "—"}.</p>
          <h5 className="mt-2">Transmit (optional)</h5>
          <p className="muted fine">
            Transmitting to APRS-IS or CWOP needs the station&apos;s callsign verified, and is off by default.
          </p>
          <WxTxToggles stationId={props.stationId} txIs={info.txIs} txCwop={info.txCwop} verified={info.verified} />
          <h5 className="mt-2">Browser-direct (Web Serial)</h5>
          <SerialWeather wxKey={info.key} />
          <div className="row end">
            <Button onClick={issue} disabled={busy}>
              Re-issue key
            </Button>
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
