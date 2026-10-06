// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { deleteAccount, errorText, exportAccount } from "../api.js";
import { Button, Panel, useConfirm } from "../ui/index.js";

/**
 * The data of an account that holds no callsign: its last call moved to the call's licensee. An email link opens
 * this session, which downloads a copy of the account's data or erases it, and does nothing else.
 */
export function AccountData(props: {
  onSignOut: () => void;
  /** The account is erased: sign out and confirm it (SessionEndedNotice). */
  onErased: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const confirmDialog = useConfirm();

  async function download() {
    setBusy(true);
    setNote("Preparing your export…");
    try {
      const data = await exportAccount("me");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "aprscaching-data.json";
      a.click();
      URL.revokeObjectURL(url);
      setNote("Export downloaded.");
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function erase() {
    if (
      !(await confirmDialog({
        title: "Permanently erase your account?",
        message: "Your finds are anonymised and your account and personal data are deleted. This cannot be undone.",
        confirmLabel: "Erase everything",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    setNote("Erasing…");
    try {
      await deleteAccount("me");
    } catch (e) {
      setNote(errorText(e));
      setBusy(false);
      return;
    }
    props.onErased();
  }

  return (
    <Panel title="Your data" onClose={props.onSignOut}>
      <p className="muted">
        Your account holds no callsign now. Download a copy of its data, or erase it. To use the app again, sign in with
        the callsign you operate now.
      </p>
      <Button variant="primary" className="log-primary" disabled={busy} onClick={download}>
        Download my data
      </Button>
      <div className="row end mt-3">
        <Button variant="danger" disabled={busy} onClick={erase}>
          Erase my account
        </Button>
      </div>
      {note && (
        <p className="muted mt-2" role="status">
          {note}
        </p>
      )}
      <Button variant="quiet" className="mt-3" onClick={props.onSignOut}>
        Sign out
      </Button>
    </Panel>
  );
}
