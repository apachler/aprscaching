// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo } from "react";
import type { PinnedItem } from "../nav.js";
import { useToolCatalog } from "../tools/host.js";
import { toolIcon } from "../tools/toolIcons.js";
import { appById, pinnedTool, type PinId, type ShackAppId } from "./apps.js";

/**
 * The pins as rail items, in the user's order. An app pin draws the app (an operator-only app only for the
 * operator); a tool pin draws the tool while it runs in this page (an installed tool that did not start, or one
 * removed, leaves no dead rail item), with its icon and its title as its name.
 */
export function usePinnedItems(pins: readonly PinId[], sysop: boolean): PinnedItem[] {
  const tools = useToolCatalog();
  return useMemo(() => {
    const out: PinnedItem[] = [];
    for (const pin of pins) {
      const name = pinnedTool(pin);
      if (name == null) {
        const app = appById(pin as ShackAppId);
        if (app && (sysop || !app.sysop))
          out.push({
            key: app.id,
            icon: app.icon,
            label: app.label,
            hint: app.blurb,
            view: { kind: "app", id: app.id },
          });
        continue;
      }
      const t = tools.find((x) => x.name === name);
      if (!t) continue;
      out.push({
        key: pin,
        icon: toolIcon(t.name),
        label: t.title,
        hint: `${t.title}, in Tools`,
        view: { kind: "app", id: "tools", tool: t.name },
      });
    }
    return out;
  }, [pins, sysop, tools]);
}
