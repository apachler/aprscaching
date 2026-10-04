// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { SITE_CALL_RE } from "@aprscaching/shared";
import {
  getFederationSync,
  syncFederationNow,
  adminAddStation,
  listFederationPeers,
  setPeerTrust,
  add44netPeer,
  getFedDescriptor,
  ApiError,
  type Fed44netCandidate,
  type Fed44netResult,
  type Fed44netTarget,
  listForwardPartners,
  saveForwardPartner,
  deleteForwardPartner,
  listForwardRules,
  saveForwardRule,
  deleteForwardRule,
  getPorts,
  cotUrl,
  getAdminSetup,
  run44netCheck,
  type Net44CheckLine,
  listManualVerifications,
  addManualVerification,
  revokeManualVerification,
  type ManualVerification,
  listEnrolledBoxes,
  createBoxCode,
  revokeBox,
  setBoxTrust,
  getBoxFinds,
  listTrustedStations,
  addTrustedStation,
  removeTrustedStation,
  getStationFinds,
  type TrustedStation,
  type EnrolledBox,
  getAdminAdoptions,
  offerForAdoption,
  withdrawAdoptionOffer,
  assignCacheOwner,
  decideAdoptionRequest,
  type AdminAdoptions,
  type SetupItem,
  type WriteBudget,
  type FedPeer,
  type ForwardPartner,
  type ForwardRuleRow,
  type PortStat,
} from "../api.js";
import { useFmt } from "../format.js";
import {
  Button,
  Panel,
  Group,
  Row,
  Badge,
  EmptyState,
  ErrorState,
  Switch,
  copyText,
  useConfirm,
  useToast,
  useLoad,
  Disclosure,
  Icon,
} from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";

/**
 * AdminPanel — the instance-operator (sysop) back end. Instance-wide configuration that belongs to the ham
 * who DEPLOYED this instance, kept OUT of per-user Settings: the federation network (peers + trust), FBB
 * forwarding (partners + routing rules), and the ingest data plane (transports + the TAK/CoT feed). Only
 * rendered when `/api/admin/whoami` reports the signed-in account is an operator (ADMIN_CALLSIGNS); every
 * write here is sysop-gated server-side, so this is a convenience surface over already-protected endpoints.
 */
