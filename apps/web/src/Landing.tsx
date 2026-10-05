// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ASSET, MANUAL_URL } from "./brand.js";
import { API_BASE } from "./api.js";
import { Button, Icon, ManualLink, TierBadge, type IconName } from "./ui/index.js";
import { APRS_CREDIT, APRS_MARK, APRS_NOT_AFFILIATED, OTHER_MARKS, OTHERS_NOT_AFFILIATED } from "./credits.js";

/**
 * The landing page — "Live on the air". The hero keeps the brand treatment in every theme and opens with the
 * product's thesis: an APRS frame heard on the air, decoding into its Radio-verified stamp. Below it the page
 * varies its rhythm: the instance's own numbers (from the read API, never invented), a full-width band of the
 * live map, the three steps beside a phone, the trust tiers as a progression, the Shack beside a desktop, and
 * short closing bands. One primary action (sign in with your callsign); Explore opens the read-only map.
 * Images are made from the real app by apps/web/test/visual/landing-assets.mjs.
 */
export function Landing(props: {
  onSignIn: () => void;
  onExplore: () => void;
  /** Taking over from the prerendered copy: the terminal card's sequence carries on where that copy is. */
  resume?: boolean;
}) {
  // how far the page has come since it was opened, as a negative delay for the sequence's CSS animations
  const [skew] = useState(() => (props.resume ? `${-Math.round(performance.now())}ms` : "0ms"));
  return (
    <main className="landing" style={{ "--landing-skew": skew } as CSSProperties}>
      <Hero onSignIn={props.onSignIn} onExplore={props.onExplore} />
      <MapBand onExplore={props.onExplore} />
      <Steps />
      <Trust />
      <Shack />
      <Privacy />
      <RunAnywhere />
      <section className="landing-section landing-close">
        <h2>Free in full. Open in full.</h2>
        <p>
          AGPL-3.0, and every instance links the code it runs. The read API is free. Donations buy recognition, never
          features.
        </p>
        <Button variant="primary" onClick={props.onSignIn}>
          Sign in with your callsign
        </Button>
      </section>
      <footer className="landing-footer">
        <a href={`${API_BASE}/sitemap`}>Site map</a>
        <a href={`${API_BASE}/support`}>Support</a>
        <a href={MANUAL_URL} target="_blank" rel="noopener">
          Manual
        </a>
        <a href={`${API_BASE}/source`} rel="noopener">
          Source (AGPL-3.0)
        </a>
        <a href={`${API_BASE}/api/v1`}>Read API</a>
        <a href={`${API_BASE}/imprint`}>Imprint</a>
        <a href={`${API_BASE}/privacy`}>Privacy</a>
        <a href={`${API_BASE}/sitemap.xml`}>sitemap.xml</a>
        <p className="landing-fineprint">
          {APRS_CREDIT} {APRS_MARK} {APRS_NOT_AFFILIATED} {OTHER_MARKS} {OTHERS_NOT_AFFILIATED}
        </p>
      </footer>
    </main>
  );
}

/** An image the asset script makes at two or three widths, as AVIF with a WebP fallback. */
function Shot(props: {
  name: string;
  widths: number[];
  ratio: [number, number];
  sizes: string;
  alt: string;
  eager?: boolean;
  className?: string;
}) {
  const set = (ext: string) => props.widths.map((w) => `/landing/${props.name}-${w}.${ext} ${w}w`).join(", ");
  const largest = props.widths[props.widths.length - 1];
  return (
    <picture className={props.className}>
      <source type="image/avif" srcSet={set("avif")} sizes={props.sizes} />
      <source type="image/webp" srcSet={set("webp")} sizes={props.sizes} />
      <img
        src={`/landing/${props.name}-${largest}.webp`}
        alt={props.alt}
        width={props.ratio[0]}
        height={props.ratio[1]}
        loading={props.eager ? "eager" : "lazy"}
        decoding="async"
        {...(props.eager ? { fetchPriority: "high" as const } : {})}
      />
    </picture>
  );
}

