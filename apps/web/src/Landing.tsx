// SPDX-License-Identifier: AGPL-3.0-or-later
import { ASSET } from "./brand.js";
import { API_BASE } from "./api.js";

/**
 * Marketing landing shell — MECHANICS ONLY. The hero copy, feature sections, and screenshots are
 * deferred (docs/18) while the platform is in active development; this is the structural gate with
 * the three signed-out CTAs. Register/Login open the existing callsign-led sign-in; Explore drops
 * the visitor into the read-only platform. The footer carries the canonical site-wide links — the
 * Site map is a real crawlable page (/sitemap), not an in-app panel.
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
      <footer className="landing-footer">
        <a href={`${API_BASE}/sitemap`}>Site map</a>
        <a href={`${API_BASE}/support`}>Support</a>
        <a href={`${API_BASE}/source`} rel="noopener">Source (AGPL-3.0)</a>
        <a href={`${API_BASE}/api/v1`}>Read API</a>
        <a href={`${API_BASE}/sitemap.xml`}>sitemap.xml</a>
      </footer>
    </main>
  );
}