export function AdminPanel(props: { onDocs: (slug: string) => void; onClose: () => void }) {
  const { callsign, map } = usePlatform();
  // one status request feeds both the write-budget banner and the Setup checklist
  const setup = useLoad(() => getAdminSetup(), []);
  // group filter (ui-ux.md §2: settings pages with >3 groups are searchable)
  const [q, setQ] = useState("");
  // a box's trust switch changes the trusted-stations list too, so it reloads on each change
  const [trustRev, setTrustRev] = useState(0);
  const show = (...words: string[]) => !q.trim() || words.some((w) => w.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Panel
      title={
        <>
          <Icon name="shield-check" cp437="" className="lead-ic" />
          Instance admin
        </>
      }
      onClose={props.onClose}
      density="compact"
    >
      <p className="muted">
        Operator-only. These settings govern the whole instance, not your account — you see this because{" "}
        <span className="mono">{callsign}</span> is configured as an operator.
      </p>
      {setup.data && <WriteBudgetBanner budget={setup.data.budget} onDocs={props.onDocs} />}
      <label className="srch">
        <span className="srch-ic" aria-hidden="true">
          ⌕
        </span>
        <input
          value={q}
          placeholder="Search admin sections…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search admin sections"
        />
      </label>

      {show("setup", "checklist", "install", "secrets", "wizard") && (
        <Group title="Setup" status="first-install checklist" defaultOpen={true}>
          <SetupAdmin setup={setup} onDocs={props.onDocs} />
        </Group>
      )}
      {show("verification", "verify", "callsign", "manual", "licence", "sysop") && (
        <Group title="Callsign verification" status="manual" defaultOpen={false}>
          <VerificationAdmin />
        </Group>
      )}
      {show("stations", "club", "member", "digipeater", "igate", "list") && (
        <Group title="Stations for members" status="club stations" defaultOpen={false}>
          <StationsAdmin />
        </Group>
      )}
      {show("adoption", "adopt", "caches", "owner", "withdrawn", "assign", "orphan") && (
        <Group title="Cache adoption" status="owners" defaultOpen={false}>
          <AdoptionAdmin />
        </Group>
      )}
      {show("federation", "peers", "trust", "44net", "sync") && (
        <Group title="Federation" status="peers & trust" defaultOpen={false}>
          <FederationAdmin />
        </Group>
      )}
      {show("forwarding", "fbb", "bbs", "partners", "rules", "mail") && (
        <Group title="Forwarding" status="FBB / BBS" defaultOpen={false}>
          <ForwardingAdmin />
        </Group>
      )}
      {show("trusted", "stations", "sites", "receiving", "tier a", "trust", "first_party_sites") && (
        <Group title="Trusted receiving stations" status="Radio-verified finds" defaultOpen={false}>
          <TrustedStationsAdmin rev={trustRev} />
        </Group>
      )}
      {show("boxes", "ingest", "enroll", "code", "revoke", "key", "trust", "lend", "receiver") && (
        <Group title="Ingest boxes" status="enrollment & trust" defaultOpen={false}>
          <BoxesAdmin onTrustChanged={() => setTrustRev((n) => n + 1)} />
        </Group>
      )}
      {show("ingest", "transports", "ports", "tak", "cot", "feed") && (
        <Group title="Ingest & transports" status="data plane" defaultOpen={false}>
          <IngestAdmin map={map} />
        </Group>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- stations listed for members

/**
 * A member lists under My stations only stations of callsigns they hold and have verified. A club station run by a
 * member who does not hold the club call is listed for them here; they then manage it like their own.
 */
function StationsAdmin() {
  const toast = useToast();
  const [owner, setOwner] = useState("");
  const [station, setStation] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const own = owner.trim().toUpperCase();
  const st = station.trim().toUpperCase();
  const submit = async () => {
    if (!CALL_RE.test(own) || !CALL_RE.test(st)) {
      setFormErr("Enter the member's callsign and the station's callsign.");
      return;
    }
    const la = lat.trim() ? Number(lat) : undefined;
    const lo = lon.trim() ? Number(lon) : undefined;
    if ((la !== undefined && !Number.isFinite(la)) || (lo !== undefined && !Number.isFinite(lo))) {
      setFormErr("Latitude and longitude are decimal degrees, or blank to take a heard station's position.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const r = await adminAddStation({ owner: own, callsign: st, lat: la, lon: lo });
      toast(`${r.station.callsign} listed for ${own}`);
      setStation("");
      setLat("");
      setLon("");
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <p className="muted fine">
        Members list only stations of their own verified callsigns. List a club station here for the member who runs it;
        it then shows under their My stations.
      </p>
      <div className="partner-form">
        <label>
          Member's callsign
          <input
            className="mono"
            placeholder="OE8APR"
            value={owner}
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
        <label>
          Station's callsign
          <input
            className="mono"
            placeholder="OE8XKR-10"
            value={station}
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setStation(e.target.value)}
          />
        </label>
        <label>
          Latitude (blank: as heard)
          <input inputMode="decimal" placeholder="46.62" value={lat} onChange={(e) => setLat(e.target.value)} />
        </label>
        <label>
          Longitude (blank: as heard)
          <input inputMode="decimal" placeholder="14.31" value={lon} onChange={(e) => setLon(e.target.value)} />
        </label>
        <div className="row end">
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
            {saving ? "Listing…" : "List the station"}
          </Button>
        </div>
        {formErr && (
          <p className="error" role="alert">
            {formErr}
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- manual callsign verification

// the gateway's own pattern, so a form never accepts a call the server refuses
const CALL_RE = SITE_CALL_RE;

/**
 * Verify a callsign by hand for an operator no attested receiving site can hear. Each one carries a note
 * saying how control of the licence was checked, is listed here, and can be revoked. Calls verified on
 * the air or by the operator CLI are not listed and cannot be revoked from here.
 */
function VerificationAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const list = useLoad(() => listManualVerifications().then((r) => r.verifications), []);
  const rows = list.data;
  const refresh = list.reload;
  const [call, setCall] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const cs = call.trim().toUpperCase();
  const callOk = CALL_RE.test(cs);
  const noteOk = note.trim().length >= 3;
  const submit = async () => {
    if (!callOk || !noteOk) {
      setFormErr(!callOk ? "Enter a valid callsign." : "Say how you checked control of the licence.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      const r = await addManualVerification(cs, note.trim());
      toast(`${r.callsign} verified`);
      setCall("");
      setNote("");
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const revoke = async (v: ManualVerification) => {
    if (
      !(await confirmDialog({
        title: `Revoke the verification of ${v.callsign}?`,
        message: "The call becomes unverified: transmit and leaderboard credit close until it is verified again.",
        confirmLabel: "Revoke",
        danger: true,
      }))
    )
      return;
    try {
      await revokeManualVerification(v.callsign);
      toast(`${v.callsign} verification revoked`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <p className="muted fine">
        For operators out of range of every receiving site this instance attests. Verify only a call whose licence you
        have checked yourself; the note records how.
      </p>
      <div className="partner-form">
        <label>
          Callsign
          <input
            className="mono"
            placeholder="VK2ABC"
            value={call}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr && !callOk}
            onChange={(e) => setCall(e.target.value)}
          />
        </label>
        <label>
          How control was checked
          <input
            placeholder="licence seen on a video call"
            value={note}
            maxLength={200}
            aria-invalid={!!formErr && !noteOk}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        <div className="row end">
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
            {saving ? "Verifying…" : "Verify callsign"}
          </Button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}
      <h4 className="set-subh">Verified by hand</h4>
      {list.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the manual verifications.</ErrorState>
      ) : rows === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <EmptyState>
          No calls verified by hand. Use the form above for an operator no receiving site can hear.
        </EmptyState>
      ) : (
        <ul className="logs">
          {rows.map((v) => (
            <li key={v.callsign}>
              <span className="mono">{v.callsign}</span>
              <span className="muted">
                {" "}
                · by <span className="mono">{v.verifiedBy ?? "?"}</span> · {fmt.date(v.verifiedAt)}
                {v.held ? "" : " · no account yet"}
              </span>
              <Button
                variant="inline-danger"
                aria-label={`Revoke the verification of ${v.callsign}`}
                onClick={() => void revoke(v)}
              >
                Revoke
              </Button>
              {v.note && <div className="comment">{v.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- trusted receiving stations

const SOURCE_LABEL: Record<TrustedStation["source"], string> = {
  config: "set in configuration",
  admin: "added here",
  box: "enrolled box",
};

/**
 * The receiving stations whose direct hearings verify finds (Tier A, Radio-verified). The sysop adds a station by
 * its site call — their own box on the shared ingest secret, say — and removes it again. Stations preset in
 * FIRST_PARTY_SITES are listed read-only, and an enrolled box's trust is switched under Ingest boxes. Each
 * station shows since when and by whom it is trusted, and the finds it verified.
 */
function TrustedStationsAdmin(props: { rev: number }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const list = useLoad(() => listTrustedStations(), [props.rev]);
  const [site, setSite] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const call = site.trim().toUpperCase();

  const add = async () => {
    if (!CALL_RE.test(call)) {
      setFormErr("Enter the station's site call, such as OE8ABC-10.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      await addTrustedStation(call);
      toast(`${call} trusted`);
      setSite("");
      list.reload();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (s: TrustedStation) => {
    if (
      !(await confirmDialog({
        title: `Stop trusting ${s.site}?`,
        message:
          "Its hearings stop counting for Radio-verified finds within a minute. Finds it verified keep their tier.",
        confirmLabel: "Stop trusting",
        danger: true,
      }))
    )
      return;
    try {
      await removeTrustedStation(s.site);
      toast(`${s.site} no longer trusted`);
      list.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const sites = list.data?.sites;

  return (
    <>
      <p className="muted fine">
        A find is Radio-verified only when one of these stations heard the player directly on its own receiver, through
        its ingest box. A station never verifies its own operator&apos;s finds.
      </p>
      <div className="partner-form">
        <label>
          Site call
          <input
            className="mono"
            placeholder="OE8ABC-10"
            value={site}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr}
            aria-describedby="trusted-site-help"
            onChange={(e) => setSite(e.target.value)}
          />
        </label>
        <p id="trusted-site-help" className="muted fine">
          The call a receiver you vouch for stamps on what it hears. Trust a lent box under Ingest boxes instead.
        </p>
        <div className="row end">
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void add()}>
            {saving ? "Adding…" : "Trust station"}
          </Button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}
      {list.error ? (
        <ErrorState onRetry={list.reload}>Couldn&apos;t load the stations.</ErrorState>
      ) : sites === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : sites.length === 0 ? (
        <EmptyState>
          No trusted station: no find here is Radio-verified. Add your receiver&apos;s site call above.
        </EmptyState>
      ) : (
        <ul className="logs">
          {sites.map((s) => (
            <li key={`${s.source}-${s.box ?? ""}-${s.site}`}>
              <span className="mono">{s.site}</span>{" "}
              <Badge kind={s.source === "config" ? undefined : "found"}>{SOURCE_LABEL[s.source]}</Badge>
              {s.source === "box" && <span className="muted"> · {s.boxLabel ?? s.box}</span>}
              {s.source === "admin" && (
                <Button variant="inline-danger" aria-label={`Stop trusting ${s.site}`} onClick={() => void remove(s)}>
                  Remove
                </Button>
              )}
              <div className="comment">
                {s.trustedAt
                  ? `trusted since ${fmt.date(s.trustedAt)} by ${s.trustedByCall ?? s.trustedBy}`
                  : "FIRST_PARTY_SITES · change it in the configuration"}
              </div>
              <VerifiedFinds sites={[s.site]} load={() => getStationFinds(s.site)} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- ingest box enrollment

/**
 * Let an ingest box in without handing it the shared INGEST_SECRET: a one-time code, typed on the box
 * (`deploy/aprscaching init ingest-box`), registers the box's own key. Each box is listed with when it was last
 * seen, and revoking one cuts that box off alone. Enrolling grants no trust: a box's receiving site counts for
 * Tier A only once it is listed in FIRST_PARTY_SITES, or once the sysop switches on "Trust this station's
 * hearings" for the box — the way a ham lends their own receiver to this instance.
 */
function BoxesAdmin(props: { onTrustChanged: () => void }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const list = useLoad(() => listEnrolledBoxes(), []);
  const refresh = list.reload;
  const [label, setLabel] = useState("");
  const [call, setCall] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ code: string; expiresAt: number } | null>(null);

  const base = call.trim().toUpperCase();
  const callOk = !base || CALL_RE.test(base);
  const create = async () => {
    if (!callOk) {
      setFormErr("Enter a valid callsign, or leave it empty.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      setIssued(await createBoxCode(label.trim(), base));
      setLabel("");
      setCall("");
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const revoke = async (b: EnrolledBox) => {
    if (
      !(await confirmDialog({
        title: `Revoke ${b.label ?? b.box}?`,
        message: "Its key stops working at once. The box comes back only with a new code.",
        confirmLabel: "Revoke",
        danger: true,
      }))
    )
      return;
    try {
      await revokeBox(b.box);
      toast(`${b.label ?? b.box} revoked`);
      refresh();
      props.onTrustChanged(); // a revoked box's trusted sites leave the list
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const boxes = list.data?.boxes;
  const open = list.data?.openCodes ?? [];

  return (
    <>
      <p className="muted fine">
        A one-time code lets a box in with its own key, so it needs no copy of the shared ingest secret and you can
        revoke it alone. Enrolling grants no trust: for Radio-verified finds, switch on the box&apos;s trust below or
        list its receiving site in <span className="mono">FIRST_PARTY_SITES</span>.
      </p>
      <div className="partner-form">
        <label>
          Box name
          <input placeholder="home TNC" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Limit to callsign (optional)
          <input
            className="mono"
            placeholder="OE8APR"
            value={call}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr && !callOk}
            aria-describedby="box-call-help"
            onChange={(e) => setCall(e.target.value)}
          />
        </label>
        <p id="box-call-help" className="muted fine">
          A box limited to a callsign may name only receiving sites of that call.
        </p>
        <div className="row end">
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void create()}>
            {saving ? "Creating…" : "Create enrollment code"}
          </Button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}
      {issued && (
        <div className="box-code" role="status">
          <p>Enter this code on the box before {fmt.time(issued.expiresAt)}. It works once and is not shown again.</p>
          <p className="box-code__value mono">{issued.code}</p>
          <div className="row">
            <Button
              onClick={() =>
                void copyText(issued.code).then((ok) =>
                  toast(ok ? "Code copied" : "Copy failed — select the code and copy it by hand"),
                )
              }
            >
              Copy
            </Button>
            <Button variant="inline" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
          <p className="muted fine">
            On the box: <span className="mono">deploy/aprscaching init ingest-box</span>
          </p>
        </div>
      )}
      {open.length > 0 && (
        <p className="muted fine">
          {open.length} code{open.length === 1 ? "" : "s"} waiting to be used.
        </p>
      )}
      <h4 className="set-subh">Enrolled boxes</h4>
      {list.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the boxes.</ErrorState>
      ) : boxes === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : boxes.length === 0 ? (
        <EmptyState>No enrolled boxes. Create a code above and enter it on the box.</EmptyState>
      ) : (
        <ul className="logs">
          {boxes.map((b) => (
            <li key={b.box}>
              <Badge kind={b.revokedAt ? "dnf" : "found"}>{b.revokedAt ? "revoked" : "active"}</Badge>
              <span>{b.label ?? b.box}</span>
              <span className="muted">
                {" "}
                · <span className="mono">{b.box}</span>
                {b.callsign ? (
                  <>
                    {" "}
                    · <span className="mono">{b.callsign}</span>
                  </>
                ) : null}
              </span>
              {!b.revokedAt && (
                <Button
                  variant="inline-danger"
                  aria-label={`Revoke ${b.label ?? b.box}`}
                  onClick={() => void revoke(b)}
                >
                  Revoke
                </Button>
              )}
              <div className="comment">
                enrolled {fmt.date(b.enrolledAt)}
                {b.revokedAt
                  ? ` · revoked ${fmt.date(b.revokedAt)}`
                  : b.lastSeenAt
                    ? ` · last seen ${fmt.ago(b.lastSeenAt)}`
                    : " · not seen yet"}
              </div>
              {!b.revokedAt && (
                <BoxTrustRow
                  box={b}
                  onChanged={() => {
                    refresh();
                    props.onTrustChanged();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * "Trust this station's hearings" for one enrolled box: off by default. Switching it on asks for the receiving
 * site call the box hears with (a box limited to a callsign takes only sites of that call; the gateway refuses
 * any other); on, it shows since when and by whom, and the finds the station verified. Switching it off asks
 * first, since the station's hearings stop counting for Tier A within a minute.
 */
function BoxTrustRow(props: { box: EnrolledBox; onChanged: () => void }) {
  const { box: b } = props;
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const [asking, setAsking] = useState(false);
  const [sites, setSites] = useState(b.callsign ? `${b.callsign}-10` : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = b.label ?? b.box;
  const trust = b.trust;
  const siteList = sites
    .toUpperCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  const sitesOk = siteList.length > 0 && siteList.every((s) => CALL_RE.test(s));
  const fieldId = `trust-sites-${b.box}`;

  const turnOn = async () => {
    if (!sitesOk) {
      setErr("Enter the receiving site call, such as OE8ABC-10.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await setBoxTrust(b.box, true, siteList);
      toast(`${name}: hearings trusted`);
      setAsking(false);
      props.onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const turnOff = async () => {
    if (
      !(await confirmDialog({
        title: `Stop trusting ${name}?`,
        message:
          "Its hearings stop counting for Radio-verified finds within a minute. Finds it verified keep their tier.",
        confirmLabel: "Stop trusting",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    try {
      await setBoxTrust(b.box, false);
      toast(`${name}: hearings no longer trusted`);
      props.onChanged();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const help = trust
    ? `Trusted since ${fmt.date(trust.trustedAt)} by ${trust.trustedByCall ?? trust.trustedBy}`
    : "Off: what this box hears never verifies a find.";

  return (
    <div className="box-trust">
      <Row label="Trust this station's hearings" help={help}>
        <Badge kind={trust ? "found" : undefined}>{trust ? "trusted" : "not trusted"}</Badge>
        <Switch
          label={`Trust ${name}'s hearings`}
          checked={!!trust || asking}
          disabled={saving}
          onChange={(v) => (v ? setAsking(true) : trust ? void turnOff() : setAsking(false))}
        />
      </Row>
      {asking && !trust && (
        <div className="partner-form">
          <label htmlFor={fieldId}>
            Receiving site call
            <input
              id={fieldId}
              className="mono"
              placeholder={b.callsign ? `${b.callsign}-10` : "OE8ABC-10"}
              value={sites}
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={!!err}
              aria-describedby={`${fieldId}-help`}
              onChange={(e) => setSites(e.target.value)}
            />
          </label>
          <p id={`${fieldId}-help`} className="muted fine">
            {b.callsign
              ? `The call the box stamps on what it hears; this box takes only ${b.callsign} sites.`
              : "The call the box stamps on what it hears. Limit lent boxes to the lender's callsign."}
          </p>
          {err && (
            <p className="error fine" role="alert">
              {err}
            </p>
          )}
          <div className="row end">
            <Button variant="inline" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void turnOn()}>
              {saving ? "Trusting…" : "Trust hearings"}
            </Button>
          </div>
        </div>
      )}
      {trust && <VerifiedFinds named sites={trust.sites} load={() => getBoxFinds(b.box)} />}
    </div>
  );
}

type FindsLoad = () => Promise<{
  count: number;
  recent: { code: string; loggerCall: string; ts: number; site: string }[];
}>;

/**
 * The finds a trusted station verified since it was trusted, loaded when the disclosure opens: a list of stations
 * then costs one request per station the sysop looks at, not one per row.
 */
function VerifiedFinds(props: {
  load: FindsLoad;
  sites: string[];
  /** name the sites in the label (a box can attest several) */
  named?: boolean;
}) {
  return (
    <Disclosure label={`Verified finds${props.named ? ` · ${props.sites.join(", ")}` : ""}`}>
      <VerifiedFindsList load={props.load} />
    </Disclosure>
  );
}

function VerifiedFindsList(props: { load: FindsLoad }) {
  const fmt = useFmt();
  const finds = useLoad(() => props.load(), []);
  if (finds.error) return <ErrorState onRetry={finds.reload}>Couldn&apos;t load the finds.</ErrorState>;
  if (!finds.data)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  const { count, recent } = finds.data;
  if (count === 0 || recent.length === 0) return <EmptyState>No find verified by this station yet.</EmptyState>;
  return (
    <>
      <p className="muted fine">
        {count} find{count === 1 ? "" : "s"} verified{count > recent.length ? `; the latest ${recent.length}` : ""}:
      </p>
      <ul className="logs">
        {recent.map((f) => (
          <li key={`${f.code}-${f.loggerCall}`}>
            <span className="mono">{f.code}</span> · <span className="mono">{f.loggerCall}</span>
            <span className="muted">
              {" "}
              · {fmt.ago(f.ts)} · heard by <span className="mono">{f.site}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- cache adoption

type AdoptCache = AdminAdoptions["withdrawn"][number];

/**
 * Hand caches to new owners. A withdrawn owner's cache (the owner erased their account) or an abandoned one
 * is offered to the community with a public note; signed-in holders of a verified call ask for it here, and
 * the sysop approves one — or assigns the cache straight to a verified call. An active owner is told of an
 * offer and can keep the cache until the notice period ends.
 */
function AdoptionAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const adoptions = useLoad(getAdminAdoptions, []);
  const data = adoptions.data;
  const refresh = adoptions.reload;
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const offerByCode = async () => {
    if (!code.trim() || note.trim().length < 3) {
      setFormErr(!code.trim() ? "Enter the cache code." : "Say why the cache is up for adoption.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      await offerForAdoption({ code: code.trim() }, note.trim());
      toast(`${code.trim().toUpperCase()} offered for adoption`);
      setCode("");
      setNote("");
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  /** Run one row action with its own busy flag, a toast, and a refresh. */
  const act = async (key: string, done: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast(done);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const withdraw = async (c: AdoptCache) => {
    if (
      !(await confirmDialog({
        title: `Withdraw the adoption offer on ${c.code}?`,
        message: "The cache leaves the adoption list and every pending request on it is cancelled.",
        confirmLabel: "Withdraw offer",
        danger: true,
      }))
    )
      return;
    await act(`w${c.id}`, `Offer on ${c.code} withdrawn`, () => withdrawAdoptionOffer(c.id));
  };
  const decide = async (c: AdoptCache, r: { id: number; callsign: string }, d: "approve" | "decline") => {
    if (
      !(await confirmDialog({
        title: d === "approve" ? `Hand ${c.code} to ${r.callsign}?` : `Decline ${r.callsign}'s request?`,
        message:
          d === "approve"
            ? "The cache changes owner; its finds and logbook stay. Other requests on it are declined."
            : "The requester is told their request was not taken up.",
        confirmLabel: d === "approve" ? "Approve" : "Decline",
        danger: d === "decline",
      }))
    )
      return;
    await act(`r${r.id}`, d === "approve" ? `${c.code} now belongs to ${r.callsign}` : "Request declined", () =>
      decideAdoptionRequest(r.id, d),
    );
  };

  const now = Math.floor(Date.now() / 1000);
  return (
    <>
      <p className="muted fine">
        Offer a cache whose owner has withdrawn or stopped looking after it. The note is public. An active owner is told
        and can keep the cache for {data ? Math.round(data.noticeSec / 86_400) : 14} days; the new owner must hold a
        control-verified call.
      </p>
      <div className="partner-form">
        <label>
          Cache code
          <input
            className="mono"
            placeholder="AC-0042"
            value={code}
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={!!formErr && !code.trim()}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label>
          Why it is up for adoption
          <input
            placeholder="owner inactive since 2024"
            value={note}
            maxLength={300}
            aria-invalid={!!formErr && note.trim().length < 3}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void offerByCode();
            }}
          />
        </label>
        <div className="row end">
          <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void offerByCode()}>
            {saving ? "Offering…" : "Offer for adoption"}
          </Button>
        </div>
      </div>
      {formErr && (
        <p className="error fine" role="alert">
          {formErr}
        </p>
      )}

      {adoptions.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the adoption list.</ErrorState>
      ) : data === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : (
        <>
          <h4 className="set-subh">Up for adoption</h4>
          {data.offered.length === 0 ? (
            <EmptyState>No cache is up for adoption. Offer one above, or from the withdrawn list below.</EmptyState>
          ) : (
            <ul className="logs">
              {data.offered.map((c) => (
                <li key={c.id}>
                  <span className="mono">{c.code}</span> {c.title}
                  <span className="muted">
                    {" "}
                    · owner <span className="mono">{c.ownerCall}</span> · offered by{" "}
                    <span className="mono">{c.offeredBy}</span> {fmt.ago(c.offeredAt)}
                  </span>{" "}
                  {c.noticeEndsAt > now ? (
                    <Badge kind="warn">notice until {fmt.date(c.noticeEndsAt)}</Badge>
                  ) : (
                    <Badge kind="found">ready</Badge>
                  )}
                  <div className="comment">{c.note}</div>
                  {c.requests.length === 0 ? (
                    <div className="comment muted">No requests yet.</div>
                  ) : (
                    <ul className="logs adopt-reqs">
                      {c.requests.map((r) => (
                        <li key={r.id}>
                          <span className="mono">{r.callsign}</span>
                          <span className="muted">
                            {" "}
                            · {r.inPlace ? "confirms it is in place" : "has not checked the site"} ·{" "}
                            {fmt.ago(r.requestedAt)}
                          </span>
                          {r.note && <div className="comment">{r.note}</div>}
                          <div className="row">
                            <Button
                              disabled={busy !== null || c.noticeEndsAt > now}
                              aria-busy={busy === `r${r.id}`}
                              title={c.noticeEndsAt > now ? "The owner's notice period is still running" : undefined}
                              onClick={() => void decide(c, r, "approve")}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="danger"
                              disabled={busy !== null}
                              onClick={() => void decide(c, r, "decline")}
                            >
                              Decline
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="row">
                    <AssignOwner cache={c} disabled={busy !== null || c.noticeEndsAt > now} onDone={refresh} />
                    <Button
                      variant="inline-danger"
                      disabled={busy !== null}
                      aria-label={`Withdraw the adoption offer on ${c.code}`}
                      onClick={() => void withdraw(c)}
                    >
                      Withdraw offer
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h4 className="set-subh">Withdrawn owners</h4>
          {data.withdrawn.length === 0 ? (
            <EmptyState>No cache is left by an erased account.</EmptyState>
          ) : (
            <ul className="logs">
              {data.withdrawn.map((c) => (
                <li key={c.id}>
                  <span className="mono">{c.code}</span> {c.title} <Badge>{c.status}</Badge>
                  <div className="row">
                    <OfferWithdrawn cache={c} onDone={refresh} />
                    <AssignOwner cache={c} disabled={busy !== null} onDone={refresh} />
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Disclosure label={`Recent activity (${data.log.length})`}>
            {data.log.length === 0 ? (
              <EmptyState>Nothing has happened yet.</EmptyState>
            ) : (
              <ul className="logs">
                {data.log.map((l) => (
                  <li key={l.id}>
                    <span className="mono">{l.code ?? `#${l.cacheId}`}</span>{" "}
                    <Badge>{l.action.replace(/_/g, " ")}</Badge>
                    <span className="muted">
                      by <span className="mono">{l.actor}</span>
                      {l.to && (
                        <>
                          {" "}
                          · <span className="mono">{l.from ?? "?"}</span> to <span className="mono">{l.to}</span>
                        </>
                      )}{" "}
                      · {fmt.date(l.at)}
                    </span>
                    {l.note && <div className="comment">{l.note}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Disclosure>
        </>
      )}
    </>
  );
}

/** Offer one withdrawn-owner cache: a disclosure holding the public note and the confirm button. */
function OfferWithdrawn(props: { cache: AdoptCache; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("The owner has withdrawn from the network.");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (note.trim().length < 3) {
      setErr("Say why the cache is up for adoption.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await offerForAdoption({ cacheId: props.cache.id }, note.trim());
      toast(`${props.cache.code} offered for adoption`);
      setOpen(false);
      props.onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!open)
    return (
      <Button aria-expanded={false} onClick={() => setOpen(true)}>
        Offer…
      </Button>
    );
  return (
    <div className="partner-form">
      <label>
        Public note
        <input value={note} maxLength={300} aria-invalid={!!err} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row end">
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
          {saving ? "Offering…" : `Offer ${props.cache.code}`}
        </Button>
      </div>
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** Hand a cache straight to a call: the call must be held by an account and control-verified. */
function AssignOwner(props: { cache: AdoptCache; disabled: boolean; onDone: () => void }) {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState("");
  const [note, setNote] = useState("");
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cs = call.trim().toUpperCase();
  const submit = async () => {
    if (!CALL_RE.test(cs) || note.trim().length < 3) {
      setErr(!CALL_RE.test(cs) ? "Enter a valid callsign." : "Say why the cache changes owner.");
      return;
    }
    if (
      !(await confirmDialog({
        title: `Make ${cs} the owner of ${props.cache.code}?`,
        message: `The cache changes owner; its finds and logbook stay.${activate ? " It becomes active again." : " It keeps its status until the new owner edits it."}`,
        confirmLabel: "Assign owner",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    setErr(null);
    try {
      await assignCacheOwner(props.cache.id, cs, note.trim(), activate);
      toast(`${props.cache.code} now belongs to ${cs}`);
      setOpen(false);
      props.onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  if (!open)
    return (
      <Button
        aria-expanded={false}
        disabled={props.disabled}
        title={props.disabled ? "The owner's notice period is still running" : undefined}
        onClick={() => setOpen(true)}
      >
        Assign…
      </Button>
    );
  return (
    <div className="partner-form">
      <label>
        New owner
        <input
          className="mono"
          placeholder="VK2ABC"
          value={call}
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={!!err && !CALL_RE.test(cs)}
          onChange={(e) => setCall(e.target.value)}
        />
      </label>
      <label>
        Why it changes owner
        <input
          placeholder="asked by email, licence checked"
          value={note}
          maxLength={300}
          aria-invalid={!!err && note.trim().length < 3}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="row">
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> The container is
        confirmed in place: make the cache active
      </label>
      <div className="row end">
        <Button onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submit()}>
          {saving ? "Assigning…" : "Assign owner"}
        </Button>
      </div>
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- first-install checklist (Setup)
const SETUP_GROUP_ORDER: SetupItem["group"][] = ["security", "identity", "delivery", "trust", "legal", "data"];
const byGroup = (a: SetupItem, b: SetupItem) => SETUP_GROUP_ORDER.indexOf(a.group) - SETUP_GROUP_ORDER.indexOf(b.group);

/** One checklist row: status chip (text, never colour alone), name, env marker, one-line detail. */
function SetupRow(props: { item: SetupItem }) {
  const i = props.item;
  return (
    <li className="setup-item">
      <Badge kind={i.status === "ok" ? "found" : i.status === "warn" ? "warn" : "dnf"}>
        {i.status === "ok" ? "ok" : i.status === "warn" ? "check" : "missing"}
      </Badge>
      <span className="setup-name">
        {i.label} {i.source === "env" && <span className="muted mono">env</span>}
      </span>
      <span className="setup-detail">{i.detail}</span>
    </li>
  );
}

/**
 * The web-driven first-install wizard, within its hard boundary: security-critical settings are
 * env-only (deploy/.env, systemd EnvironmentFile, wrangler secrets), so the checklist shows their
 * presence READ-ONLY — the server never echoes a secret value, and nothing here writes env config.
 * Items come in three levels so a working box reads as working: Blocking (sign-in or ingest broken),
 * Recommended for a public instance, and Optional (collapsed). Runtime-writable state (peers,
 * partners, trust) lives in the sibling admin groups; each DB row says where it is managed.
 */
/**
 * The daily D1 write budget's banner: shown once today's writes crossed 80 % of the budget, and saying what
 * the instance stops storing at each level. Nothing is shown below 80 % or when the instance sets no budget.
 */
function WriteBudgetBanner(props: { budget: WriteBudget; onDocs: (slug: string) => void }) {
  const b = props.budget;
  if (b.level !== "warn" && b.level !== "over") return null;
  const over = b.level === "over";
  const pct = Math.floor((b.used / b.budget) * 100);
  const since = b.alerts.find((a) => a.day === b.day && a.threshold === (over ? 100 : 80));
  return (
    <div className={over ? "inline-note budget-note bad" : "inline-note budget-note"} role="status">
      <strong>
        D1 writes at {pct} % of today's budget
        {since && ` since ${new Date(since.at).toISOString().slice(11, 16)} UTC`}
      </strong>
      <span className="mono">
        {b.used.toLocaleString()} of {b.budget.toLocaleString()} rows
      </span>
      <p className="m-0">
        {over
          ? "Only protected stations, RF hearings, finds, accounts and federation data are stored; other stations reach the live map without being saved."
          : "The raw packet log is paused and stations nothing protects store fewer fixes."}{" "}
        The count starts again at 00:00 UTC.{" "}
        <Button variant="inline" onClick={() => props.onDocs("reference/cloudflare-costs")}>
          About the write budget
        </Button>
      </p>
    </div>
  );
}

function SetupAdmin(props: {
  setup: { data?: { items: SetupItem[] }; error: string | null; loading: boolean; reload: () => void };
  onDocs: (slug: string) => void;
}) {
  const { error, loading, reload: refresh } = props.setup;
  const items = props.setup.data?.items;

  if (error) return <ErrorState onRetry={refresh}>{error}</ErrorState>;
  if (!items) return <EmptyState>Checking this instance's configuration…</EmptyState>;

  const level = (l: SetupItem["level"]) => items.filter((i) => i.level === l).sort(byGroup);
  const blocking = level("blocking");
  const recommended = level("recommended");
  const optional = level("optional");
  const open = (rows: SetupItem[]) => rows.filter((i) => i.status !== "ok").length;
  const broken = open(blocking);
  return (
    <>
      <p className={broken ? "error" : "muted"} role="status">
        {broken === 0
          ? "Sign-in and ingest work."
          : `${broken} blocking item${broken === 1 ? "" : "s"}: sign-in or ingest is not working yet.`}
        {broken === 0 && open(recommended) > 0 && ` ${open(recommended)} recommended for a public instance.`}
      </p>
      <h4 className="set-subh">Blocking</h4>
      <ul className="setup-list">
        {blocking.map((i) => (
          <SetupRow key={i.key} item={i} />
        ))}
      </ul>
      <h4 className="set-subh">Recommended for a public instance</h4>
      <ul className="setup-list">
        {recommended.map((i) => (
          <SetupRow key={i.key} item={i} />
        ))}
      </ul>
      <Disclosure label={`Optional (${optional.length}${open(optional) ? `, ${open(optional)} not set up` : ""})`}>
        <ul className="setup-list">
          {optional.map((i) => (
            <SetupRow key={i.key} item={i} />
          ))}
        </ul>
      </Disclosure>
      {items.some((i) => i.key === "44net") && (
        <>
          <h4 className="set-subh">44Net</h4>
          <Disclosure label="Check what peers find in DNS">
            <Net44Check />
          </Disclosure>
        </>
      )}
      <p className="muted fine">
        Items marked <span className="mono">env</span> are read-only here: set them in the deployment environment (
        <span className="mono">deploy/.env</span>, the systemd unit, or{" "}
        <span className="mono">wrangler secret put</span>) and restart.{" "}
        <Button variant="inline" onClick={() => props.onDocs("run/first-hour")}>
          Your first hour as sysop
        </Button>
      </p>
      <Button onClick={refresh} disabled={loading}>
        {loading ? "Checking…" : "Re-check"}
      </Button>
    </>
  );
}

const NET44_BADGE: Record<Net44CheckLine["status"], { kind?: string; text: string }> = {
  pass: { kind: "found", text: "ok" },
  warn: { kind: "warn", text: "check" },
  fail: { kind: "dnf", text: "fail" },
  info: { text: "info" },
};

/**
 * The 44Net self-check's body: mounts on open, so the DNS lookups run only when the operator asks. The
 * server only reads DNS and its own descriptor; nothing here or there changes peers or trust.
 */
function Net44Check() {
  const { data, error, loading, reload } = useLoad(() => run44netCheck(), []);
  if (error) return <ErrorState onRetry={reload}>{error}</ErrorState>;
  if (!data) return <EmptyState>Looking up this instance's 44Net names…</EmptyState>;
  if (!data.applicable) return <EmptyState>No 44net endpoint in FED_ENDPOINTS.</EmptyState>;
  return (
    <>
      <ul className="setup-list">
        {data.lines.map((l) => (
          <li key={l.id} className="setup-item">
            <Badge kind={NET44_BADGE[l.status].kind}>{NET44_BADGE[l.status].text}</Badge>
            <span className="setup-name">{l.label}</span>
            <span className="setup-detail">{l.detail}</span>
            {l.fix && <span className="setup-fix">{l.fix}</span>}
          </li>
        ))}
      </ul>
      <p className="muted fine">
        Read-only: DNS lookups through <span className="mono">DOH_URL</span> and this instance's own descriptor. It does
        not test whether peers can reach you.
      </p>
      <Button onClick={reload} disabled={loading}>
        {loading ? "Checking…" : "Check again"}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------- federation peers + trust
function FederationAdmin() {
  const fmt = useFmt();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const list = useLoad(() => listFederationPeers().then((r) => r.peers), []);
  const peers = list.data;
  const refresh = list.reload;
  const trust = async (p: FedPeer, t: "trusted" | "unvetted" | "blocked", done: string) => {
    if (
      t === "blocked" &&
      !(await confirmDialog({
        title: `Block ${p.instance ?? p.url}?`,
        message: "What this instance signs is quarantined from now on. Unvet or trust it to undo.",
        confirmLabel: "Block",
        danger: true,
      }))
    )
      return;
    try {
      await setPeerTrust(p.url, t);
      toast(done);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <FederationSyncStatus onSynced={refresh} />
      <Fed44netWizard onAdmitted={refresh} />
      {list.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load the peer list.</ErrorState>
      ) : peers === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : peers.length === 0 ? (
        <EmptyState>No federation peers configured.</EmptyState>
      ) : (
        <ul className="logs">
          {peers.map((p) => {
            const name = p.instance ?? p.url;
            // a discovered peer is listed but never synced until the operator picks a level for it
            const waiting = !Number(p.enabled) && p.trust !== "blocked";
            return (
              <li key={p.url}>
                <Badge
                  kind={waiting ? undefined : p.health === "ok" ? "found" : p.health === "error" ? "dnf" : "warn"}
                  title={`trust: ${p.trust}`}
                >
                  {waiting ? "not enabled" : p.health}
                </Badge>
                <span className="mono">{name}</span>
                <span className="muted">
                  {" "}
                  · {p.trust}
                  {p.added_via ? ` (${p.added_via})` : ""}
                  {p.signed ? " · signed" : ""}
                </span>
                <div className="comment">
                  {waiting
                    ? "discovered · not synced until you enable it"
                    : `${p.last_ok ? `synced ${fmt.ago(p.last_ok)}` : "never synced"} · ${p.mirrored_total} mirrored`}
                  {p.rep_confirmed > 0 && ` · ${p.rep_confirmed} confirmed`}
                  {p.rep_failed > 0 && ` · ${p.rep_failed} contradicted`}
                  {p.sync_err > 0 && ` · ${Math.round(p.errorRate * 100)}% errors`}
                </div>
                {p.health === "error" && p.last_error && <div className="comment error">{p.last_error}</div>}
                <div className="row">
                  {waiting && (
                    <Button
                      variant="primary"
                      aria-label={`Enable ${name} as unvetted`}
                      onClick={() => void trust(p, "unvetted", `${name} enabled, unvetted`)}
                    >
                      Enable
                    </Button>
                  )}
                  <Button
                    disabled={p.trust === "trusted"}
                    aria-label={`Trust ${name}`}
                    onClick={() => void trust(p, "trusted", `${name} trusted`)}
                  >
                    Trust
                  </Button>
                  <Button
                    disabled={p.trust === "unvetted"}
                    aria-label={`Unvet ${name}`}
                    onClick={() => void trust(p, "unvetted", `${name} unvetted`)}
                  >
                    Unvet
                  </Button>
                  <Button
                    variant="danger"
                    disabled={p.trust === "blocked"}
                    aria-label={`Block ${name}`}
                    onClick={() => void trust(p, "blocked", `${name} blocked`)}
                  >
                    Block
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const FEED_LABEL: Record<string, string> = { tombstone: "deletions", cache: "caches", find: "finds", key: "keys" };

/**
 * Sync state at a glance. On a spoke: the hub, the last push, the records still to push and, during an
 * outage, since when; Sync now pulls and pushes at once. On a hub: each spoke's last submission, stale
 * after the configured hours. Display only.
 */
function FederationSyncStatus(props: { onSynced: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const st = useLoad(getFederationSync, []);
  const [busy, setBusy] = useState(false);
  const s = st.data;
  if (st.error) return <ErrorState onRetry={st.reload}>Couldn't load the sync state.</ErrorState>;
  if (!s || (!s.hub && s.spokes.length === 0)) return null;
  const syncNow = async () => {
    setBusy(true);
    try {
      await syncFederationNow();
      toast("Sync started");
      // the sync runs in the background; read its outcome a little later
      setTimeout(() => {
        st.reload();
        props.onSynced();
        setBusy(false);
      }, 4000);
    } catch (e) {
      toast((e as Error).message);
      setBusy(false);
    }
  };
  const hub = s.hub;
  const waiting = hub
    ? Object.entries(hub.waiting)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n >= hub.waitingCap ? `${n}+` : n} ${FEED_LABEL[t] ?? t}`)
    : [];
  return (
    <div className="fed-sync">
      {hub && (
        <div className="fed-sync-hub">
          <div className="row">
            <Badge kind={hub.offlineSince ? "dnf" : hub.lastOkAt ? "found" : "warn"}>
              {hub.offlineSince ? "offline" : hub.lastOkAt ? "ok" : "new"}
            </Badge>
            <span>
              Hub <span className="mono">{hub.url}</span>
            </span>
          </div>
          <div className="comment">
            {hub.lastOkAt ? `last push ${fmt.ago(hub.lastOkAt)}` : "not pushed yet"}
            {" · "}
            {waiting.length ? `waiting: ${waiting.join(", ")}` : "nothing waiting"}
            {hub.offlineSince && ` · offline since ${fmt.dateTime(hub.offlineSince)}, retrying`}
          </div>
          {hub.lastError && !hub.offlineSince && <div className="comment error">{hub.lastError}</div>}
        </div>
      )}
      {s.spokes.length > 0 && (
        <>
          <h4>Spokes pushing here</h4>
          <ul className="logs">
            {s.spokes.map((sp) => (
              <li key={sp.instance}>
                <Badge kind={sp.stale ? "warn" : "found"}>{sp.stale ? "stale" : "ok"}</Badge>
                <span className="mono">{sp.instance}</span>
                <span className="muted"> · {sp.trust ?? "unknown"}</span>
                <div className="comment">
                  last submit {fmt.ago(sp.lastSubmitAt)}
                  {sp.newestCacheChange ? ` · newest cache change ${fmt.dateTime(sp.newestCacheChange)}` : ""}
                  {sp.stale && ` · nothing for over ${s.staleHours} h`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button onClick={() => void syncNow()} disabled={busy}>
        {busy ? "Syncing…" : "Sync now"}
      </Button>
    </div>
  );
}

/** A typed callsign or host: a name with a dot is a host in a callsign's ampr.org zone. */
function targetOf(value: string): Fed44netTarget | null {
  const v = value.trim();
  if (!v) return null;
  return v.includes(".") ? { host: v.toLowerCase() } : { callsign: v.toUpperCase() };
}

/**
 * 44net verified onboarding. ARDC's portal reviews a licence before delegating `<call>.ampr.org`,
 * so adding a peer by callsign, or by a host in that zone, resolves its `_aprscaching` TXT binding:
 * DNSSEC-validated bindings admit in one click, anything else shows the resolved key for an explicit
 * operator confirm (a trust-on-first-use pin). A name with several bindings lists them to add one by
 * its host. The disclosure underneath emits this instance's OWN TXT record to paste into the ARDC
 * portal so other operators can add us the same way.
 */
function Fed44netWizard(props: { onAdmitted: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ target: Fed44netTarget; result: Fed44netResult } | null>(null);
  const [candidates, setCandidates] = useState<Fed44netCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (target: Fed44netTarget | null, confirm: boolean) => {
    if (!target) return;
    setBusy(true);
    setError(null);
    setCandidates([]);
    try {
      const r = await add44netPeer(target, confirm);
      if (r.requiresConfirm) setPending({ target, result: r });
      else if (r.ok) {
        setPending(null);
        setValue("");
        const name = "host" in target ? target.host : target.callsign;
        toast(`Peer ${r.peer?.instance ?? name} admitted (${r.admitted === "dnssec" ? "DNSSEC-verified" : "pinned"})`);
        props.onAdmitted();
      }
    } catch (e) {
      setPending(null);
      setError((e as Error).message);
      const found = e instanceof ApiError ? (e.data as { candidates?: Fed44netCandidate[] }).candidates : undefined;
      if (Array.isArray(found)) setCandidates(found);
    } finally {
      setBusy(false);
    }
  };
  const resolved = pending?.result.resolved;

  return (
    <div className="fed44net">
      <div className="row">
        <input
          placeholder="Add a peer by callsign or host (44net)"
          value={value}
          onChange={(e) => {
            setValue(e.target.value.includes(".") ? e.target.value : e.target.value.toUpperCase());
            setPending(null);
            setCandidates([]);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && !busy && !pending && void submit(targetOf(value), false)}
          aria-label="Peer callsign or host on 44net"
        />
        <Button
          variant="primary"
          disabled={busy || !value.trim() || !!pending}
          onClick={() => void submit(targetOf(value), false)}
        >
          {busy && !pending ? "Resolving…" : "Look up"}
        </Button>
      </div>
      <div className="comment">
        Resolves the peer's ARDC-verified binding: a callsign reads <span className="mono">&lt;call&gt;.ampr.org</span>,
        a host such as <span className="mono">pocket.&lt;call&gt;.ampr.org</span> reads that host's own record.
      </div>
      {error && <div className="comment error">{error}</div>}
      {candidates.length > 0 && (
        <ul className="fed44net-candidates">
          {candidates.map((c) => (
            <li key={`${c.instance} ${c.host}`} className="row">
              <span className="mono">{c.host}</span> · <span className="mono">{c.instance}</span>
              <Button disabled={busy} onClick={() => void submit({ host: c.host }, false)}>
                Add by host
              </Button>
            </li>
          ))}
        </ul>
      )}
      {pending && resolved && (
        <div className="confirmbox">
          <div>
            <Badge kind="warn">no DNSSEC</Badge> <span className="mono">{resolved.host}</span> ·{" "}
            <span className="mono">{resolved.instance}</span>
          </div>
          <div className="comment mono">key {resolved.publicKey.slice(0, 16)}…</div>
          <div className="comment">
            The resolver could not DNSSEC-validate this binding
            {pending.result.descriptorChecked
              ? " (the live descriptor matches it)"
              : " and the peer was not reachable"}{" "}
            — confirming pins this key for the peer.
          </div>
          <div className="row">
            <Button variant="primary" disabled={busy} onClick={() => void submit(pending.target, true)}>
              Confirm &amp; pin
            </Button>
            <Button disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <MyTxtRecord />
    </div>
  );
}

/** The instance's own DNS binding — what an operator pastes into the ARDC portal to be addable. */
function MyTxtRecord() {
  return (
    <Disclosure label="Be reachable on 44net">
      <TxtRecordBody />
    </Disclosure>
  );
}

/** The disclosure's body: mounts on open, so a failed descriptor load retries by reopening. */
function TxtRecordBody() {
  const toast = useToast();
  const [call, setCall] = useState("");
  const { data: desc, error } = useLoad(
    () =>
      getFedDescriptor().then((d) => {
        if (d.aprsCall) setCall((c) => c || (d.aprsCall!.split("-")[0] ?? ""));
        return d;
      }),
    [],
  );
  const zone = `${call.trim().toLowerCase()}.ampr.org`;
  // a 44net endpoint on a subdomain of the call's zone publishes its own record, so one callsign can run
  // several instances; peers add it by that host
  const sub = desc?.addresses
    ?.find((a) => a.transport === "44net" && a.address.toLowerCase().endsWith(`.${zone}`))
    ?.address.toLowerCase();
  const record =
    desc?.signed && desc.publicKey && call.trim()
      ? `_aprscaching.${sub ?? zone}  TXT  "v=acs1; inst=${desc.instance}; key=${desc.publicKey}"`
      : null;
  if (error)
    return <div className="comment error">Couldn't load this instance's descriptor — close and reopen to retry.</div>;
  if (desc && !desc.signed)
    return <div className="comment">Configure a federation signing key to publish a verifiable 44net binding.</div>;
  return (
    <>
      <div className="row">
        <input
          placeholder="Your base callsign"
          value={call}
          onChange={(e) => setCall(e.target.value.toUpperCase())}
          aria-label="Your base callsign"
        />
        <Button
          disabled={!record}
          onClick={() => {
            if (record)
              void copyText(record).then((ok) =>
                toast(ok ? "TXT record copied" : "Copy failed — select the record text and copy manually"),
              );
          }}
        >
          Copy
        </Button>
      </div>
      {record && <div className="comment mono">{record}</div>}
      <div className="comment">
        Paste this TXT into your <span className="mono">&lt;call&gt;.ampr.org</span> DNS at the ARDC portal
        (portal.ampr.org) — other instances can then add you by {sub ? <span className="mono">{sub}</span> : "callsign"}
        , verified. Portal changes publish within about an hour.
      </div>
    </>
  );
}

// ---------------------------------------------------------------- FBB forwarding partners + routing rules
const EMPTY_PARTNER: Partial<ForwardPartner> & { call: string } = { call: "", proto: "rf-fbb", connectScript: "" };

function ForwardingAdmin() {
  const toast = useToast();
  const confirmDialog = useConfirm();
  const lists = useLoad(
    () =>
      Promise.all([listForwardPartners(), listForwardRules()]).then(([p, r]) => ({
        partners: p.partners,
        rules: r.rules,
      })),
    [],
  );
  const partners: ForwardPartner[] | undefined = lists.data?.partners;
  const rules: ForwardRuleRow[] | undefined = lists.data?.rules;
  const refresh = lists.reload;
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<Partial<ForwardPartner> & { call: string }>(EMPTY_PARTNER);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [rule, setRule] = useState({ partner: "", route: "" });

  const togglePartner = async (p: ForwardPartner, enabled: boolean) => {
    try {
      await saveForwardPartner({ ...p, enabled });
      toast(`Forwarding to ${p.call} ${enabled ? "on" : "off"}`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  // the form keeps what was typed until the partner is saved, so a refused save is corrected, not retyped
  const submitPartner = async () => {
    if (!form.call.trim()) {
      setFormErr("Enter the partner BBS's callsign.");
      return;
    }
    setSaving(true);
    setFormErr(null);
    try {
      await saveForwardPartner(form);
      toast(`Partner ${form.call.trim().toUpperCase()} saved`);
      setForm(EMPTY_PARTNER);
      setAdding(false);
      refresh();
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const removePartner = async (p: ForwardPartner) => {
    if (
      !(await confirmDialog({
        title: `Remove forwarding partner ${p.call}?`,
        message: "Its schedule and routing rules pointing at it stop forwarding.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await deleteForwardPartner(p.id);
      toast(`Partner ${p.call} removed`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const submitRule = async () => {
    if (!rule.partner.trim() || !rule.route.trim()) {
      toast("Route + partner required");
      return;
    }
    try {
      await saveForwardRule({ partner: rule.partner, route: rule.route, transport: "rf-fbb" });
      toast(`Rule ${rule.route.trim().toUpperCase()} added`);
      setRule({ partner: "", route: "" });
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const removeRule = async (r: ForwardRuleRow) => {
    if (
      !(await confirmDialog({
        title: `Remove rule ${r.route} → ${r.partner}?`,
        message: "Mail for that route falls back to the default federation catch-all.",
        confirmLabel: "Remove",
        danger: true,
      }))
    )
      return;
    try {
      await deleteForwardRule(r.id);
      toast("Rule removed");
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <>
      <h4 className="set-subh">Partners</h4>
      {lists.error ? (
        <ErrorState onRetry={refresh}>Couldn&apos;t load partners and rules.</ErrorState>
      ) : partners === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : partners.length === 0 ? (
        <EmptyState>No forwarding partners. Add a BBS to exchange mail with over RF.</EmptyState>
      ) : (
        <ul className="logs">
          {partners.map((p) => (
            <li key={p.id}>
              <Switch
                label={`Forwarding to ${p.call}`}
                checked={p.enabled}
                onChange={(v) => void togglePartner(p, v)}
              />
              <span className="mono">{p.call}</span>
              <span className="muted">
                {" "}
                · {p.proto}
                {p.ha ? ` · ${p.ha}` : ""}
              </span>
              <Button variant="inline-danger" aria-label={`Remove ${p.call}`} onClick={() => void removePartner(p)}>
                Remove
              </Button>
              <div className="comment">
                every {p.intervalMin} min{p.timebands ? ` @ ${p.timebands} UTC` : ""} · types {p.msgtypes}
                {p.requestReverse ? " · reverse" : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="partner-form">
          <label>
            Callsign
            <input
              className="mono"
              placeholder="OE8XBM-1"
              value={form.call}
              aria-invalid={!!formErr && !form.call.trim()}
              onChange={(e) => setForm((f) => ({ ...f, call: e.target.value }))}
            />
          </label>
          <label>
            Hierarchical address
            <input
              className="mono"
              placeholder="OE8XBM.OE.EU"
              value={form.ha ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, ha: e.target.value }))}
            />
          </label>
          <label>
            Transport
            <select
              value={form.proto ?? "rf-fbb"}
              onChange={(e) => setForm((f) => ({ ...f, proto: e.target.value as ForwardPartner["proto"] }))}
            >
              <option value="rf-fbb">RF (FBB)</option>
              <option value="axudp">AXUDP</option>
              <option value="ip-fed">IP federation</option>
            </select>
          </label>
          <label>
            Connect script
            <input
              className="mono"
              placeholder="C NODE1&#10;C 3 DB0XYZ"
              value={form.connectScript ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, connectScript: e.target.value }))}
            />
          </label>
          <label>
            Interval (min)
            <input
              type="number"
              min={0}
              max={1440}
              value={form.intervalMin ?? 30}
              onChange={(e) => setForm((f) => ({ ...f, intervalMin: Number(e.target.value) }))}
            />
          </label>
          <label>
            Time-bands (UTC)
            <input
              className="mono"
              placeholder="0-6,22-23"
              value={form.timebands ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, timebands: e.target.value }))}
            />
          </label>
          {formErr && (
            <p className="error fine" role="alert">
              {formErr}
            </p>
          )}
          <div className="row">
            <Button variant="primary" disabled={saving} aria-busy={saving} onClick={() => void submitPartner()}>
              {saving ? "Saving…" : "Save partner"}
            </Button>
            <Button
              onClick={() => {
                setForm(EMPTY_PARTNER);
                setFormErr(null);
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>Add partner</Button>
      )}

      <h4 className="set-subh">
        Routing rules <span className="muted">· region → partner</span>
      </h4>
      {lists.error ? (
        <p className="muted">The rules show once the list loads.</p>
      ) : rules === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : rules.length === 0 ? (
        <EmptyState>No rules — mail routes to the default federation catch-all.</EmptyState>
      ) : (
        <ul className="logs">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="mono">{r.route}</span>{" "}
              <span className="muted">
                → {r.partner} · {r.transport}
              </span>
              <Button
                variant="inline-danger"
                aria-label={`Remove rule ${r.route} to ${r.partner}`}
                onClick={() => void removeRule(r)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <input
          className="mono"
          placeholder="route (DL, EU, *)"
          aria-label="Route (region prefix)"
          value={rule.route}
          onChange={(e) => setRule((x) => ({ ...x, route: e.target.value }))}
        />
        <input
          className="mono"
          placeholder="partner call"
          aria-label="Partner callsign"
          value={rule.partner}
          onChange={(e) => setRule((x) => ({ ...x, partner: e.target.value }))}
        />
        <Button onClick={() => void submitRule()}>Add rule</Button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- ingest transports + TAK/CoT feed
function IngestAdmin(props: { map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const list = useLoad(() => getPorts().then((r) => r.ports), []);
  const ports: PortStat[] | undefined = list.data;
  const feedUrl = (() => {
    const b = props.map?.getBounds();
    return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : "";
  })();
  return (
    <>
      <h4 className="set-subh">
        Transports{" "}
        <span className="muted">{ports ? `· ${ports.length} port${ports.length === 1 ? "" : "s"} ` : ""}· 24h RX</span>
      </h4>
      {list.error ? (
        <ErrorState onRetry={list.reload}>Couldn&apos;t load port statistics.</ErrorState>
      ) : ports === undefined ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : ports.length === 0 ? (
        <EmptyState>No traffic yet.</EmptyState>
      ) : (
        ports.map((p) => (
          <div className="setrow" key={p.port}>
            <div className="setrow-l">
              <span className="mono">{p.port}</span>
            </div>
            <div className="setrow-c muted">{fmt.num(p.rx, 0)} rx</div>
          </div>
        ))
      )}
      <h4 className="set-subh">TAK / CoT feed</h4>
      <p className="muted">Add this as a data feed in ATAK/WinTAK to see this instance's APRS stations as CoT:</p>
      <div className="row">
        <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
        <Button
          onClick={() => {
            void copyText(feedUrl).then((ok) =>
              toast(ok ? "Feed URL copied" : "Copy failed — select the URL and copy manually"),
            );
          }}
        >
          Copy
        </Button>
      </div>
    </>
  );
}
