// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import {
  getInstance,
  getSource,
  sourceLinkUrl,
  exportAccount,
  deleteAccount,
  getNotifyPrefs,
  setNotifyPrefs,
  type SourceInfo,
} from "../api.js";
import { signAccountAction } from "../crypto.js";
import { useFmt, browserLocale, browserTimeZone, type LocaleSettings } from "../format.js";
import {
  Panel,
  Group,
  Row,
  Advanced,
  Switch,
  Button,
  useConfirm,
  useToast,
  useLoad,
  Icon,
  Segmented,
} from "../ui/index.js";
import { AccountSettings } from "./AccountSettings.js";
import { ConnectionsSettings } from "./ConnectionsSettings.js";
import { Watchlist } from "../shack/Watchlist.js";
import { pushSupported, pushSubscribed, enablePush, disablePush } from "../push.js";
import { ProfileEditor } from "../profile/ProfileEditor.js";
import { WeatherStation } from "../profile/WeatherStation.js";
import { MyStations } from "../profile/MyStations.js";
import { SupportSettings } from "./SupportSettings.js";
import { AnnounceSettings } from "./AnnounceSettings.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { AboutInstance, BugReportLink } from "./AboutInstance.js";

/** Settings — account, connections/network, locale/units, GDPR data tools, and credits. Grouped + searchable. */

