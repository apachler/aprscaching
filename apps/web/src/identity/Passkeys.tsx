// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { errorText, listPasskeys, registerPasskey, removePasskey, type Passkey } from "../api.js";
import { Advanced, Button, useConfirm, useLoad, useToast } from "../ui/index.js";
import { useFmt } from "../format.js";
import { passkeyErrorText, passkeyProblem, PASSKEY_PROBLEM_TEXT } from "./passkeySupport.js";

/** How a passkey's device connects, from its WebAuthn transports, in words. */
function kind(p: Passkey): string {
  const t = p.transports;
  if (t.includes("internal")) return "Built into a device";
  if (t.includes("hybrid")) return "On a phone, used by QR code";
  if (t.some((x) => x === "usb" || x === "nfc" || x === "ble")) return "Security key";
  return "Passkey";
}

/**
 * Settings → Account → passkeys: one per device. A ham signed in on a new device (with the email link, the
 * sysop's link, or another device's passkey by QR code) adds this device's own passkey here, and removes a lost
 * device's. The passkeys are bound to the account's primary call.
 */
export function Passkeys(props: { onChanged?: () => void } = {}) {
  const fmt = useFmt();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, reload, error } = useLoad(() => listPasskeys(), []);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const problem = passkeyProblem();

  async function add() {
    if (!data) return;
    setBusy(true);
    setMsg(null);
    try {
      await registerPasskey(data.callsign);
      toast("Passkey added: this device signs you in with it");
      reload();
      props.onChanged?.();
    } catch (e) {
      setMsg({ text: passkeyErrorText(e, (x) => errorText(x).replace(/^.*?: /, "")), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Passkey) {
    const ok = await confirm({
      title: "Remove this passkey?",
      message: `${kind(p)}, added ${fmt.date(p.createdAt)}. The device that holds it can no longer sign you in.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      await removePasskey(p.id);
      toast("Passkey removed");
      reload();
      props.onChanged?.();
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^.*?: /, ""), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const count = data?.passkeys.length ?? 0;
  return (
    <div className="mt-3">
      <div className="setrow">
        <div className="setrow-l">
          <div>Passkeys</div>
          <div className="muted fine">
            {error
              ? "Could not load your passkeys."
              : data
                ? `${count === 1 ? "1 passkey" : `${count} passkeys`}, bound to ${data.callsign}`
                : "Loading…"}
          </div>
        </div>
        <div className="setrow-c">
          <Button disabled={busy || !data || !!problem} onClick={add}>
            Add a passkey on this device
          </Button>
        </div>
      </div>
      {problem && <p className="muted fine">{PASSKEY_PROBLEM_TEXT[problem]}</p>}
      {data && count > 0 && (
        <Advanced label="Your passkeys">
          <ul className="cs-list">
            {data.passkeys.map((p) => (
              <li key={p.id} className="setrow">
                <div className="setrow-l">
                  <span>{kind(p)}</span>
                  <span className="muted fine"> · added {fmt.date(p.createdAt)}</span>
                </div>
                <div className="setrow-c">
                  <Button
                    variant="quiet"
                    disabled={busy || (count === 1 && !data.hasEmail)}
                    hint={
                      count === 1 && !data.hasEmail
                        ? data.emailPending
                          ? "Your only way to sign in: confirm your email address (open the link we sent) or add another passkey first"
                          : "Your only way to sign in: add an email address or another passkey first"
                        : undefined
                    }
                    onClick={() => remove(p)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="muted fine">
            A passkey stays on the device that made it. Apple and Google sync theirs between your own devices; on any
            other device, sign in with your email link or another device&apos;s passkey by QR code, then add one here.
          </p>
        </Advanced>
      )}
      {msg && <p className={`mt-2 ${msg.kind === "error" ? "error" : "muted"}`}>{msg.text}</p>}
    </div>
  );
}
