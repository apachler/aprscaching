// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "./styles/index.css";
import { ToastProvider, ConfirmProvider, tourSeen } from "./ui/index.js";
import { useSession } from "./identity/useSession.js";
import { Landing } from "./Landing.js";
import { SignIn } from "./identity/SignIn.js";
import { AccountData } from "./identity/AccountData.js";
import { SessionEndedNotice } from "./identity/SessionEndedNotice.js";
import { ASSET } from "./brand.js";
import { UpdateNotice } from "./shell/UpdateNotice.js";

// The signed-in / explore platform owns MapLibre (~1 MB) plus all the map code. Lazy-load it so the
// signed-out marketing landing paints without ever fetching the map bundle: the
// import() only fires once the user signs in or taps Explore.
const Platform = lazy(() => import("./Platform.js"));

const Splash = () => (
  <div className="splash">
    <img src={ASSET.wordmark} alt="APRScaching" />
  </div>
);

/**
 * App — the top-level auth/landing gate. It stays deliberately thin (no map imports) so it can decide
 * landing-vs-platform before a single byte of MapLibre is fetched; the platform itself is the lazy
 * `Platform` chunk. `useSession` lives here (single source of truth) and is passed down.
 */
/**
 * The landing as HTML in index.html (#landing-pre, vite-prerender.ts) shows while the app loads. It is gone when
 * the head script found the landing would not open, or once the app has rendered its own.
 */
const prerenderShown = () =>
  typeof document !== "undefined" &&
  !!document.getElementById("landing-pre") &&
  document.documentElement.dataset.prerender !== "off";

export function App() {
  const session = useSession();
  const [prerendered] = useState(prerenderShown);
  // the sign-in panel, opened on its callsign step or on "Get or erase my data"
  const [showSignIn, setShowSignIn] = useState<false | "signin" | "data">(false);
  // landing gate: signed-in skips the landing; signed-out sees it until they Explore
  // (per-session intent) or sign in. The platform is the same SPA in read-only when signed out.
  const [explored, setExplored] = useState(() => {
    try {
      // a deep link into the platform (?view=…, ?v=…) is a visit to it, signed in or not
      const q = new URLSearchParams(location.search);
      return sessionStorage.getItem("acs.explore") === "1" || q.has("view") || q.has("v");
    } catch {
      return false;
    }
  });
  const [startTour, setStartTour] = useState(false);
  // a data-only session stays on the landing, where its panel offers the export and the erasure
  const active = session.signedIn || (explored && !session.accountData);

  const onExplore = useCallback(() => {
    try {
      sessionStorage.setItem("acs.explore", "1");
    } catch {
      /* ignore */
    }
    setExplored(true);
    if (!tourSeen()) setStartTour(true);
  }, []);

  /** Back to the landing: the per-session explore intent is cleared. */
  const toLanding = useCallback(() => {
    try {
      sessionStorage.removeItem("acs.explore");
    } catch {
      /* ignore */
    }
    setExplored(false);
    setStartTour(false);
  }, []);
  // Signing out returns to the landing.
  const prevSignedIn = useRef(session.signedIn);
  useEffect(() => {
    if (prevSignedIn.current && !session.signedIn) toLanding();
    prevSignedIn.current = session.signedIn;
  }, [session.signedIn, toLanding]);

  // the app's own landing or platform is up: the prerendered copy goes (the platform also hides it by CSS)
  const ready = !session.loading;
  useEffect(() => {
    if (ready) document.getElementById("landing-pre")?.remove();
  }, [ready]);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <UpdateNotice />
        {session.loading ? (
          prerendered ? null : (
            <Splash />
          )
        ) : !active ? (
          <>
            <Landing onSignIn={() => setShowSignIn("signin")} onExplore={onExplore} resume={prerendered} />
            {session.accountData && !showSignIn && (
              <AccountData onSignOut={() => void session.signOut()} onErased={() => void session.signOutErased()} />
            )}
            {showSignIn && (
              <SignIn
                start={showSignIn}
                onDone={() => {
                  session.refresh();
                  setShowSignIn(false);
                }}
                onClose={() => setShowSignIn(false)}
                onBrowse={() => {
                  setShowSignIn(false);
                  onExplore();
                }}
              />
            )}
          </>
        ) : (
          <Suspense fallback={<Splash />}>
            <Platform session={session} startTour={startTour} />
          </Suspense>
        )}
        {/* signed out by a suspension, a released callsign or an erasure: say why, wherever the person lands */}
        {!session.loading && session.ended && !showSignIn && (
          <SessionEndedNotice
            ended={session.ended}
            onClose={() => void session.dismissEnded()}
            onSignIn={() => {
              void session.dismissEnded();
              toLanding();
              setShowSignIn("signin");
            }}
            onData={() => {
              void session.dismissEnded();
              toLanding();
              setShowSignIn("data");
            }}
          />
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}
