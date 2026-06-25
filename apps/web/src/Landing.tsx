import { ASSET } from "./brand.js";

/**
 * Marketing landing shell — MECHANICS ONLY. The hero copy, feature sections, and screenshots are
 * deferred (docs/18) while the platform is in active development; this is the structural gate with
 * the three signed-out CTAs. Register/Login open the existing callsign-led sign-in; Explore drops
 * the visitor into the read-only platform.
 */
export function Landing(props: { onRegister: () => void; onLogin: () => void; onExplore: () => void }) {
  return (
    <main className="landing">
      <div className="landing-inner">
        <img className="landing-logo" src={ASSET.wordmark} alt="APRScaching" />
        {/* HERO slogan set; feature/how-it-works/screenshot sections are deferred — see docs/18 */}
        <p className="landing-slogan">Geocaching, on the air.</p>
        <div className="landing-cta">
          <button className="primary" onClick={props.onRegister}>Register</button>
          <button onClick={props.onLogin}>Log in</button>
          <button className="landing-explore" onClick={props.onExplore}>Explore the map →</button>
        </div>
        <p className="landing-note">A full project overview is coming soon.</p>
      </div>
    </main>
  );
}
