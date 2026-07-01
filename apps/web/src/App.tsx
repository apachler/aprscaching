import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import "./styles.css";
import { ToastProvider, tourSeen } from "./ui/index.js";
import { useSession } from "./identity/useSession.js";
import { Landing } from "./Landing.js";
import { SignIn } from "./identity/SignIn.js";
import { ASSET } from "./brand.js";

// The signed-in / explore platform owns MapLibre (~800 KB) plus all the map code. Lazy-load it so the
// signed-out marketing landing paints without ever fetching the map bundle (docs/18 landing gate): the
// import() only fires once the user signs in or taps Explore.
const Platform = lazy(() => import("./Platform.js"));

const Splash = () => <div className="splash"><img src={ASSET.wordmark} alt="APRScaching" /></div>;

/**
 * App — the top-level auth/landing gate. It stays deliberately thin (no map imports) so it can decide
 * landing-vs-platform before a single byte of MapLibre is fetched; the platform itself is the lazy
 * `Platform` chunk. `useSession` lives here (single source of truth) and is passed down.
 */
export function App() {
  const session = useSession();
  const [showSignIn, setShowSignIn] = useState(false);
  // landing gate (docs/18): signed-in skips the landing; signed-out sees it until they Explore
  // (per-session intent) or sign in. The platform is the same SPA in read-only when signed out.
  const [explored, setExplored] = useState(() => { try { return sessionStorage.getItem("acs.explore") === "1"; } catch { return false; } });
  const [startTour, setStartTour] = useState(false);
  const active = session.signedIn || explored;

  const onExplore = useCallback(() => {
    try { sessionStorage.setItem("acs.explore", "1"); } catch { /* ignore */ }
    setExplored(true);
    if (!tourSeen()) setStartTour(true);
  }, []);

  // Signing out returns to the landing (clears the per-session explore intent).
  const prevSignedIn = useRef(session.signedIn);
  useEffect(() => {
    if (prevSignedIn.current && !session.signedIn) {
      try { sessionStorage.removeItem("acs.explore"); } catch { /* ignore */ }
      setExplored(false); setStartTour(false);
    }
    prevSignedIn.current = session.signedIn;
  }, [session.signedIn]);

  return (
    <ToastProvider>
      {session.loading ? (
        <Splash />
      ) : !active ? (
        <>
          <Landing onRegister={() => setShowSignIn(true)} onLogin={() => setShowSignIn(true)} onExplore={onExplore} />
          {showSignIn && (
            <SignIn onDone={() => { session.refresh(); setShowSignIn(false); }} onClose={() => setShowSignIn(false)} />
          )}
        </>
      ) : (
        <Suspense fallback={<Splash />}>
          <Platform session={session} startTour={startTour} />
        </Suspense>
      )}
    </ToastProvider>
  );
}
