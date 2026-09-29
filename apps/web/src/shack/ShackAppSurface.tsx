// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Panel, Ico } from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { appById, type ShackApp, type ShackAppId, type ShackAppProps } from "./apps.js";

// One lazy component per app, created on its first launch and reused after.
const loaded = new Map<ShackAppId, LazyExoticComponent<ComponentType<ShackAppProps>>>();
const component = (app: ShackApp) => {
  let c = loaded.get(app.id);
  if (!c) loaded.set(app.id, (c = lazy(app.load)));
  return c;
};

/** The app's Panel chrome, titled from the registry. */
function AppPanel(props: { app: ShackApp; onClose: () => void; children: React.ReactNode }) {
  return (
    <Panel
      title={
        <>
          <Ico e={`${props.app.emoji} `} />
          {props.app.title}
        </>
      }
      onClose={props.onClose}
      wide={props.app.wide}
    >
      {props.children}
    </Panel>
  );
}

/**
 * ShackAppSurface — renders the launched shack app in its OWN surface. Every shack app opens this way
 * (the drawer is a pure launcher). An app's code loads on its first launch, with a skeleton in the
 * app's Panel meanwhile. Apps with their own chrome (terminal, BBS) render bare; the rest are wrapped
 * in a Panel titled from the registry.
 */
export function ShackAppSurface(props: { app: ShackAppId; onClose: () => void }) {
  const { callsign, verified, map } = usePlatform();
  const app = appById(props.app);
  if (!app) return null;
  const App = component(app);
  const body = <App callsign={callsign} verified={verified} map={map} onClose={props.onClose} />;
  const skeleton = (
    <div className="skeleton" role="status" aria-label={`Loading ${app.label}…`}>
      <span />
      <span />
      <span />
    </div>
  );
  // An app with its own chrome shows the skeleton in a registry-titled Panel until its Panel arrives.
  if (app.ownChrome)
    return (
      <Suspense
        fallback={
          <AppPanel app={app} onClose={props.onClose}>
            {skeleton}
          </AppPanel>
        }
      >
        {body}
      </Suspense>
    );
  return (
    <AppPanel app={app} onClose={props.onClose}>
      {app.intro && <p className="muted">{app.intro}</p>}
      <Suspense fallback={skeleton}>{body}</Suspense>
    </AppPanel>
  );
}