const APPEARANCE: [LocaleSettings["theme"], string][] = [
  ["auto", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["phosphor", "Phosphor"],
];

export function SettingsPanel(props: {
  settings: LocaleSettings;
  onApply: (s: LocaleSettings) => void;
  onFly: (lat: number, lon: number) => void;
  /** The account holds this instance's ADMIN_CALLSIGNS call but has not confirmed it with the operator CLI. */
  operatorPending?: boolean;
  onSignIn: () => void;
  onDocs?: () => void;
  /** start the first-run tour again */
  onTour?: () => void;
  onClose: () => void;
}) {
  const { callsign, verified, session } = usePlatform();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const s = props.settings;
  const fmt = useFmt();
  const [gdpr, setGdpr] = useState<string | null>(null);
  const { data: prefs, setData: setPrefs } = useLoad(
    () => (session.signedIn ? getNotifyPrefs() : Promise.resolve(undefined)),
    [session.signedIn],
  );
  const [pushState, setPushState] = useState<
    "loading" | "unsupported" | "off" | "on" | "denied" | "error" | "unconfigured"
  >("loading");
  useEffect(() => {
    if (!session.signedIn) return;
    (async () => {
      setPushState(!pushSupported() ? "unsupported" : (await pushSubscribed()) ? "on" : "off");
    })();
  }, [session.signedIn]);
  async function togglePush() {
    if (pushState === "on") {
      await disablePush();
      setPushState("off");
    } else {
      setPushState("loading");
      setPushState(await enablePush());
    }
  }

  async function exportData() {
    setGdpr("Preparing your export…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("export", callsign, inst);
      if (!auth) {
        setGdpr("This browser can't sign (needs Ed25519). Try a recent Chrome/Firefox/Safari.");
        return;
      }
      const data = await exportAccount(callsign, auth);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `aprscaching-${callsign}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setGdpr("Export downloaded.");
    } catch (e) {
      setGdpr((e as Error).message);
    }
  }
  async function deleteData() {
    if (
      !(await confirmDialog({
        title: `Permanently erase ${callsign}?`,
        message:
          "Your finds are anonymised and your account, keys and personal data are deleted. This cannot be undone.",
        confirmLabel: "Erase everything",
        danger: true,
      }))
    )
      return;
    setGdpr("Erasing…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("delete", callsign, inst);
      if (!auth) {
        setGdpr("This browser can't sign (needs Ed25519).");
        return;
      }
      await deleteAccount(callsign, auth);
      setGdpr("Your account and personal data were erased.");
    } catch (e) {
      setGdpr((e as Error).message);
    }
  }
  const [q, setQ] = useState("");
  const match = (title: string, ...kw: string[]) =>
    !q || (title + " " + kw.join(" ")).toLowerCase().includes(q.toLowerCase());
  return (
    <Panel
      title={
        <>
          <Icon name="settings" cp437="" className="lead-ic" />
          Settings
        </>
      }
      onClose={props.onClose}
    >
      <label className="srch">
        <span className="srch-ic">⌕</span>
        <input
          value={q}
          placeholder="Search settings…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search settings"
        />
      </label>

      {match("Account callsign callsigns identity verify SSID licence sign in passkey email") && (
        <AccountSettings session={session} onSignIn={props.onSignIn} operatorPending={!!props.operatorPending} />
      )}

      {match("Display appearance theme units measurement") && (
        <Group title="Display">
          <Row
            label="Appearance"
            help="Auto follows your system's light or dark setting. Phosphor is a late-90s green-screen terminal."
          >
            <Segmented
              label="Appearance"
              value={s.theme}
              onChange={(theme) => props.onApply({ ...s, theme })}
              options={APPEARANCE.map(([value, label]) => ({ value, label }))}
            />
          </Row>
          <Row label="Units" help="distances, speed, temperature">
            <Segmented
              label="Units"
              value={s.units}
              onChange={(units) => props.onApply({ ...s, units })}
              options={[
                { value: "metric", label: "Metric" },
                { value: "imperial", label: "Imperial" },
              ]}
            />
          </Row>
          {s.theme === "phosphor" && (
            <Row
              label="CRT effect"
              help="Scanlines + phosphor glow. Off by default; disabled when reduce-motion is on."
            >
              <Switch label="CRT effect" checked={s.crt} onChange={(v) => props.onApply({ ...s, crt: v })} />
            </Row>
          )}
        </Group>
      )}

      {session.signedIn && match("profile display name locator grid bio links avatar contact public") && (
        <Group title="Profile" defaultOpen={false}>
          <ProfileEditor callsign={callsign} />
        </Group>
      )}

      {session.signedIn &&
        match("weather station PWS home Ecowitt Weather Underground WU temperature wind rain sensor") && (
          <Group title="Home weather station" status="PWS" defaultOpen={false}>
            <WeatherStation callsign={callsign} />
          </Group>
        )}

      {session.signedIn &&
        match("my stations operated callsign SSID digipeater igate node relay mountain remote location registry") && (
          <Group title="My stations" defaultOpen={false}>
            <MyStations callsign={callsign} />
          </Group>
        )}

      {session.signedIn && match("my radio browser RF Web Serial BLE KISS TNC bridge station") && (
        <Group title="My radio (browser)" status="RF bridge" defaultOpen={false}>
          <ConnectionsSettings callsign={callsign} verified={verified} />
        </Group>
      )}

      {session.signedIn && match("announce finds APRS-IS status message broadcast") && (
        <AnnounceSettings verified={verified} />
      )}

      {session.signedIn && match("notifications alerts email digest push watchlist watch callsign") && (
        <Group title="Notifications" defaultOpen={false}>
          <Row
            label="Email digest"
            help={
              prefs?.hasEmail
                ? "Batched watchlist alerts, emailed to you"
                : "Add an email to your account to receive a digest"
            }
          >
            <Switch
              label="Email digest"
              checked={!!prefs?.digest}
              disabled={!prefs?.hasEmail}
              onChange={(v) => {
                setNotifyPrefs(v)
                  .then(() => setPrefs((p) => (p ? { ...p, digest: v } : p)))
                  .catch(() => toast("Couldn't save the digest setting — try again"));
              }}
            />
          </Row>
          <Row label="Browser push" help="A notification when a watched callsign is active">
            {!prefs?.pushConfigured ? (
              <span className="muted">Not enabled on this instance</span>
            ) : pushState === "unsupported" ? (
              <span className="muted">Not supported in this browser</span>
            ) : (
              <Button onClick={togglePush} disabled={pushState === "loading"}>
                {pushState === "on" ? "Disable" : "Enable"}
              </Button>
            )}
          </Row>
          {pushState === "denied" && (
            <p className="muted error">
              Notifications are blocked — allow them in your browser settings, then try again.
            </p>
          )}
          {pushState === "error" && (
            <p className="muted error">Could not enable push. On iPhone, install the app to your home screen first.</p>
          )}
          <h4 className="set-subh">Watchlist</h4>
          <Watchlist callsign={callsign} onFly={props.onFly} />
        </Group>
      )}

      {match("Locale region time zone language date number format") && (
        <Group title="Locale & time" status={`${fmt.resolvedLocale} · ${fmt.resolvedTimeZone}`} defaultOpen={false}>
          <p className="muted">Blank follows the browser.</p>
          <Advanced label="Override locale & time zone">
            <label>
              Locale
              <input
                value={s.locale}
                placeholder={`browser (${browserLocale()})`}
                onChange={(e) => props.onApply({ ...s, locale: e.target.value.trim() })}
              />
            </label>
            <label>
              Time zone
              <input
                value={s.timeZone}
                placeholder={`browser (${browserTimeZone()})`}
                onChange={(e) => props.onApply({ ...s, timeZone: e.target.value.trim() })}
              />
            </label>
          </Advanced>
          <Row label="Preview">
            <span className="mono">
              {fmt.distance(1234)} · {fmt.speed(36)} · {fmt.temp(18)}
            </span>
          </Row>
        </Group>
      )}

      {match("Your data export erase delete GDPR DSGVO privacy account") && (
        <Group title="Your data" status="GDPR" defaultOpen={false}>
          {callsign.length < 3 ? (
            <p className="muted">Set your callsign (top bar) to export or erase your data.</p>
          ) : (
            <>
              <p className="muted">
                Signed with your device key for <span className="mono">{callsign}</span>. Export gives you a full copy;
                erase anonymises your finds and removes your account, keys and personal data.
              </p>
              <div className="row">
                <Button onClick={exportData}>Export my data</Button>
                <Button variant="danger" onClick={deleteData}>
                  Erase my account
                </Button>
              </div>
              {gdpr && <p className="muted mt-2">{gdpr}</p>}
            </>
          )}
        </Group>
      )}

      {match("support donate donation supporter sponsor ledger transparency liberapay kofi patreon contribute") && (
        <Group title="Support the project" status="♥" defaultOpen={false}>
          <SupportSettings signedIn={session.signedIn} />
        </Group>
      )}

      {match(
        "Help manual tour guide about instance sysop operator version bug report credits attribution Bruninga WB4APR APRS trademark licence open source",
      ) && (
        <Group title="Help & credits" defaultOpen={false}>
          <p className="row gap-2">
            {props.onDocs && (
              <Button variant="quiet" onClick={props.onDocs}>
                Read the manual
              </Button>
            )}
            {props.onTour && (
              <Button variant="quiet" onClick={props.onTour}>
                Take the tour again
              </Button>
            )}
          </p>
          <BugReportLink />
          <AboutInstance />
          <p className="muted">
            APRScaching is an APRS geocaching game and ham-radio Shack by <span className="mono">OE8APR</span>.
          </p>
          <p className="muted">
            APRS — the Automatic Packet Reporting System — was created by the late <strong>Bob Bruninga, WB4APR</strong>{" "}
            (1948–2022). APRS® is his registered trademark, stewarded by the APRS Foundation, Inc. This is an
            independent, unofficial implementation built from open specifications (see the Specification registry in the
            manual) and is not affiliated with, sponsored by, or endorsed by the APRS Foundation.
          </p>
          <p className="muted">
            Maps © OpenStreetMap contributors (ODbL), rendered with MapLibre. Optional layers: © OpenTopoMap (CC-BY-SA)
            · Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data).
          </p>
          <p className="muted">
            Type: Fredoka and IBM Plex Mono (SIL Open Font License 1.1 — license texts ship with the app under{" "}
            <span className="mono">/fonts/</span>). The Phosphor theme's CP437 face is from The Ultimate Oldschool PC
            Font Pack v2.2 by VileR (int10h.org), CC BY-SA 4.0.
          </p>
          <p className="muted">
            Built on open source: React and react-dom (MIT), MapLibre GL (BSD-3-Clause), uPlot (MIT), zod (MIT) — the
            bundle is minified, so their copyright notices and license texts are reproduced in{" "}
            <a href="/third-party-notices.txt" target="_blank" rel="noreferrer">
              third-party notices
            </a>
            . Meshtastic® is a registered trademark of Meshtastic LLC. Parks on the Air® is a registered service mark of
            Parks on the Air, Inc.; Summits on the Air, SOTA and the SOTA logo are trademarks of the SOTA Programme.
            Geocaching is the outdoor activity; this project is not affiliated with Groundspeak, Inc. (Geocaching HQ),
            Meshtastic LLC, POTA, SOTA, or the TAK Product Center.
          </p>
          <SourceLink />
        </Group>
      )}
    </Panel>
  );
}

/** AGPL §13: a visible link to the exact source this instance is running. */
function SourceLink() {
  const { data: src } = useLoad<SourceInfo>(getSource, []);
  const short = src?.commit ? src.commit.slice(0, 8) : (src?.tag ?? null);
  return (
    <p className="muted fine">
      <a href={sourceLinkUrl} target="_blank" rel="noreferrer">
        Source code
      </a>
      {" — "}
      {src?.license ?? "AGPL-3.0-or-later"}
      {short ? (
        <>
          {" "}
          · <span className="mono">{short}</span>
        </>
      ) : null}
      . This is the AGPL §13 link to the source this instance runs.
    </p>
  );
}
