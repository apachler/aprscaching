// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A tool is shown by the callsign its manifest names only when a registry lists it under its key. A self-signed
// manifest can name any callsign, so the install prompt and the installed row show its key's fingerprint instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { bytesToB64, sha256B64, signManifest, type ToolManifest } from "@aprscaching/tools";
import { ToolsPanel } from "../src/tools/ToolsPanel.js";
import { claimTools } from "../src/tools/toolOwner.js";
import { keyFingerprint, toolSigner } from "../src/tools/toolKeys.js";
import { click, render } from "./support/dom.js";

const MANIFEST_URL = "https://tools.example/imposter/tool.json";

async function selfSigned(): Promise<{ body: string; pub: string }> {
  const k = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = bytesToB64(new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)), true);
  const m = {
    name: "imposter",
    title: "Imposter",
    author: "OE8APR",
    version: "1.0.0",
    api: "1.0",
    permissions: ["monitor"],
    entry: "tool.js",
    entrySha256: await sha256B64(new TextEncoder().encode("register({});")),
    pubkey: pub,
  } as unknown as ToolManifest;
  return { body: JSON.stringify(await signManifest(m, k.privateKey)), pub };
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("a tool's signer", () => {
  it("is the listed author for a registry's tool, and the key's fingerprint for any other", () => {
    expect(toolSigner(true, "OE8APR", "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc")).toEqual({ author: "OE8APR" });
    expect(toolSigner(false, "OE8APR", "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc")).toEqual({
      key: "uibF UCjc BnxA e8mR",
    });
  });

  it("is the key's fingerprint in the install prompt of a self-signed tool, never the callsign it names", async () => {
    const { body, pub } = await selfSigned();
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) =>
      String(u) === MANIFEST_URL ? new Response(body) : new Response("{}", { status: 404 }),
    );
    claimTools("N0CALL");
    const view = render(<ToolsPanel callsign="N0CALL" verified={false} />);
    await settle();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Tool manifest URL"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, MANIFEST_URL);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click([...document.querySelectorAll("button")].find((b) => b.textContent === "Install…")!);
    // the manifest's signature is checked before the prompt opens
    let dialog: Element | null = null;
    for (let i = 0; i < 100 && !dialog; i++) {
      await settle();
      dialog = document.querySelector('[role="dialog"][aria-label="Approve tool permissions"]');
    }
    expect(dialog?.textContent).toContain(`signed by key ${keyFingerprint(pub)}`);
    expect(dialog?.textContent).not.toContain("OE8APR");
    view.unmount();
  });
});
