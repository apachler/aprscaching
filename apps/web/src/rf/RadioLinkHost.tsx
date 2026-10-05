// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's one browser radio link (radioLink.ts) wired to the browser: the real Web Serial / Web Bluetooth /
 * Web Audio links, the gateway forwarders and the field station. `RadioLinkHost` is mounted once at the platform
 * root: it follows the signed-in identity, asks for transmit consent, turns the store's events into toasts and
 * closes the link when the page goes away. Views read the store through `useRadioLink`.
 */
import { useEffect, useSyncExternalStore } from "react";
import { WebSerialKiss, WebBluetoothKiss } from "./kiss.js";
import { WebAudioAfsk, WebSerialMeshtastic } from "./extralinks.js";
import { fieldStation } from "./fieldStation.js";
import { RadioLinkStore, LINK_LABEL, holdRadio, radioBusyText, type RadioState } from "./radioLink.js";
import { ingestPackets, ingestSigned } from "../api.js";
import { useConfirm, useToast } from "../ui/index.js";

const FWD_KEY = "acs.rf.gateway-url"; // the self-host gateway URL; the ingest secret is never stored

function storedGatewayUrl(): string {
  try {
    return localStorage.getItem(FWD_KEY) ?? "";
  } catch {
    return "";
  }
}

export const radioLink = new RadioLinkStore(
  {
    makeLink: (kind, onFrame, onClose) =>
      kind === "serial"
        ? new WebSerialKiss(onFrame, onClose)
        : kind === "ble"
          ? new WebBluetoothKiss(onFrame, onClose)
          : kind === "audio"
            ? new WebAudioAfsk(onFrame, onClose)
            : new WebSerialMeshtastic(onFrame, onClose),
    forward: (packets, s) =>
      s.mode === "signed" && s.callsign.length >= 3
        ? ingestSigned(packets, s.callsign)
        : s.secret
          ? ingestPackets(packets, s.secret, s.gatewayUrl || undefined)
          : null,
    feedLocal: (f) => fieldStation.feed(f),
    saveGatewayUrl: (url) => {
      try {
        localStorage.setItem(FWD_KEY, url);
      } catch {
        /* storage blocked: the URL lasts for this page only */
      }
    },
    connectError: (err) => radioBusyText(err, "bridge"),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
  { gatewayUrl: storedGatewayUrl() },
);

// the packet terminal reads this to name the RF bridge when both reach for one port
radioLink.subscribe(() => holdRadio("bridge", radioLink.getState().link != null));

/** The radio link's state; re-renders on every change. */
export function useRadioLink(): RadioState {
  return useSyncExternalStore(radioLink.subscribe, radioLink.getState);
}

/** Mounted once at the platform root: identity, toasts and page unload for the app-wide radio link. */
export function RadioLinkHost(props: { callsign: string; verified: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  useEffect(() => {
    radioLink.setConsentAsker(({ call, via }) =>
      confirm({
        title: `Allow transmitting from ${call} over ${via} until you close this tab?`,
        message: (
          <>
            <p>
              You are the licensed operator of <span className="mono">{call}</span> and answer for what it sends.
              Receive only keeps listening; the transmit switch in Settings → My radio, or the radio chip in the top
              bar, allows it later. Disconnecting the radio, signing out or a change of callsign ends it.
            </p>
            <p className="muted fine">
              Messages the instance sends for you (APRS-IS, the Mailbox, announcements) follow their own settings.
            </p>
          </>
        ),
        confirmLabel: "Allow",
        cancelLabel: "Receive only",
      }),
    );
    return () => radioLink.setConsentAsker(null);
  }, [confirm]);
  useEffect(() => {
    radioLink.setIdentity(props.callsign, props.verified);
  }, [props.callsign, props.verified]);
  useEffect(
    () =>
      radioLink.onEvent((e) => {
        if (e.kind === "connected") toast(`${LINK_LABEL[e.link]} connected`);
        else if (e.kind === "lost") toast(`Radio disconnected: ${e.message}`);
        else if (e.kind === "connect-failed") toast(`Could not connect: ${e.message}`);
        else if (e.kind === "forward-failed") toast(`Forwarding failed: ${e.message}`);
      }),
    [toast],
  );
  // the app leaving the platform (signing out to the landing page) ends the link with the account
  useEffect(() => () => radioLink.setIdentity("", false), []);
  useEffect(() => {
    // a page kept in the back-forward cache keeps its link; a page that goes away releases the device
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) void radioLink.disconnect();
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);
  return null;
}
