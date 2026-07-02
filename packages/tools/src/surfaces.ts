// SPDX-License-Identifier: MIT
/**
 * surfaces.ts — a Tool's *type*: which host surface(s) it plugs into (docs/28). Capabilities say what a
 * tool may DO; surfaces say WHERE its contributions appear. A colouriser targeting `terminal` recolours
 * the packet-terminal monitor; a `panel` targeting `web` renders in the Tools app; a `/command` targeting
 * `bbs` is offered on the BBS command line. This lets the same plugin system serve every surface, not
 * just the packet terminal, and lets a host ask only for the tools relevant to it.
 */
export type Surface =
  | "web"       // the general Tools app / app-wide console (the default home)
  | "terminal"  // the packet terminal (monitor colour, /commands, panels)
  | "bbs"       // the BBS surface
  | "node"      // the NET/ROM node console
  | "map";      // the map (declarative layers/overlays — reserved, see `map` capability)

export const ALL_SURFACES: Surface[] = ["web", "terminal", "bbs", "node", "map"];

export const isSurface = (x: unknown): x is Surface =>
  typeof x === "string" && (ALL_SURFACES as string[]).includes(x);
