// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import {
  getSupport,
  getSupportPrefs,
  setSupportPrefs,
  supportUrl,
  type SupportInfo,
  type SupportPrefs,
} from "../api.js";
import { Row, Switch, useToast } from "../ui/index.js";

/**
 * Settings → Support. Recognition only — donations gate nothing. Shows donation links,
 * the public ledger summary, your supporter status, and the hide-the-nag toggle.
 */
export function SupportSettings(props: { signedIn: boolean }) {
  const toast = useToast();
  const [info, setInfo] = useState<SupportInfo | null>(null);
  const [prefs, setPrefs] = useState<SupportPrefs | null>(null);
  useEffect(() => {
    getSupport()
      .then(setInfo)
      .catch(() => {});
    if (props.signedIn)
      getSupportPrefs()
        .then(setPrefs)
        .catch(() => {});
  }, [props.signedIn]);

  const eur = (c: number) =>
    (c / 100).toLocaleString(undefined, { style: "currency", currency: info?.ledger.currency || "EUR" });
  const l = info?.ledger;

  return (
    <>
      <p className="muted">
        Everyone gets everything for free. Supporters give because they want the project to live and get recognition — a
        badge and the ability to hide the support prompt — never extra functionality. No ads, no paywalls.
      </p>

      {prefs?.supporter && (
        <p>
          <span className="award">♥ Supporter</span> — thank you for keeping this running.
        </p>
      )}

      <Row label="Donate">
        {info?.donationLinks.length ? (
          <span className="row gap-2 wrap">
            {info.donationLinks.map((d) => (
              <a key={d.url} href={d.url} target="_blank" rel="noreferrer noopener">
                {d.label}
              </a>
            ))}
          </span>
        ) : (
          <span className="muted">Donation links are set per instance.</span>
        )}
      </Row>

      {l && (
        <Row label="Ledger" help="What came in and how it was spent (public transparency)">
          <span className="mono">
            in {eur(l.totalInCents)} · out {eur(l.totalOutCents)} · bal {eur(l.balanceCents)}
          </span>
        </Row>
      )}

      {props.signedIn && (
        <Row label="Hide the support prompt" help="Stops the gentle nudge to support the project">
          <Switch
            label="Hide the support prompt"
            checked={!!prefs?.hideNag}
            onChange={(v) => {
              setSupportPrefs(v)
                .then(setPrefs)
                .catch(() => toast("Couldn't save this preference — try again"));
            }}
          />
        </Row>
      )}

      <p className="muted fine">
        <a href={supportUrl} target="_blank" rel="noreferrer noopener">
          Open the full /support ledger ↗
        </a>
        {info ? (
          <>
            {" "}
            · {info.supporterCount} supporter{info.supporterCount === 1 ? "" : "s"}
          </>
        ) : null}
      </p>
    </>
  );
}
