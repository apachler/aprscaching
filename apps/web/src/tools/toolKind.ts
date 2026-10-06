// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The groups a registry's tools are listed in, the tool catalogue's own: decoders, monitor and station tools,
 * responders, transmit tools and utilities. A registry entry that names its `category` is listed under it; any
 * other is placed by the permissions its signed manifest asks for, the gated ones first, since those matter most
 * when choosing a tool.
 */
import type { Capability } from "@aprscaching/tools";

const TOOL_KINDS = ["Transmit tools", "Decoders", "Monitor and station tools", "Responders", "Utilities"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number] | (string & {});

/** The group of a tool that asks for these permissions. */
export function kindOfPermissions(p: readonly Capability[]): ToolKind {
  if (p.includes("tx") || p.includes("beacon")) return "Transmit tools";
  if (p.includes("decoder")) return "Decoders";
  if (p.includes("monitor")) return "Monitor and station tools";
  if (p.includes("event")) return "Responders";
  return "Utilities";
}

/**
 * Group listings in the catalogue's order, then any group a registry names itself, then the ones whose group is
 * not known yet (`rest`, under `restLabel`). Empty groups are left out.
 */
export function groupByKind<T>(
  items: readonly T[],
  kindOf: (item: T) => ToolKind | null,
  restLabel = "More tools",
): { kind: string; items: T[] }[] {
  const by = new Map<string, T[]>();
  const rest: T[] = [];
  for (const it of items) {
    const k = kindOf(it);
    if (k == null) rest.push(it);
    else by.set(k, [...(by.get(k) ?? []), it]);
  }
  const named = [...by.keys()].filter((k) => !(TOOL_KINDS as readonly string[]).includes(k)).sort();
  const out = [...TOOL_KINDS, ...named].filter((k) => by.has(k)).map((k) => ({ kind: k, items: by.get(k)! }));
  return rest.length ? [...out, { kind: restLabel, items: rest }] : out;
}
