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
  errorText,
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
  ManualLink,
} from "../ui/index.js";
import { AccountSettings } from "./AccountSettings.js";
import { ConnectionsSettings } from "./ConnectionsSettings.js";
import { Watchlist } from "../shack/Watchlist.js";
import { pushSupported, pushSubscribed, enablePush, disablePush } from "../push.js";
import { ProfileEditor } from "../profile/ProfileEditor.js";
import { MyStations } from "../profile/MyStations.js";
import { SupportSettings } from "./SupportSettings.js";
import { AnnounceSettings } from "./AnnounceSettings.js";
import { NearRadioSettings } from "./NearRadioSettings.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { AboutInstance, BugReportLink } from "./AboutInstance.js";
import { APRS_CREDIT, APRS_MARK, APRS_NOT_AFFILIATED, OTHER_MARKS, OTHERS_NOT_AFFILIATED } from "../credits.js";

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
  // the push state belongs to the signed-in account: asked again for each session, and unknown without one
  useEffect(() => {
    let live = true;
    setPushState("loading");
    if (session.signedIn)
      void (async () => {
        const state = !pushSupported() ? "unsupported" : (await pushSubscribed().catch(() => false)) ? "on" : "off";
        if (live) setPushState(state);
      })();
    return () => {
      live = false;
    };
  }, [session.signedIn, session.callsign]);
  async function togglePush() {
    if (pushState === "on") {
      setPushState("loading");
      await disablePush().catch(() => {});
      setPushState("off");
    } else {
      setPushState("loading");
      setPushState(await enablePush());
    }
  }

  /**
   * The signature for an export or erase. The signed-in session authorises both on its own, so a browser
   * without an Ed25519 device key sends none and the session carries the request.
   */
  async function accountAuth(action: "export" | "delete") {
    return signAccountAction(action, callsign, await getInstance());
  }

  async function exportData() {
    setGdpr("Preparing your export…");
    try {
      const data = await exportAccount(callsign, await accountAuth("export"));
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `aprscaching-${callsign}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setGdpr("Export downloaded.");
    } catch (e) {
      setGdpr(errorText(e));
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
      await deleteAccount(callsign, await accountAuth("delete"));
    } catch (e) {
      setGdpr(errorText(e));
      return;
    }
    // the account is gone: end this browser's session and its push subscription with it
    setGdpr(null);
    await session.signOut();
    props.onClose();
    toast("Your account and personal data were erased");
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
        <span className="srch-ic" aria-hidden="true">
          ⌕
        </span>
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
        <Group title="Profile" help="What other players see on your public profile." defaultOpen={false}>
          <ProfileEditor callsign={callsign} />
        </Group>
      )}

      {session.signedIn &&
        match(
          "my stations operated callsign SSID digipeater igate node relay mountain remote location registry weather station PWS Ecowitt Weather Underground WU CWOP temperature wind rain sensor",
        ) && (
          <Group
            title="My stations"
            help="The stations you run, each under its own callsign and SSID: weather, digipeater, IGate, node. Weather never affects finds."
            defaultOpen={false}
          >
            <MyStations callsign={callsign} />
          </Group>
        )}

      {session.signedIn && match("my radio browser RF Web Serial BLE KISS TNC bridge station") && (
        <Group
          title="My radio (browser)"
          status="RF bridge"
          help="Connect a radio or TNC to this browser over USB or Bluetooth, to hear and send APRS."
          defaultOpen={false}
        >
          <ConnectionsSettings callsign={callsign} verified={verified} />
        </Group>
      )}

      {session.signedIn && match("announce finds APRS-IS status message broadcast") && (
        <AnnounceSettings verified={verified} />
      )}

      {session.signedIn && match("near cache radio message APRS MeshCom service call NEAR ON OFF") && (
        <NearRadioSettings verified={verified} />
      )}

      {session.signedIn && match("notifications alerts email digest push watchlist watch callsign") && (
        <Group
          title="Notifications"
          help="Alerts when the network hears a callsign on your watchlist."
          defaultOpen={false}
        >
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
        <Group
          title="Your data"
          status="GDPR"
          help="Download everything this instance holds about you, or erase it."
          defaultOpen={false}
        >
          {!session.signedIn || callsign.length < 3 ? (
            <>
              <p className="muted">Sign in first to export or erase your data.</p>
              <div className="row end">
                <Button onClick={props.onSignIn}>Sign in</Button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                For the account of <span className="mono">{callsign}</span>. Export gives you a full copy; erase
                anonymises your finds and removes your account, keys and personal data.
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
        <Group
          title="Support the project"
          status="♥"
          help="Donations are thanks only: every feature stays free."
          defaultOpen={false}
        >
          <SupportSettings signedIn={session.signedIn} />
        </Group>
      )}

      {match(
        "Help manual tour guide about instance sysop operator version bug report credits attribution Bruninga WB4APR APRS trademark licence license register open source notices map OpenStreetMap Meshtastic POTA SOTA LoTW ARRL Groundspeak geocaching",
      ) && (
        <Group title="Help & credits" defaultOpen={false}>
          <p className="row gap-2">
            <ManualLink>Read the manual</ManualLink>
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
            {APRS_CREDIT} {APRS_MARK} This is an independent, unofficial implementation built from open specifications
            (see the <ManualLink page="contribute/specs">specification registry</ManualLink>). {APRS_NOT_AFFILIATED}
          </p>
          <p className="muted">
            {OTHER_MARKS} {OTHERS_NOT_AFFILIATED}
          </p>
          <p className="muted">
            Maps © OpenStreetMap contributors (ODbL), rendered with MapLibre; vector tiles © OpenFreeMap, ©
            OpenMapTiles. Optional layers: OpenTopoMap (Map data: © OpenStreetMap contributors, SRTM | Map style: ©
            OpenTopoMap (CC-BY-SA)) · EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified
            Copernicus Sentinel data 2016). Imported places name and link their source; that source's own terms apply to
            its data. DXCC entities and prefixes: Amateur Radio Country Files by Jim Reisert, AD1C (MIT).
          </p>
          <p className="muted">
            Register badges come from public registers. USA: FCC Universal Licensing System. Canada: ISED amateur
            callsign list, reproduced from ised-isde.canada.ca. Australia: Based on Australian Communications and Media
            Authority information. Austria: Fernmeldebehörde. Germany: Bundesnetzagentur.
          </p>
          <p className="muted">
            Type: Fredoka and IBM Plex Mono (SIL Open Font License 1.1 — license texts ship with the app under{" "}
            <span className="mono">/fonts/</span>). The Phosphor theme's CP437 face is from The Ultimate Oldschool PC
            Font Pack v2.2 by VileR (int10h.org), CC BY-SA 4.0.
          </p>
          <p className="muted">
            Built on open source, among others React (MIT), MapLibre GL (BSD-3-Clause), uPlot (MIT), zod (MIT), pmtiles
            (BSD-3-Clause), fflate (MIT) and node-forge (BSD-3-Clause). The bundle is minified, so the copyright notices
            and license texts of every library in it are reproduced in{" "}
            <a href="/third-party-notices.txt" target="_blank" rel="noreferrer">
              third-party notices
            </a>
            .
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
