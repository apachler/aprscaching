// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { enqueueBoxCommand, getBoxLog, pairBox, needsPairing, type BoxCommand } from "../api.js";
import { useFmt } from "../format.js";
import { Button, Row, Badge, EmptyState, ErrorState, useConfirm, useToast, usePoll, Icon } from "../ui/index.js";

/**
 * Remote control of your own ingest box. The web app enqueues commands; the box pulls
 * them over its existing outbound connection. A box answers only the account it is paired to: the box
 * prints a one-time pairing code at start, and entering it here links the box. TX is gated on callsign
 * control-verification: unverified operators get RX/status only, with the transmit controls disabled +
 * a reason.
 */
export function RemoteControl(props: { callsign: string; verified: boolean; map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [boxId, setBoxId] = useState(() => {
    try {
      return localStorage.getItem("acs.boxId") ?? "";
    } catch {
      return "";
    }
  });
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [comment, setComment] = useState("");
  const [log, setLog] = useState<BoxCommand[]>([]);
  const [logErr, setLogErr] = useState(false);
  const [unpaired, setUnpaired] = useState(false);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const signedIn = props.callsign.length >= 3;
  const ready = signedIn && !!boxId && !unpaired;
  const canTx = ready && props.verified;

  useEffect(() => {
    try {
      localStorage.setItem("acs.boxId", boxId);
    } catch {
      /* ignore */
    }
  }, [boxId]);
  const refresh = useCallback(() => {
    if (boxId)
      getBoxLog(boxId)
        .then((r) => {
          setLog(r.commands);
          setLogErr(false);
          setUnpaired(false);
        })
        .catch((e) => {
          setUnpaired(needsPairing(e));
          setLogErr(!needsPairing(e));
        });
  }, [boxId]);

  async function pair() {
    setPairing(true);
    try {
      await pairBox(boxId, code.trim());
      setCode("");
      setUnpaired(false);
      toast(`${boxId} paired to your account`);
      refresh();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setPairing(false);
    }
  }
  // load now and whenever the box id changes, then every 5 s while the page is visible
  useEffect(refresh, [refresh]);
  usePoll(refresh, 5000, { immediate: false });

  // every remote transmit is a deliberate, confirmed action — same bar as the browser RF bridge
  const TX_KINDS = new Set(["beacon", "message", "igate", "digi", "tx"]);
  async function send(kind: string, payload?: unknown) {
    if (!boxId) {
      toast("Set your box ID first");
      return;
    }
    if (
      TX_KINDS.has(kind) &&
      !(await confirmDialog({
        title: `Queue ${kind} for ${boxId}?`,
        message: "The box executes this on its radio the next time it polls.",
        confirmLabel: "Queue it",
      }))
    )
      return;
    try {
      await enqueueBoxCommand(boxId, { kind, payload, callsign: props.callsign });
      toast(`${kind} queued`);
      refresh();
    } catch (e) {
      if (needsPairing(e)) setUnpaired(true);
      toast((e as Error).message);
    }
  }
  function beacon() {
    const c = props.map?.getCenter();
    send("beacon", { lat: c?.lat, lon: c?.lng, comment: comment || undefined });
  }
  function sendMessage() {
    send("message", { to: to.trim().toUpperCase(), text: text.trim() });
    setText("");
  }

  // command status is a plain status, not a trust tier — failed must LOOK failed
  const stColor: Record<string, string> = {
    done: "found",
    sent: "warn",
    queued: "",
    failed: "dnf",
    expired: "dnf",
  };

  return (
    <>
      <p className="muted">
        Operate your own ingest box — no port-forward. Commands queue here and your box pulls them.
      </p>
      <Row label="Box ID" help="The name set as BOX_ID on your ingest box">
        <input value={boxId} onChange={(e) => setBoxId(e.target.value)} placeholder="pi-home" aria-label="Box ID" />
      </Row>
      {!signedIn ? (
        <p className="muted">Sign in to control a box.</p>
      ) : unpaired ? (
        <Row
          label="Pairing code"
          help={`Printed by ${boxId} when it starts ("[box] pairing code …"), valid 15 minutes. Restart the box for a new one.`}
        >
          <div className="row gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim()) void pair();
              }}
              placeholder="ABCD-EFGH"
              aria-label="Pairing code"
              autoComplete="one-time-code"
              className="mono field-sm"
              maxLength={9}
            />
            <Button variant="primary" disabled={pairing || code.trim().length < 8} onClick={() => void pair()}>
              {pairing ? "Pairing…" : "Pair box"}
            </Button>
          </div>
        </Row>
      ) : (
        !props.verified && <p className="muted">Verify your callsign to transmit — RX &amp; status only until then.</p>
      )}
      {signedIn && unpaired && <p className="muted">Pair this box to your account before sending it commands.</p>}

      <div className="row wrap gap-2">
        <Button onClick={() => send("status")} disabled={!ready}>
          ↻ Status
        </Button>
        <Button
          onClick={beacon}
          disabled={!canTx}
          title={
            canTx ? "Beacon the map centre" : unpaired ? "Pair this box first" : "Verify your callsign to transmit"
          }
        >
          <Icon name="place" cp437="" className="lead-ic" />
          Beacon here
        </Button>
        <Button onClick={() => send("igate", { on: true })} disabled={!canTx}>
          IGate on
        </Button>
        <Button onClick={() => send("igate", { on: false })} disabled={!canTx}>
          IGate off
        </Button>
        <Button onClick={() => send("digi", { on: true })} disabled={!canTx}>
          Digi on
        </Button>
        <Button onClick={() => send("tx", { on: false })} disabled={!canTx}>
          TX off
        </Button>
      </div>

      <label>
        Beacon comment
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={43}
          placeholder="optional status text"
        />
      </label>
      <Row label="Message">
        <div className="row gap-2">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="OE3ABC"
            aria-label="To callsign"
            className="mono field-sm"
          />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={67}
            placeholder="message…"
            aria-label="Message text"
          />
          <Button variant="primary" disabled={!canTx || !to.trim() || !text.trim()} onClick={sendMessage}>
            Send
          </Button>
        </div>
      </Row>

      <h4>Command log</h4>
      {logErr ? (
        <ErrorState onRetry={refresh}>Couldn't load the command log.</ErrorState>
      ) : log.length === 0 ? (
        <EmptyState>No commands yet.</EmptyState>
      ) : (
        <ul className="logs">
          {log.map((c) => (
            <li key={c.id}>
              <Badge>{c.kind}</Badge> <Badge kind={stColor[c.status] || undefined}>{c.status}</Badge>
              <span className="muted"> · {fmt.ago(c.createdAt)}</span>
              {c.result && <span className="muted"> · {c.result}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