function Hero(props: { onSignIn: () => void; onExplore: () => void }) {
  return (
    <header className="landing-hero">
      <Shot
        name="hero"
        widths={[960, 1600, 2560]}
        ratio={[3840, 2160]}
        sizes="100vw"
        alt=""
        eager
        className="landing-hero-photo"
      />
      <nav className="landing-nav" aria-label="Landing">
        <img className="landing-nav-logo" src={ASSET.wordmark} alt="APRScaching" width={160} height={34} />
        <span className="landing-nav-links">
          <a href="#map">The map</a>
          <a href="#how">How it works</a>
          <a href="#trust">Trust</a>
          <a href="#shack">Shack</a>
          <a href="#privacy">Privacy</a>
        </span>
        <Button variant="primary" onClick={props.onSignIn}>
          Sign in
        </Button>
      </nav>
      <div className="landing-hero-grid">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">Amateur radio · APRS · Geocaching</p>
          <h1 className="landing-slogan">
            Geocaching, <em>on the air.</em>
          </h1>
          <p className="landing-sub">
            Hide a cache, hunt it down, and key the find over APRS. The radio network itself proves you were there.
          </p>
          <div className="landing-cta">
            <Button variant="primary" onClick={props.onSignIn}>
              Sign in with your callsign
            </Button>
            <Button onClick={props.onExplore}>Explore the live map</Button>
          </div>
        </div>
        <Terminal />
      </div>
      <LiveStats />
    </header>
  );
}

/** One find, heard on the air: the frame arrives line by line, then its stamp. */
function Terminal() {
  return (
    <figure className="landing-term" aria-label="A find heard on the air and verified">
      <div className="landing-term-bar" aria-hidden="true">
        <span className="landing-term-rx" /> RF · 144.800 MHz · RX
      </div>
      <div className="landing-term-body">
        <p className="landing-frame f1">
          <span className="dim">10:42Z</span> OE8APR-7&gt;APZACG,WIDE1-1:
        </p>
        <p className="landing-frame f2">:OE8APR-15:FOUND AC-1042</p>
        <p className="landing-frame f3 dim">heard direct by OE8XBM-10, the instance's own receiver</p>
        <p className="landing-frame f4 dim">track plausible · 18 m from the cache</p>
        <span className="landing-stamp">
          <Icon name="check" size={14} /> Radio-verified · Tier A
        </span>
      </div>
    </figure>
  );
}

interface Stats {
  caches: number;
  findsOnAirThisWeek: number;
  stationsHeardLastHour: number;
}

/** The instance's own numbers from the read API; a skeleton while they load, nothing if they cannot. */
function LiveStats() {
  const [stats, setStats] = useState<Stats | null | "failed">(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch(`${API_BASE}/api/v1/stats`, { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Stats>) : Promise.reject(new Error(String(r.status)))))
      .then(setStats)
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setStats("failed");
      });
    return () => ac.abort();
  }, []);
  if (stats === "failed") return null;
  const n = (v: number) => new Intl.NumberFormat("en").format(v);
  const items: [string, ReactNode][] = stats
    ? [
        ["caches hidden here", n(stats.caches)],
        ["finds heard on the air this week", n(stats.findsOnAirThisWeek)],
        ["stations heard in the last hour", n(stats.stationsHeardLastHour)],
      ]
    : [
        ["caches hidden here", null],
        ["finds heard on the air this week", null],
        ["stations heard in the last hour", null],
      ];
  return (
    <dl className="landing-stats" aria-busy={stats === null}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? <span className="landing-skel" aria-hidden="true" />}</dd>
        </div>
      ))}
    </dl>
  );
}

function MapBand(props: { onExplore: () => void }) {
  return (
    <section className="landing-band-map" id="map" aria-labelledby="map-h">
      <div className="landing-map-frame">
        <Shot
          name="map-band"
          widths={[800, 1600]}
          ratio={[1600, 620]}
          sizes="100vw"
          alt="The live map around Graz: caches of several types over the street map"
        />
        <span className="landing-callout c1" aria-hidden="true">
          <TierBadge tier="A" /> Schlossberg clock tower
        </span>
        <span className="landing-callout c2" aria-hidden="true">
          <TierBadge tier="B" /> Morse in the Stadtpark
        </span>
      </div>
      <div className="landing-band-copy">
        <h2 id="map-h">One live map</h2>
        <p>
          Caches, the stations around you, and how every find was confirmed. Off-grid packs keep it working without
          signal.
        </p>
        <Button onClick={props.onExplore}>Explore the live map</Button>
        <p className="landing-attrib">Map © OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors</p>
      </div>
    </section>
  );
}

