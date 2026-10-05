// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Button, Icon, useChoice, usePrompt, useToast } from "../ui/index.js";
import { errorText } from "../api.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { fileReport, removeContent, restoreCache } from "./api.js";
import { REPORT_CATEGORIES, kindName, menuChoices, type ContentKind, type ReportCategory } from "./logic.js";

/** The words a report or a removal names the item by: a short label such as a code or a call. */
interface Target {
  kind: ContentKind;
  id: string | number;
  label: string;
}

/**
 * The More (⋯) menu on a piece of content: Report for any viewer, and for the sysop Remove (or Restore, on a
 * removed cache) behind a reason dialog. The reporter gets a toast; the reported person is never told who
 * reported. The sysop entries only show for the operator, and the server refuses them to anyone else.
 */
export function ContentMenu(props: {
  target: Target;
  /** The viewer's own content: they edit or delete it themselves, so no Report. */
  own?: boolean;
  /** A cache the sysop already removed. */
  removed?: boolean;
  onRemoved?: () => void;
  onRestored?: () => void;
}) {
  const { sysop } = usePlatform();
  const choose = useChoice();
  const prompt = usePrompt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const t = props.target;
  const choices = menuChoices({ sysop: !!sysop, removed: props.removed, own: props.own });
  if (choices.length === 0) return null;

  const run = async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      after?.();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const report = async () => {
    const a = await prompt({
      title: `Report this ${kindName(t.kind)}`,
      message: (
        <>
          The sysop of this instance reads every report. <span className="mono">{t.label}</span> is not told who
          reported it.
        </>
      ),
      select: { label: "What is wrong", options: REPORT_CATEGORIES },
      textRequiredFor: ["other"],
      label: "Details (optional for the first four)",
      maxLength: 1000,
      confirmLabel: "Send report",
    });
    if (!a) return;
    await run(
      () => fileReport(t.kind, t.id, a.choice as ReportCategory, a.text),
      "Report sent to the sysop. Thank you.",
    );
  };
  const remove = async () => {
    const a = await prompt({
      title: `Remove this ${kindName(t.kind)}?`,
      message:
        t.kind === "cache" ? (
          <>
            <span className="mono">{t.label}</span> is hidden from everyone but its owner, and peers drop their copy.
            You can restore it here later.
          </>
        ) : t.kind === "profile" ? (
          <>
            The name, bio, avatar and links of <span className="mono">{t.label}</span> are cleared. The account stays.
          </>
        ) : (
          <>
            <span className="mono">{t.label}</span> is deleted for good.
          </>
        ),
      label: "Reason (the owner is told)",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!a) return;
    await run(() => removeContent(t.kind, t.id, a.text), `${t.label} removed`, props.onRemoved);
  };
  const restore = async () => {
    const a = await prompt({
      title: "Restore this cache?",
      message: "It comes back disabled; its owner enables it again. Peers mirror it again.",
      label: "Reason",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Restore",
    });
    if (!a) return;
    await run(() => restoreCache(Number(t.id), a.text), `${t.label} restored`, props.onRestored);
  };
  const act = { report, remove, restore };

  const open = async () => {
    if (choices.length === 1) return act[choices[0]!.value]();
    const pick = await choose({
      title: t.label,
      message: `What do you want to do with this ${kindName(t.kind)}?`,
      choices: choices.map((c, i) => ({ ...c, primary: i === 0 && !c.danger })),
    });
    if (pick === "report" || pick === "remove" || pick === "restore") await act[pick]();
  };

  return (
    <Button
      variant="icon-subtle"
      className="content-menu"
      aria-label={`More actions for ${t.label}`}
      aria-haspopup="dialog"
      aria-busy={busy}
      disabled={busy}
      onClick={() => void open()}
    >
      <Icon name="more" size={16} />
    </Button>
  );
}
