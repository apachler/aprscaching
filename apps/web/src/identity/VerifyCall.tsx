// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import {
  startAprsVerify,
  getVerifyStatus,
  getVerifyMethods,
  startAmprVerify,
  checkAmprVerify,
  startLotwVerify,
  completeLotwVerify,
  errorText,
  ApiError,
  type VerifyChallenge,
  type AmprChallenge,
  type VerifyMethods,
} from "../api.js";
import { Icon, copyText, useToast } from "../ui/index.js";
import { useFmt } from "../format.js";
import { signWithP12 } from "./lotw.js";

/** How often an on-air challenge polls for the site having heard the message. */
const POLL_MS = 5000;

type Method = "rf" | "ampr" | "lotw";
const METHODS: { id: Method; label: string }[] = [
  { id: "rf", label: "On the air" },
  { id: "ampr", label: "ampr.org DNS" },
  { id: "lotw", label: "LoTW certificate" },
];

const reason = errorText;

/** What to say when this instance has no receiving site to hear an on-air message. */
const NO_SITE = "This instance has no receiving station yet — ask the operator, or use another method.";

/**
 * Verify one held base call. The ways to prove control are a grouped choice: a transmission heard on the
 * air (APRS or MeshCom — the default where this instance has a receiving site), a code published in the
 * call's ampr.org DNS, or a signature from the call's LoTW certificate. A sysop can also verify by hand.
 * The methods this instance offers are asked for once; without a receiving site the on-air method says
 * so and points at the others instead of handing out a code nothing could hear.
 */
