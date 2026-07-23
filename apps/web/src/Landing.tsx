// SPDX-License-Identifier: AGPL-3.0-or-later
import { ASSET } from "./brand.js";
import { API_BASE } from "./api.js";

/**
 * Marketing landing — the signed-out front door. The hero opens with the product's thesis: a live
 * APRS frame proving a find on the air, decoding into its Tier-A stamp (the packet uses our real
 * APZACG tocall and a qAR corroboration line). Below it: the three-step find flow, the A/B/C trust
 * tiers, the shack capability grid, the run-anywhere topologies, and the free-and-open band.
 * Register/Login open the callsign-led sign-in; Explore drops the visitor into the read-only
 * platform. The footer carries the canonical site-wide links (the Site map is the crawlable page).
 */
export function Landing(props: { onRegister: () => void; onLogin: () => void; onExplore: () => void }) {
  return (
    <main className="landing">
      <div className="landing-hero">
        <nav className="landing-nav" aria-label="Landing">
          <img className="landing-nav-logo" src={ASSET.wordmark} alt="APRScaching" />
          <span className="landing-nav-links">
            <a href="#how">How it works</a>
            <a href="#tiers">Trust</a>
            <a href="#shack">Shack</a>
            <a href="#selfhost">Self-host</a>
          </span>
          <button className="primary" onClick={props.onRegister}>
            Register
          </button>
        </nav>
        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">Amateur radio · APRS · Geocaching</p>
            <h1 className="landing-slogan">
              Geocaching, <em>on the air.</em>
            </h1>
            <p className="landing-sub">
              Hide a cache. Hunt it down. Key the find over APRS — and let the radio network itself prove you were
              really there. No app store, no subscription, no tracking: ham radio, a map, and cryptographic honesty.
            </p>
            <div className="landing-cta">
              <button className="primary" onClick={props.onRegister}>
                Register with your callsign
              </button>
              <button onClick={props.onExplore}>Explore the live map</button>
              <button className="landing-ghost" onClick={props.onLogin}>
                Log in
              </button>
            </div>
          </div>
          <div className="landing-term" aria-label="A find verified on the air">
            <div className="landing-term-bar">
              <span className="landing-term-rx" aria-hidden="true"></span> RF · 144.800 MHz · RX
            </div>
            <div className="landing-term-body">
              <div className="landing-frame f1">
                <span className="dim">1042Z</span> OE8APR-7&gt;APZACG,WIDE1-1,qAR,OE8XBM-10:
              </div>
              <div className="landing-frame f2">&gt;Found AC-1042 via aprscaching.net</div>
              <div className="landing-frame f3 dim">corroborated: qAR + OE8XBM-10 · track plausible</div>
              <span className="landing-stamp">✓ TIER A · VERIFIED BY RADIO</span>
            </div>
          </div>
        </div>
      </div>

      <section className="landing-section" id="how">
        <p className="landing-eyebrow">How a find works</p>
        <h2>Three steps, and the network is the referee</h2>
        <ol className="landing-steps">
          <li>
            <h3>Hide</h3>
            <p>
              Place a container — or make a station, an event, even <em>yourself</em> the cache. Coordinates, a hint,
              and a find code: <code>AC-1042</code>.
            </p>
          </li>
          <li>
            <h3>Hunt</h3>
            <p>
              Navigate by live map, bearing arrow, or 10-character Maidenhead. Off-grid works: the map, the caches, and
              your radio need no internet.
            </p>
          </li>
          <li>
            <h3>Key the find</h3>
            <p>
              Transmit the find over APRS from the site — handheld, tracker, or the in-app logger. Independent IGates
              hear you, and the find earns its trust tier.
            </p>
          </li>
        </ol>
      </section>

      <section className="landing-section" id="tiers">
        <p className="landing-eyebrow">The trust model</p>
        <h2>Every find says how hard it was to fake</h2>
        <p className="landing-lede">
          Transport never equals trust. A find's tier comes from corroboration — who independently heard you, not which
          wire delivered the packet.
        </p>
        <div className="landing-tiers">
          <div className="landing-tier tier-a">
            <span className="landing-tier-badge">TIER A</span>
            <h3>Verified by radio</h3>
            <p>
              Your RF transmission, heard by an independent receiver near the cache, with a plausible track. The gold
              standard.
            </p>
          </div>
          <div className="landing-tier tier-b">
            <span className="landing-tier-badge">TIER B</span>
            <h3>Verified by presence</h3>
            <p>The in-app logger confirms your device's own position matches the cache. No radio required to play.</p>
          </div>
          <div className="landing-tier tier-c">
            <span className="landing-tier-badge">TIER C</span>
            <h3>Logged</h3>
            <p>A bare internet beacon. Counted and shown — and honestly labelled as unverified.</p>
          </div>
        </div>
      </section>

      <section className="landing-section" id="shack">
        <p className="landing-eyebrow">More than a game</p>
        <h2>A whole ham-radio Shack underneath</h2>
        <p className="landing-lede">The platform the game runs on is a serious packet-radio station in your browser.</p>
        <div className="landing-features">
          <div className="landing-feature">
            <span className="landing-glyph">MAP</span>
            <h3>Live map</h3>
            <p>
              Stations, tracks, weather, telemetry graphs, POTA/SOTA spots, and every cache — with offline basemaps for
              the field.
            </p>
          </div>
          <div className="landing-feature">
            <span className="landing-glyph">TERM</span>
            <h3>Packet terminal &amp; BBS</h3>
            <p>
              Connected-mode AX.25 terminal, a threaded BBS with real FBB forwarding (compressed included), and a
              NET/ROM node with INP3 routing.
            </p>
          </div>
          <div className="landing-feature">
            <span className="landing-glyph">RF</span>
            <h3>Your radio, your way</h3>
            <p>
              KISS TNC, AGWPE, Web Serial, Bluetooth KISS, Meshtastic, even soundcard AFSK — the RF side always runs on{" "}
              <em>your</em> equipment.
            </p>
          </div>
          <div className="landing-feature">
            <span className="landing-glyph">WX</span>
            <h3>Weather &amp; telemetry</h3>
            <p>Personal weather stations, CWOP, WX beacons, and sensor history charts.</p>
          </div>
          <div className="landing-feature">
            <span className="landing-glyph">FED</span>
            <h3>A federated network</h3>
            <p>
              Instances exchange signed finds and corroborate each other — over HTTPS, or over the air when the internet
              is gone.
            </p>
          </div>
          <div className="landing-feature">
            <span className="landing-glyph">EXT</span>
            <h3>Tools &amp; plugins</h3>
            <p>A signed plugin system: decoders, macros, panels — extend the Shack without trusting blindly.</p>
          </div>
        </div>
        <div className="landing-shots">
          <figure>
            <img src="/shots/shack-terminal.webp" alt="Packet terminal connected to a BBS over AX.25" loading="lazy" />
            <figcaption>The packet terminal, connected</figcaption>
          </figure>
          <figure>
            <img src="/shots/shack-bbs.webp" alt="Threaded BBS inbox with a message thread open" loading="lazy" />
            <figcaption>Threaded BBS mail &amp; bulletins</figcaption>
          </figure>
          <figure>
            <img
              src="/shots/shack-decoder.webp"
              alt="Packet decoder showing a parsed APRS position frame"
              loading="lazy"
            />
            <figcaption>Decode any frame, field by field</figcaption>
          </figure>
        </div>
      </section>

      <section className="landing-section" id="selfhost">
        <p className="landing-eyebrow">Run it anywhere</p>
        <h2>From a double-click to a global edge</h2>
        <div className="landing-hosts">
          <div className="landing-host">
            <strong>Desktop</strong>
            <span>one single binary</span>
          </div>
          <div className="landing-host">
            <strong>Raspberry Pi</strong>
            <span>at home, behind a tunnel</span>
          </div>
          <div className="landing-host">
            <strong>Any VM</strong>
            <span>Docker, batteries included</span>
          </div>
          <div className="landing-host">
            <strong>Cloudflare</strong>
            <span>serverless edge core</span>
          </div>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-band">
          <div>
            <h2>Free in full. Open in full.</h2>
            <p>
              AGPL-3.0 — every instance links its running source. The read API is free. Donations buy recognition, never
              features. Built by OE8APR from open specifications.
            </p>
          </div>
          <button className="primary" onClick={props.onRegister}>
            Start caching →
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <a href={`${API_BASE}/sitemap`}>Site map</a>
        <a href={`${API_BASE}/support`}>Support</a>
        <a href={`${API_BASE}/source`} rel="noopener">
          Source (AGPL-3.0)
        </a>
        <a href={`${API_BASE}/api/v1`}>Read API</a>
        <a href={`${API_BASE}/imprint`}>Imprint</a>
        <a href={`${API_BASE}/privacy`}>Privacy</a>
        <a href={`${API_BASE}/sitemap.xml`}>sitemap.xml</a>
        <p className="landing-fineprint">
          APRS® is a registered trademark of Bob Bruninga, WB4APR. Meshtastic® is a registered trademark of Meshtastic
          LLC. Not affiliated with the APRS Foundation, Groundspeak, Inc. (Geocaching HQ), Meshtastic LLC, POTA, SOTA,
          or the TAK Product Center.
        </p>
      </footer>
    </main>
  );
}
