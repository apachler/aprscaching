// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ASSET, MANUAL_URL } from "./brand.js";
import { API_BASE } from "./api.js";
import { statsShown, type Stats } from "./landingStats.js";
import { Button, Icon, ManualLink, TierBadge, type IconName } from "./ui/index.js";
import { APRS_CREDIT, APRS_MARK, APRS_NOT_AFFILIATED, OTHER_MARKS, OTHERS_NOT_AFFILIATED } from "./credits.js";

/**
 * The landing page — "Live on the air", the instance's front door. The hero keeps the brand treatment in every
 * theme and opens with the product's thesis: an APRS frame heard on the air, decoding into its Radio-verified stamp,
 * beside the one primary action, the callsign that joins (or signs in; the steps are the same). Below it: the two
 * ways in (the game and the Shack, each with its public tour), a full-width band of the live map, the trust tiers,
 * and a short close. The longer stories live on the project's own sites, aprscaching.com and aprscaching.org.
 * Images are made from the real app by apps/web/test/visual/landing-assets.mjs.
 */
export function Landing(props: {
  /** Open sign-in, on the callsign the visitor typed when there is one. */
  onSignIn: (call?: string) => void;
  onExplore: () => void;
  /** Taking over from the prerendered copy: the terminal card's sequence carries on where that copy is. */
  resume?: boolean;
}) {
  // how far the page has come since it was opened, as a negative delay for the sequence's CSS animations
  const [skew] = useState(() => (props.resume ? `${-Math.round(performance.now())}ms` : "0ms"));
  return (
    <main className="landing" style={{ "--landing-skew": skew } as CSSProperties}>
      <Hero onSignIn={props.onSignIn} onExplore={props.onExplore} />
      <Ways />
      <MapBand onExplore={props.onExplore} />
      <Trust />
      <section className="landing-section landing-close">
        <h2>Free in full. Open in full.</h2>
        <p>
          AGPL-3.0, and every instance links the code it runs. No analytics, no adverts, no third-party scripts, and
          positions expire. Donations buy recognition, never features.
        </p>
        <Cta to="join" variant="primary" onGo={() => props.onSignIn()}>
          Join with your callsign
        </Cta>
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
        <a href={`${API_BASE}/terms`}>Terms of use</a>
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

function Hero(props: { onSignIn: (call?: string) => void; onExplore: () => void }) {
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
          <a href="#ways">Play or operate</a>
          <a href="#map">The map</a>
          <a href="#trust">Trust</a>
          <a href={MANUAL_URL} target="_blank" rel="noopener">
            Manual
          </a>
        </span>
        <Cta to="join" onGo={() => props.onSignIn()}>
          Sign in
        </Cta>
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
          <JoinForm onJoin={props.onSignIn} />
          {/* a div, since a paragraph cannot hold the call to action's form */}
          <div className="landing-or">
            No licence yet?{" "}
            <Cta to="map" onGo={props.onExplore}>
              Explore the live map
            </Cta>
          </div>
        </div>
        <Terminal />
      </div>
      <LiveStats />
    </header>
  );
}

/**
 * A call to action that works in the prerendered copy, before the app has loaded: a form a tap submits, to the join
 * page (sign-in) or to the front page with `view=map` (the platform, opensPlatform). Once the app is up it does the
 * same in place.
 */
function Cta(props: { to: "join" | "map"; variant?: "primary"; onGo: () => void; children: ReactNode }) {
  return (
    <form
      className="landing-cta-form"
      action={props.to === "join" ? "/join" : "/"}
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        props.onGo();
      }}
    >
      {props.to === "map" && <input type="hidden" name="view" value="map" />}
      <Button variant={props.variant} type="submit">
        {props.children}
      </Button>
    </form>
  );
}

/**
 * The callsign that joins: new or returning, sign-in takes it from here. It is a real form to `/join`, so the
 * prerendered copy works before the app has loaded; once the app is up it opens sign-in in place.
 */
function JoinForm(props: { onJoin: (call?: string) => void }) {
  return (
    <form
      className="landing-join"
      action="/join"
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        props.onJoin(String(new FormData(e.currentTarget).get("call") ?? "").trim());
      }}
    >
      <label htmlFor="landing-call">Your callsign</label>
      <span className="landing-join-row">
        <input
          id="landing-call"
          name="call"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={8}
          placeholder="OE8APR"
          aria-describedby="landing-call-help"
        />
        <Button variant="primary" type="submit">
          Join
        </Button>
      </span>
      <span className="landing-join-help" id="landing-call-help">
        New or returning, the same step signs you in, with a passkey or an email link.
      </span>
    </form>
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

const STAT_LABEL: Record<keyof Stats, string> = {
  caches: "caches hidden here",
  findsOnAirThisWeek: "finds heard on the air this week",
  stationsHeardLastHour: "stations heard in the last hour",
};
const STAT_KEYS = Object.keys(STAT_LABEL) as (keyof Stats)[];

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
    ? statsShown(stats).map(([k, v]) => [STAT_LABEL[k], n(v)])
    : STAT_KEYS.map((k) => [STAT_LABEL[k], null]);
  if (items.length === 0) return null;
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
        <Cta to="map" onGo={props.onExplore}>
          Explore the live map
        </Cta>
        <p className="landing-attrib">Map © OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors</p>
      </div>
    </section>
  );
}

const WAYS: { icon: IconName; title: string; line: string; tour: string; tourLabel: string; site: string }[] = [
  {
    icon: "map",
    title: "Play",
    line: "Hide caches, hunt them by map, bearing or locator, and key the find over APRS from the spot.",
    tour: "/tour/game",
    tourLabel: "Take the game tour",
    site: "aprscaching.com",
  },
  {
    icon: "radio",
    title: "Operate",
    line: "The Shack: a packet terminal, a BBS, messages, signal decoders and rig control, with your own radio.",
    tour: "/tour/shack",
    tourLabel: "Take the Shack tour",
    site: "aprscaching.org",
  },
];

/** The two ways in. Each tour is the real app on demo data, so a visitor tries it before joining. */
function Ways() {
  return (
    <section className="landing-section" id="ways" aria-labelledby="ways-h">
      <p className="landing-eyebrow">Two ways in</p>
      <h2 id="ways-h">Play the game, or run your station</h2>
      <ul className="landing-ways">
        {WAYS.map((w) => (
          <li key={w.title}>
            <Icon name={w.icon} size={24} />
            <h3>{w.title}</h3>
            <p>{w.line}</p>
            <span className="landing-way-links">
              <a className="landing-way-tour" href={w.tour}>
                {w.tourLabel}
              </a>
              <a href={`https://${w.site}/`} rel="noopener">
                More on {w.site}
              </a>
            </span>
          </li>
        ))}
      </ul>
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
