// SPDX-License-Identifier: AGPL-3.0-or-later
import { Fragment } from "react";
import { bugReportUrl, getFedDescriptor, getSource, type SourceInfo } from "../api.js";
import { useLoad } from "../ui/index.js";

const TRANSPORT_LABEL: Record<string, string> = {
  https: "Web",
  "44net": "44Net",
  hamnet: "HAMNET",
  ax25: "AX.25",
  netrom: "NET/ROM",
  bbs: "BBS",
};

/**
 * About this instance — who runs it, where it answers, what it runs and how many peers it names, from its own
 * descriptor and source report. A field the instance does not publish is left out.
 */
export function AboutInstance() {
  const { data: d } = useLoad(getFedDescriptor, []);
  const { data: src } = useLoad<SourceInfo>(getSource, []);
  if (!d) return null;
  const version = src?.tag ?? (src?.commit ? src.commit.slice(0, 8) : null);
  return (
    <section className="about-instance" aria-labelledby="about-instance-h">
      <h4 className="set-subh" id="about-instance-h">
        About this instance
      </h4>
      <dl className="about-facts">
        <dt>Instance</dt>
        <dd className="mono">{d.instance}</dd>
        {d.operator && (
          <>
            <dt>Sysop</dt>
            <dd className="mono">{d.operator}</dd>
          </>
        )}
        {d.aprsCall && (
          <>
            <dt>APRS call</dt>
            <dd className="mono">{d.aprsCall}</dd>
          </>
        )}
        {(d.addresses ?? []).map((a) => (
          <Fragment key={`${a.transport}:${a.address}`}>
            <dt>{TRANSPORT_LABEL[a.transport] ?? a.transport}</dt>
            <dd className="mono">{a.address}</dd>
          </Fragment>
        ))}
        {d.peers && (
          <>
            <dt>Peers</dt>
            <dd>{d.peers.length === 0 ? "none named" : d.peers.length}</dd>
          </>
        )}
        {version && (
          <>
            <dt>Version</dt>
            <dd className="mono">{version}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** Report a bug — to the project whose source this instance runs; a security problem goes there privately. */
export function BugReportLink() {
  const { data: src } = useLoad<SourceInfo>(getSource, []);
  if (!src?.repo) return null;
  return (
    <p className="muted fine">
      Found a bug?{" "}
      <a href={bugReportUrl(src.repo)} target="_blank" rel="noreferrer">
        Report it
      </a>{" "}
      to the project this instance runs. A security problem goes there privately, never in a public report.
    </p>
  );
}
