// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { downloadExport } from "../api.js";
import { Button, useToast } from "../ui/index.js";

/**
 * A button that saves one of the read API's file exports (GPX, KML, ADIF). It says so while the file loads, and
 * a toast reports the saved file or what went wrong. `path` may decline with a reason (a view too wide to export).
 */
export function ExportButton(props: {
  label: string;
  filename: string;
  path: () => string | { refuse: string };
  title?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function save() {
    const p = props.path();
    if (typeof p !== "string") {
      toast(p.refuse);
      return;
    }
    setBusy(true);
    try {
      await downloadExport(p, props.filename);
      toast(`Saved ${props.filename}`);
    } catch (e) {
      toast(`Couldn't download: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={() => void save()} disabled={busy} aria-busy={busy || undefined} title={props.title}>
      {busy ? "Downloading…" : props.label}
    </Button>
  );
}