function Steps() {
  return (
    <section className="landing-section landing-split" id="how" aria-labelledby="how-h">
      <div>
        <p className="landing-eyebrow">How a find works</p>
        <h2 id="how-h">Three steps, and the network is the referee</h2>
        <ol className="landing-steps">
          <li>
            <span>
              <strong>Hide</strong> a container, or make a station or yourself the cache.
            </span>
          </li>
          <li>
            <span>
              <strong>Hunt</strong> by map, bearing or a 10-character locator, even without internet.
            </span>
          </li>
          <li>
            <span>
              <strong>Key the find</strong> over APRS from the spot, or log it in the app.
            </span>
          </li>
        </ol>
        <ManualLink className="landing-more" page="play/index">
          The caching guide
        </ManualLink>
      </div>
      <div className="landing-phone">
        <Shot
          name="phone"
          widths={[390, 780]}
          ratio={[780, 1688]}
          sizes="(min-width: 880px) 300px, 70vw"
          alt="A cache open on a phone: its difficulty, rating and coordinates"
        />
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section className="landing-section" id="trust" aria-labelledby="trust-h">
      <p className="landing-eyebrow">The trust model</p>
      <h2 id="trust-h">Every find says how it was confirmed</h2>
      <ol className="landing-tiers">
        <li>
          <TierBadge tier="C" />
          <p>On record. Nothing independent placed the finder at the cache.</p>
        </li>
        <li>
          <TierBadge tier="B" />
          <p>The finder's own device was at the cache when the find was logged.</p>
        </li>
        <li>
          <TierBadge tier="A" />
          <p>The instance's own receiver heard the finder on the air there. A copy from the internet never counts.</p>
        </li>
      </ol>
      <ManualLink className="landing-more" page="reference/trust-model">
        How verification works
      </ManualLink>
    </section>
  );
}

const SHACK: [IconName, string, string][] = [
  ["radio", "Your radio, your way", "KISS TNC, Bluetooth, Meshtastic, or the sound card."],
  ["bbs", "Packet terminal and BBS", "AX.25 connected mode, FBB forwarding, a NET/ROM node."],
  ["map", "Live map", "Stations, tracks, weather and spots, with offline maps."],
  ["server", "Federated", "Instances share signed finds, over HTTPS or over the air."],
  ["tools", "Tools", "Signed plugins: decoders, macros, panels."],
  ["thermo", "Weather", "Your weather station, CWOP and WX beacons."],
];

function Shack() {
  return (
    <section className="landing-section landing-split landing-split-rev" id="shack" aria-labelledby="shack-h">
      <div className="landing-desktop">
        <Shot
          name="desktop"
          widths={[960, 1920]}
          ratio={[1920, 1200]}
          sizes="(min-width: 880px) 560px, 92vw"
          alt="The app on a desktop: the Nearby list beside an open cache"
        />
      </div>
      <div>
        <p className="landing-eyebrow">More than a game</p>
        <h2 id="shack-h">A ham-radio Shack underneath</h2>
        <ul className="landing-caps">
          {SHACK.map(([icon, title, line]) => (
            <li key={title}>
              <Icon name={icon} size={20} />
              <span>
                <strong>{title}.</strong> {line}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section className="landing-section" id="privacy" aria-labelledby="privacy-h">
      <p className="landing-eyebrow">What we do with your beacons</p>
      <h2 id="privacy-h">An APRS map that forgets</h2>
      <dl className="landing-facts">
        <div>
          <dt>Positions expire</dt>
          <dd>Tracks are pruned on a schedule; only a find's own evidence is kept longer.</dd>
        </div>
        <div>
          <dt>Nothing is watching you</dt>
          <dd>No analytics, no ads, no third-party scripts. One session cookie when you sign in.</dd>
        </div>
        <div>
          <dt>The source is the receipt</dt>
          <dd>Every instance links the exact code it runs, so a promise can be checked.</dd>
        </div>
        <div>
          <dt>Or run it yourself</dt>
          <dd>Your radio, your database, your rules.</dd>
        </div>
      </dl>
    </section>
  );
}

function RunAnywhere() {
  return (
    <section className="landing-section landing-run" aria-labelledby="run-h">
      <h2 id="run-h">Run it anywhere</h2>
      <ul className="landing-hosts">
        <li>A desktop app</li>
        <li>A Raspberry Pi at home</li>
        <li>Any VM with Docker</li>
        <li>An Android phone in the field</li>
        <li>A free cloud VM, with your own RF box</li>
      </ul>
      <ManualLink className="landing-more" page="run/index">
        Choose how to run it
      </ManualLink>
    </section>
  );
}