export function VerifyCall(props: { callsign: string; onVerified: () => void; onClose: () => void }) {
  const [methods, setMethods] = useState<VerifyMethods | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const [done, setDone] = useState(false);
  const { onVerified } = props;
  const verified = useCallback(() => {
    setDone(true);
    onVerified();
  }, [onVerified]);
  useEffect(() => {
    let live = true;
    getVerifyMethods()
      .then((m) => live && setMethods(m))
      // unknown: offer every method and let each one's own request say what is missing
      .catch(() => live && setMethods({ methods: { rf_heard: true, ampr_dns: true, lotw: true } }));
    return () => {
      live = false;
    };
  }, []);
  const rfOk = methods?.methods.rf_heard ?? true;
  const shown = METHODS.filter((m) => m.id !== "lotw" || (methods?.methods.lotw ?? true));
  const active: Method = method ?? (rfOk ? "rf" : "ampr");
  return (
    <section className="verify-code" aria-label={`Verify ${props.callsign}`}>
      {done ? (
        <p className="m-0" role="status">
          <Icon name="check" size={12} /> <span className="mono">{props.callsign}</span> is verified.
        </p>
      ) : (
        <>
          <p className="m-0">
            Prove you control <span className="mono">{props.callsign}</span>:
          </p>
          {methods && !rfOk && (
            <p className="inline-note m-0" role="note">
              {NO_SITE}
            </p>
          )}
          <div className="seg verify-methods" role="group" aria-label="Verification method">
            {shown.map((m) => (
              <button
                key={m.id}
                className={active === m.id ? "on" : ""}
                aria-pressed={active === m.id}
                onClick={() => setMethod(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {!methods ? (
            <p className="muted fine" role="status">
              Checking…
            </p>
          ) : (
            <>
              {active === "rf" &&
                (rfOk ? (
                  <OnAir
                    callsign={props.callsign}
                    sites={methods.rfSites ?? []}
                    onVerified={verified}
                    onNoSite={() => setMethods({ ...methods, methods: { ...methods.methods, rf_heard: false } })}
                  />
                ) : (
                  <p className="muted fine">
                    On-air verification needs a receiving station run by this instance to hear your message. Use{" "}
                    <button className="link" onClick={() => setMethod("ampr")}>
                      ampr.org DNS
                    </button>
                    {methods.methods.lotw && (
                      <>
                        {" or "}
                        <button className="link" onClick={() => setMethod("lotw")}>
                          your LoTW certificate
                        </button>
                      </>
                    )}{" "}
                    instead.
                  </p>
                ))}
              {active === "ampr" && <AmprDns callsign={props.callsign} onVerified={verified} />}
              {active === "lotw" && <LotwCert callsign={props.callsign} onVerified={verified} />}
            </>
          )}
          <p className="muted fine mt-2 mb-0">
            None of these within reach? A sysop of this instance can verify your call by hand.
          </p>
        </>
      )}
      <div className="row end mt-2">
        <button onClick={props.onClose}>{done ? "Done" : "Cancel"}</button>
      </div>
    </section>
  );
}

type RfState = "idle" | "waiting" | "expired";

/** The listening site calls, in words: "OE8XXX", "OE8XXX or OE8YYY", "OE8XXX, OE8YYY or OE8ZZZ". */
function siteList(sites: string[]): string {
  return sites.length <= 1 ? (sites[0] ?? "") : `${sites.slice(0, -1).join(", ")} or ${sites[sites.length - 1]}`;
}

/** Transmit `VERIFY <code>` to the service call; this instance's own receiving site must hear it. */
function OnAir(props: { callsign: string; sites: string[]; onVerified: () => void; onNoSite: () => void }) {
  const [ch, setCh] = useState<VerifyChallenge | null>(null);
  const [state, setState] = useState<RfState>("idle");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pollErr, setPollErr] = useState(false);
  const fmt = useFmt();
  const toast = useToast();
  const { callsign, onVerified } = props;

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      setCh(await startAprsVerify(callsign));
      setState("waiting");
      setPollErr(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) props.onNoSite();
      else setErr(reason(e));
    } finally {
      setBusy(false);
    }
  }

  // Poll until the receiving site hears the message or the code expires.
  useEffect(() => {
    if (!ch || state !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      if (Date.now() / 1000 > ch.expiresAt) {
        setState("expired");
        return;
      }
      try {
        const r = await getVerifyStatus(callsign);
        if (stopped) return;
        setPollErr(false);
        if (r.verified) onVerified();
      } catch {
        if (!stopped) setPollErr(true);
      }
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [ch, state, callsign, onVerified]);

  if (!ch || state === "idle")
    return (
      <>
        <p className="muted fine">
          Send a short APRS message from <span className="mono">{callsign}</span> (any SSID) with your radio, or a
          MeshCom message from your node. It counts only when this instance&apos;s own receiving site hears it directly
          — a copy via APRS-IS, the MeshCom server or other mesh nodes does not.
        </p>
        {props.sites.length > 0 && <Listening sites={props.sites} />}
        {err && (
          <p className="error m-0" role="alert">
            {err}
          </p>
        )}
        <div className="row end">
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting…" : "Get a code"}
          </button>
        </div>
      </>
    );
  return (
    <>
      <p className="m-0">Send this message on the air:</p>
      <dl className="verify-msg">
        <dt>To</dt>
        <dd className="mono">{ch.to}</dd>
        <dt>Message</dt>
        <dd className="mono">{ch.text}</dd>
      </dl>
      {(ch.sites ?? props.sites).length > 0 && <Listening sites={ch.sites ?? props.sites} />}
      {state === "waiting" ? (
        <p className="muted m-0" role="status" aria-live="polite">
          {pollErr
            ? "Can't reach the server — still trying."
            : `Listening for your message until ${fmt.time(ch.expiresAt)}…`}
        </p>
      ) : (
        <p className="error m-0" role="status">
          The code expired before the site heard it. Get a new code and transmit again.
        </p>
      )}
      <div className="row end">
        {state === "waiting" ? (
          <button
            className="primary"
            onClick={async () =>
              toast((await copyText(ch.text)) ? "Message copied" : "Couldn't copy — type it on the radio as shown")
            }
          >
            Copy message
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting…" : "Get a new code"}
          </button>
        )}
      </div>
    </>
  );
}

/** Which receiving sites are listening: their calls are public, and they tell the holder who must hear them. */
function Listening(props: { sites: string[] }) {
  return (
    <p className="muted fine m-0">
      Receiving stations: <span className="mono">{siteList(props.sites)}</span> — transmit within range of{" "}
      {props.sites.length === 1 ? "it" : "one of them"}.
    </p>
  );
}

/** Publish a code as a TXT record under the call's ampr.org name, then have the gateway look it up. */
function AmprDns(props: { callsign: string; onVerified: () => void }) {
  const [ch, setCh] = useState<AmprChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await step();
    } catch (e) {
      setErr(reason(e));
    } finally {
      setBusy(false);
    }
  }
  const start = () => run(async () => setCh(await startAmprVerify(props.callsign)));
  const check = () =>
    run(async () => {
      await checkAmprVerify(props.callsign);
      props.onVerified();
    });

  return (
    <>
      <p className="muted fine">
        If ARDC has delegated <span className="mono">{props.callsign.toLowerCase()}.ampr.org</span> to you, publish a
        TXT record there at the ARDC portal (DNS → My subdomains).
      </p>
      <p className="muted fine">
        Without DNSSEC, several public DNS resolvers must return the same record. The portal can take a while to publish
        a new record, so check again later if it is not found yet.
      </p>
      {ch && (
        <dl className="verify-msg">
          <dt>Name</dt>
          <dd className="mono">{ch.name}</dd>
          <dt>Type</dt>
          <dd className="mono">TXT</dd>
          <dt>Value</dt>
          <dd className="mono">{ch.value}</dd>
        </dl>
      )}
      {err && (
        <p className="error m-0" role="alert">
          {err}
        </p>
      )}
      <div className="row end">
        {ch ? (
          <>
            <button
              onClick={async () => toast((await copyText(ch.value)) ? "Value copied" : "Couldn't copy — select it")}
            >
              Copy value
            </button>
            <button className="primary" disabled={busy} onClick={() => void check()}>
              {busy ? "Checking…" : "Check"}
            </button>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? "Starting…" : "Get the record"}
          </button>
        )}
      </div>
    </>
  );
}

/** Sign a challenge with the call's LoTW certificate, opened from its TQSL .p12 file in this browser. */
function LotwCert(props: { callsign: string; onVerified: () => void }) {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getVerifyMethods()
      .then((r) => live && setOffered(r.methods.lotw))
      .catch(() => live && setOffered(false));
    return () => {
      live = false;
    };
  }, []);

  async function verify() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const ch = await startLotwVerify(props.callsign);
      const proof = await signWithP12(await file.arrayBuffer(), password, ch.message);
      await completeLotwVerify(props.callsign, proof);
      setPassword("");
      props.onVerified();
    } catch (e) {
      setErr(reason(e));
    } finally {
      setBusy(false);
    }
  }

  if (offered === null)
    return (
      <p className="muted fine" role="status">
        Checking…
      </p>
    );
  if (!offered) return <p className="muted fine">This instance has not set up LoTW certificate verification.</p>;
  return (
    <>
      <p className="muted fine">
        Save your callsign certificate from TQSL as a .p12 file. It is opened in this browser: the file and its password
        never leave it — only the certificate and a signature are sent.
      </p>
      <label>
        Certificate file (.p12)
        <input type="file" accept=".p12,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label>
        File password
        <input
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && file) void verify();
          }}
        />
      </label>
      {err && (
        <p className="error m-0" role="alert">
          {err}
        </p>
      )}
      <div className="row end">
        <button className="primary" disabled={busy || !file} onClick={() => void verify()}>
          {busy ? "Verifying…" : "Verify"}
        </button>
      </div>
    </>
  );
}
