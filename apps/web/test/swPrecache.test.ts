// SPDX-License-Identifier: AGPL-3.0-or-later
// The offline shell leaves Mermaid to the network: a chunk reachable only through the on-demand mermaid import
// is never precached, while a chunk the app also reaches stays in.
import { describe, expect, it } from "vitest";
import { onDemandChunks, type ChunkLinks } from "../vite-sw.js";

const chunk = (fileName: string, o: Partial<ChunkLinks> = {}): ChunkLinks => ({
  fileName,
  isEntry: false,
  facadeModuleId: null,
  imports: [],
  dynamicImports: [],
  ...o,
});

describe("onDemandChunks", () => {
  const chunks = [
    chunk("index.js", { isEntry: true, imports: ["shared.js"], dynamicImports: ["docs.js"] }),
    chunk("docs.js", { imports: ["shared.js"], dynamicImports: ["mermaid.core.js"] }),
    chunk("mermaid.core.js", {
      facadeModuleId: "/repo/node_modules/.pnpm/mermaid@12.0.0/node_modules/mermaid/dist/mermaid.core.mjs",
      imports: ["shared.js", "d3.js"],
      dynamicImports: ["flowDiagram.js"],
    }),
    chunk("flowDiagram.js", { imports: ["d3.js"] }),
    chunk("d3.js"),
    chunk("shared.js"),
  ];

  it("skips the mermaid chunk and what only it reaches", () => {
    expect([...onDemandChunks(chunks)].sort()).toEqual(["d3.js", "flowDiagram.js", "mermaid.core.js"]);
  });

  it("keeps a chunk the app reaches on its own", () => {
    const withD3 = chunks.map((c) => (c.fileName === "docs.js" ? { ...c, imports: [...c.imports, "d3.js"] } : c));
    expect(onDemandChunks(withD3).has("d3.js")).toBe(false);
  });

  it("skips nothing in a bundle without mermaid", () => {
    expect(onDemandChunks(chunks.filter((c) => !c.facadeModuleId)).size).toBe(0);
  });
});
