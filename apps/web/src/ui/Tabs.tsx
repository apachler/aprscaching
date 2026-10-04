// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tabs — one tab strip for every surface (ui-ux.md §3): view tabs (the BBS's Inbox · Sent · Bulletins) and
 * closable channel tabs (the packet terminal). A real ARIA tablist: roving focus, the arrow keys, Home and
 * End move between tabs and select them; with `onClose`, Delete closes the focused tab, and a × inside each
 * tab closes it by pointer. The × is not a separate control, since a tablist may hold only tabs.
 *
 * With `panels` (the default), the caller renders the selected panel with `id={tabPanelId(idBase, key)}` and
 * role="tabpanel", and the selected tab points at it; a strip that switches a view it does not wrap passes
 * `panels={false}`.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Hint } from "./Hint.js";

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  /** extra classes on this tab (the terminal colours a channel by its station type) */
  className?: string;
  /** an accessible name when the label is not text alone */
  title?: string;
  /** false keeps a tab without its close mark (the terminal's monitor) */
  closable?: boolean;
}

export const tabPanelId = (idBase: string, key: string) => `${idBase}-panel-${key}`;
const tabId = (idBase: string, key: string) => `${idBase}-tab-${key}`;

export function Tabs<K extends string>(props: {
  /** what the tabs switch between, for assistive technology */
  label: string;
  idBase: string;
  items: TabItem<K>[];
  value: K | null;
  onChange: (key: K) => void;
  onClose?: (key: K) => void;
  /** "view" (default) or "channel": the two looks of tabs.css; or the caller's own class */
  look?: "view" | "channel";
  className?: string;
  panels?: boolean;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement | null>());
  const keys = props.items.map((i) => i.key);
  const move = (to: number) => {
    const k = keys[(to + keys.length) % keys.length];
    if (k === undefined) return;
    props.onChange(k);
    refs.current.get(k)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, key: K) => {
    const i = keys.indexOf(key);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(keys.length - 1);
    else if ((e.key === "Delete" || e.key === "Backspace") && props.onClose && props.items[i]?.closable !== false) {
      props.onClose(key);
    } else return;
    e.preventDefault();
  };
  const selected = props.value ?? keys[0];
  return (
    <div
      className={[props.className, `tabs tabs-${props.look ?? "view"}`].filter(Boolean).join(" ")}
      role="tablist"
      aria-label={props.label}
    >
      {props.items.map((item) => {
        const on = item.key === selected;
        const closable = !!props.onClose && item.closable !== false;
        const tab = (
          <button
            key={item.key}
            ref={(el) => {
              refs.current.set(item.key, el);
            }}
            id={tabId(props.idBase, item.key)}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={on && props.panels !== false ? tabPanelId(props.idBase, item.key) : undefined}
            aria-keyshortcuts={closable ? "Delete" : undefined}
            tabIndex={on ? 0 : -1}
            className={["tab", on ? "on" : "", item.className].filter(Boolean).join(" ")}
            onClick={() => props.onChange(item.key)}
            onKeyDown={(e) => onKey(e, item.key)}
          >
            {item.label}
            {closable && (
              // pointer-only: keyboard users close the focused tab with Delete (aria-keyshortcuts)
              <span
                className="tab-x"
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose?.(item.key);
                }}
              >
                ×
              </span>
            )}
          </button>
        );
        return item.title ? (
          <Hint key={item.key} text={item.title}>
            {tab}
          </Hint>
        ) : (
          tab
        );
      })}
    </div>
  );
}
