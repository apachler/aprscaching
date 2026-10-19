// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The design benches (`?demo=app|ui|packet|bbs`) sign the page in as a fixture account with a verified callsign
// and write to the visitor's own storage, so a production page a person opens ignores `?demo=` and loads the app;
// a development build and the driven visual harness still get the bench.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installAppFixtures = vi.fn();
const render = vi.fn();

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("../src/App.js", () => ({ App: () => null }));
vi.mock("../src/shell/serviceWorker.js", () => ({ registerServiceWorker: async () => {} }));
vi.mock("../src/demo/fixtures.js", () => ({ installAppFixtures }));
vi.mock("../src/demo/UiKit.js", () => ({ UiKit: () => null }));
vi.mock("../src/demo/DemoHarness.js", () => ({ DemoHarness: () => null }));

function setWebdriver(on: boolean): void {
  Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => on });
}

async function boot(search: string): Promise<string> {
  document.body.innerHTML = '<div id="root"></div>';
  history.replaceState(null, "", `/${search}`);
  vi.resetModules();
  await import("../src/main.js");
  await vi.waitFor(() => expect(render).toHaveBeenCalled(), { timeout: 30_000 });
  const el = render.mock.calls[0]![0] as { props: { children: { props: { children: { type: unknown } } } } };
  const inner = el.props.children.props.children;
  const type = inner.type as { name?: string } | string;
  return typeof type === "string" ? type : (type.name ?? "");
}

// the first boot transforms main.tsx and its imports, which takes a while under the full suite
describe("the ?demo= benches", { timeout: 60_000 }, () => {
  beforeEach(() => {
    installAppFixtures.mockClear();
    render.mockClear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a production page a person opens ignores ?demo=app and loads the app on the real gateway", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    setWebdriver(false);
    expect(await boot("?demo=app")).toBe("App");
    expect(installAppFixtures).not.toHaveBeenCalled();
  });

  it("a production page a person opens ignores ?demo=bbs and ?demo=ui", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    setWebdriver(false);
    expect(await boot("?demo=bbs")).toBe("App");
    render.mockClear();
    expect(await boot("?demo=ui")).toBe("App");
  });

  it("the driven visual harness still gets the fixture app", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("PROD", true);
    setWebdriver(true);
    expect(await boot("?demo=app")).toBe("App");
    expect(installAppFixtures).toHaveBeenCalledWith("user", false);
  });

  it("a development build gets the bench", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("PROD", false);
    setWebdriver(false);
    expect(await boot("?demo=ui")).toBe("UiKit");
  });
});
