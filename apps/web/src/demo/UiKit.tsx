// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The UI kit — `/?demo=ui`: the design language on one page. Every primitive in every state it has, in either
 * density; the colour tokens with their contrast on the panel surface; the role scales for type, space,
 * radius, elevation and motion beside the size-named steps they replace; and real surfaces rendered both
 * ways, side by side. A theme switch covers dark, light and Phosphor. docs/design/design-language.md is the
 * text this page illustrates; apps/web/test/visual/run.mjs renders it for review and runs axe on it.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Advanced,
  Badge,
  Button,
  CallVerifiedBadge,
  Card,
  CommandBlock,
  ConfirmProvider,
  Disclosure,
  DtBars,
  EmptyState,
  ErrorState,
  Group,
  Icon,
  ICON_NAMES,
  Ico,
  LicenceBadge,
  LoadMore,
  MinTier,
  Row,
  Stat,
  Switch,
  TierBadge,
  TierChip,
  ToastProvider,
  useConfirm,
  useToast,
} from "../ui/index.js";
import { FormatContext, loadSettings, makeFormatters } from "../format.js";
import "../styles/scale-preview.css";

type ThemeAttr = "dark" | "light" | "phosphor";

/** The pairs on the swatch board: what the token is for, and the surface it is read on. */
const COLOURS: { group: string; tokens: [name: string, role: string][] }[] = [
  {
    group: "Surfaces and ink",
    tokens: [
      ["--page-bg", "the page behind the map"],
      ["--surface", "panels and sheets"],
      ["--surface-2", "raised controls"],
      ["--field-bg", "inputs"],
      ["--panel-2", "operator side panels"],
      ["--ink", "running text"],
      ["--ink-2", "bright data values"],
      ["--muted", "secondary text"],
      ["--heading", "headings and links"],
      ["--line", "borders"],
      ["--hair", "hairline dividers"],
    ],
  },
  {
    group: "Brand and action",
    tokens: [
      ["--brand", "chrome blue"],
      ["--accent", "the one action colour (fill)"],
      ["--accent-ink", "text on the accent"],
      ["--topbar-bg", "the top bar"],
      ["--chrome-ink", "text on chrome"],
      ["--rail-bg", "the nav rail"],
    ],
  },
  {
    group: "Trust tiers and status",
    tokens: [
      ["--tier-a", "Tier A · Radio-verified"],
      ["--tier-b", "Tier B · Location-verified"],
      ["--tier-c", "Tier C · Logged"],
      ["--ok", "success"],
      ["--warn", "warning"],
      ["--bad", "error, danger"],
      ["--fav", "favourite"],
      ["--meshcom", "MeshCom"],
    ],
  },
];

const TYPE_ROLES: [role: string, old: string, sample: string, font?: string][] = [
  ["--text-display", "--fs-landing-slogan", "Geocaching, on the air.", "var(--font-brand)"],
  ["--text-title-lg", "--fs-5xl", "Run an instance", "var(--font-brand)"],
  ["--text-title", "--fs-4xl", "Schlossberg clock tower", "var(--font-brand)"],
  ["--text-heading", "--fs-2xl", "Coordinates"],
  ["--text-input", "--fs-xl", "Type a callsign"],
  ["--text-body", "--fs-base", "A small container with a logbook, verified on the air."],
  ["--text-data", "--fs-md", "OE8APR-7 · 47.0763° 15.4378° · JN77rb", "var(--font-mono)"],
  ["--text-label", "--fs-sm", "DIFFICULTY"],
  ["--text-caption", "--fs-xs", "Logged 2 h ago"],
  ["--text-micro", "--fs-3xs", "Nearby"],
];

const SPACE = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
const OLD_SPACE = Array.from({ length: 15 }, (_, i) => `--sp-${i}`);
const RADII = ["tick", "chip", "control", "card", "sheet", "pill"];
const ELEVATIONS = ["flat", "raised", "floating", "floating-up", "overlay"];

/** A colour expression (var(), color-mix(), OKLCH) as the browser computes it, through a probe element. */
function resolveColour(css: string): string {
  const probe = document.createElement("span");
  probe.style.color = css;
  document.body.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

/** sRGB of a CSS colour as the browser paints it, through a 1×1 canvas. */
function paint(css: string, under = "#000"): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return [0, 0, 0];
  g.fillStyle = under;
  g.fillRect(0, 0, 1, 1);
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
}
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function ratio(fg: string, bg: string): number {
  const back = paint(resolveColour(bg));
  const front = paint(resolveColour(fg), `rgb(${back.join(",")})`);
  const [a, b] = [lum(front), lum(back)].sort((x, y) => y - x);
  return ((a ?? 0) + 0.05) / ((b ?? 0) + 0.05);
}
const tokenValue = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function Section(props: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="uikit-sec" aria-labelledby={`uk-${props.id}`}>
      <h2 id={`uk-${props.id}`}>{props.title}</h2>
      {props.lede && <p className="muted">{props.lede}</p>}
      {props.children}
    </section>
  );
}

function Seg<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="uikit-ctl">
      <span className="ulabel" id={`seg-${props.label}`}>
        {props.label}
      </span>
      <div className="seg" role="group" aria-labelledby={`seg-${props.label}`}>
        {props.options.map(([v, l]) => (
          <button
            key={v}
            className={props.value === v ? "on" : ""}
            aria-pressed={props.value === v}
            onClick={() => props.onChange(v)}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatches(props: { theme: string }) {
  const [rows, setRows] = useState<{ name: string; role: string; value: string; text: number }[][]>([]);
  useEffect(() => {
    // measured after the theme attribute applies, so the numbers are this theme's
    const id = requestAnimationFrame(() =>
      setRows(
        COLOURS.map((g) =>
          g.tokens.map(([name, role]) => ({
            name,
            role,
            value: tokenValue(name),
            text: ratio(`var(${name})`, tokenValue("--surface")),
          })),
        ),
      ),
    );
    return () => cancelAnimationFrame(id);
  }, [props.theme]);
  return (
    <>
      {COLOURS.map((g, i) => (
        <div key={g.group}>
          <h3>{g.group}</h3>
          <ul className="uikit-swatches">
            {(rows[i] ?? []).map((r) => (
              <li key={r.name}>
                <span className="uikit-chip" style={{ "--c": `var(${r.name})` } as CSSProperties} aria-hidden="true" />
                <span>
                  <code>{r.name}</code>
                  <br />
                  <span className="muted">{r.role}</span>
                </span>
                <span className={`mono ${r.text >= 4.5 ? "" : r.text >= 3 ? "uikit-mid" : "uikit-low"}`}>
                  {r.text.toFixed(2)}:1
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="muted">
        The ratio is each colour as text on <code>--surface</code>: 4.5:1 for text, 3:1 for large text, icons and
        borders. <code>apps/web/test/contrast.test.ts</code> checks the pairs the stylesheets actually use.
      </p>
    </>
  );
}

function Primitives() {
  const toast = useToast();
  const confirm = useConfirm();
  const [sw, setSw] = useState(true);
  const [master, setMaster] = useState(true);
  const [seg, setSeg] = useState("all");
  return (
    <>
      <h3>Buttons</h3>
      <div className="uikit-row">
        <Button variant="primary">Log a find</Button>
        <Button>Navigate</Button>
        <Button variant="danger">Delete</Button>
        <Button variant="link">Show the logbook</Button>
        <Button variant="icon" aria-label="Close">
          <Icon name="close" />
        </Button>
      </div>
      <div className="uikit-row">
        <Button variant="primary" disabled>
          Log a find
        </Button>
        <Button disabled>Navigate</Button>
        <Button variant="danger" disabled>
          Delete
        </Button>
        <Button variant="primary" aria-busy="true" disabled>
          Logging…
        </Button>
      </div>
      <p className="muted">Hover, press and keyboard focus (Tab) show their states on the buttons above.</p>

      <h3>Badges and chips</h3>
      <div className="uikit-row">
        <TierBadge tier="A" />
        <TierBadge tier="B" />
        <TierBadge tier="C" />
        <Badge kind="found">found</Badge>
        <Badge kind="dnf">DNF</Badge>
        <Badge kind="warn">needs maintenance</Badge>
        <Badge>Traditional</Badge>
        <CallVerifiedBadge />
        <LicenceBadge licence={{ status: "licensed", sourceName: "AT" }} />
        <LicenceBadge licence={{ status: "unconfirmed" }} />
      </div>
      <div className="uikit-row">
        <TierChip tier="A" />
        <TierChip tier="B" />
        <TierChip tier="C" />
        <TierChip tier="A" lg />
      </div>
      <div className="uikit-grid2">
        <MinTier tier="B" />
        <div className="uikit-row">
          <Stat label="Finds">97</Stat>
          <Stat label="Points">355</Stat>
          <div>
            <span className="ulabel">Difficulty</span>
            <DtBars value={3} />
          </div>
        </div>
      </div>

      <h3>Switches and segmented controls</h3>
      <div className="uikit-grid2">
        <Card className="uikit-card">
          <Row label="Geofence prompts" help="Notify me when I walk into a cache's area.">
            <Switch checked={sw} onChange={setSw} label="Geofence prompts" />
          </Row>
          <Row label="Transmit" help="Verify your callsign to enable transmit.">
            <Switch checked={false} disabled label="Transmit" />
          </Row>
        </Card>
        <div>
          <div className="seg" role="group" aria-label="Show">
            {[
              ["all", "All"],
              ["caches", "Caches"],
              ["stations", "Stations"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={seg === v ? "on" : ""}
                aria-pressed={seg === v}
                onClick={() => setSeg(v as string)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <h3>Groups, rows and disclosure</h3>
      <div className="uikit-grid2">
        <Group
          title="Notifications"
          status={master ? "active" : "inactive"}
          master={{ on: master, set: setMaster }}
          defaultOpen
        >
          <Row label="Find confirmations" help="A toast when a find is verified.">
            <Switch checked={true} label="Find confirmations" />
          </Row>
          <Advanced label="Advanced (sound, throttling)">
            <Row label="Sound">
              <Switch checked={false} label="Sound" />
            </Row>
          </Advanced>
        </Group>
        <Group
          title="APRS-IS announce"
          status="needs verification"
          master={{ on: false, set: () => {}, disabled: true }}
          reason="Verify your callsign to enable announce."
        />
      </div>
      <Disclosure label="Hint">Look behind the third stone from the gate.</Disclosure>
      <Disclosure label="Verification · Location-verified or better" variant="section">
        A find counts from Tier B: the app's location check, or a receiving station that heard you.
      </Disclosure>

      <h3>States</h3>
      <div className="uikit-grid2">
        <Card className="uikit-card">
          <EmptyState action={<Button variant="primary">Make an offline pack</Button>}>
            No offline packs yet. Make one before you leave coverage.
          </EmptyState>
        </Card>
        <Card className="uikit-card">
          <ErrorState onRetry={() => toast("Retrying…")}>The logbook did not load.</ErrorState>
        </Card>
        <Card className="uikit-card">
          <LoadMore hasMore={true} loading={false} onClick={() => {}} />
          <LoadMore hasMore={true} loading={true} onClick={() => {}} />
        </Card>
        <Card className="uikit-card">
          <CommandBlock label="Bring the tunnel up" command="sudo deploy/aprscaching net44 setup wg44.conf" />
        </Card>
      </div>

      <h3>Feedback</h3>
      <div className="uikit-row">
        <Button onClick={() => toast("Logged ✓ — Tier B, location-verified")}>Show a toast</Button>
        <Button
          variant="danger"
          onClick={() =>
            void confirm({
              title: "Delete this cache?",
              message: "Its logbook stays; the cache leaves the map.",
              confirmLabel: "Delete",
              danger: true,
            })
          }
        >
          Ask to confirm
        </Button>
      </div>

      <h3>Icons</h3>
      <ul className="uikit-icons">
        {ICON_NAMES.map((n) => (
          <li key={n}>
            <Icon name={n} size={22} />
            <code>{n}</code>
          </li>
        ))}
      </ul>
      <p className="muted">
        Decorative glyphs (<code>Ico</code>): <Ico e="📡 " c="" />
        <Ico e="📻 " c="" />— emoji in Modern, CP437 in Phosphor. The design language replaces them with the line icons
        above (G3).
      </p>
    </>
  );
}

/** A real surface of the app in a frame, at phone size, with the current or the role scale. */
function Frame(props: { title: string; query: string; scale: "current" | "role"; theme: ThemeAttr }) {
  const src = `/${props.query}${props.query ? "&" : "?"}demo=app&as=user${props.scale === "role" ? "&scale=role" : ""}&theme=${props.theme}#14/47.0725/15.4380`;
  return (
    <figure className="uikit-frame">
      <iframe title={`${props.title}, ${props.scale} scale`} src={src} width={390} height={720} />
      <figcaption>
        {props.title} · {props.scale === "role" ? "role scale" : "current scale"}
      </figcaption>
    </figure>
  );
}

function Kit() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [theme, setTheme] = useState<ThemeAttr>((params.get("theme") as ThemeAttr) || "dark");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [scale, setScale] = useState<"current" | "role">("current");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (scale === "role") document.documentElement.dataset.scale = "role";
    else delete document.documentElement.dataset.scale;
  }, [scale]);
  const fmt = useMemo(
    () => makeFormatters({ ...loadSettings(), theme: theme === "phosphor" ? "phosphor" : "modern" }),
    [theme],
  );

  return (
    <FormatContext.Provider value={fmt}>
      <ToastProvider>
        <ConfirmProvider>
          <main className="uikit" data-density={density === "compact" ? "compact" : undefined}>
            <header className="uikit-head">
              <h1>UI kit</h1>
              <p className="muted">
                The design language of APRScaching, live: tokens, scales and every primitive. The text is in{" "}
                <a href="/?view=docs&doc=design/design-language">Design language</a>.
              </p>
              <div className="uikit-row">
                <Seg
                  label="Theme"
                  value={theme}
                  onChange={setTheme}
                  options={[
                    ["dark", "Dark"],
                    ["light", "Light"],
                    ["phosphor", "Phosphor"],
                  ]}
                />
                <Seg
                  label="Density"
                  value={density}
                  onChange={setDensity}
                  options={[
                    ["comfortable", "Comfortable"],
                    ["compact", "Compact"],
                  ]}
                />
                <Seg
                  label="Scale"
                  value={scale}
                  onChange={setScale}
                  options={[
                    ["current", "Current"],
                    ["role", "Role"],
                  ]}
                />
              </div>
            </header>

            <Section
              id="colour"
              title="Colour"
              lede="Colour carries a role, never decoration. Every pair a stylesheet uses meets WCAG 2.2 AA in every theme."
            >
              <Swatches theme={theme} />
            </Section>

            <Section
              id="type"
              title="Type"
              lede="Ten roles on a 1.2 ratio around the 14 px body, beside the size-named step each replaces."
            >
              <table className="uikit-table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Role scale</th>
                    <th scope="col">Current step</th>
                  </tr>
                </thead>
                <tbody>
                  {TYPE_ROLES.map(([role, old, sample, font]) => (
                    <tr key={role}>
                      <th scope="row">
                        <code>{role}</code>
                      </th>
                      <td
                        className="uikit-sample"
                        style={{ "--fs": `var(${role})`, "--ff": font ?? "inherit" } as CSSProperties}
                      >
                        {sample}
                      </td>
                      <td
                        className="uikit-sample"
                        style={{ "--fs": `var(${old})`, "--ff": font ?? "inherit" } as CSSProperties}
                      >
                        {sample} <code className="muted">{old}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            <Section
              id="space"
              title="Space, radius and elevation"
              lede="A 4 px rhythm; radius and elevation by what a thing is, not by how big."
            >
              <h3>Space</h3>
              <div className="uikit-scale">
                {SPACE.map((s) => (
                  <div key={s}>
                    <span className="uikit-bar" style={{ "--w": `var(--space-${s})` } as CSSProperties} />
                    <code>--space-{s}</code>
                  </div>
                ))}
              </div>
              <Disclosure label={`The ${OLD_SPACE.length} current steps`}>
                <div className="uikit-scale">
                  {OLD_SPACE.map((s) => (
                    <div key={s}>
                      <span className="uikit-bar" style={{ "--w": `var(${s})` } as CSSProperties} />
                      <code>{s}</code>
                    </div>
                  ))}
                </div>
              </Disclosure>
              <h3>Radius</h3>
              <div className="uikit-row">
                {RADII.map((r) => (
                  <div key={r} className="uikit-shape" style={{ "--rad": `var(--radius-${r})` } as CSSProperties}>
                    <code>{r}</code>
                  </div>
                ))}
              </div>
              <h3>Elevation</h3>
              <div className="uikit-row">
                {ELEVATIONS.map((e) => (
                  <div key={e} className="uikit-shape" style={{ "--sh": `var(--elevation-${e})` } as CSSProperties}>
                    <code>{e}</code>
                  </div>
                ))}
              </div>
              <h3>Motion</h3>
              <p className="muted">
                <code>--motion-fast</code> 120 ms (hover, press, toggles) · <code>--motion-base</code> 200 ms (sheets,
                panels, disclosures) · <code>--motion-slow</code> 320 ms (the landing page's one entrance). All three
                are zero when the system asks for reduced motion.
              </p>
            </Section>

            <Section
              id="primitives"
              title="Primitives"
              lede="One component per pattern (ui-ux.md §3), in every state it has. Switch the density to see the compact set."
            >
              <Primitives />
            </Section>

            <Section
              id="surfaces"
              title="Real surfaces, both ways"
              lede="The app itself, current scale on the left and the role scale on the right, in the theme above."
            >
              {[
                ["Map home", ""],
                ["Cache sheet", "?v=demo"],
                ["Settings", "?view=settings"],
                ["BBS (a Shack app)", "?view=bbs"],
              ].map(([title, query]) => (
                <div className="uikit-pair" key={title}>
                  <Frame title={title as string} query={query as string} scale="current" theme={theme} />
                  <Frame title={title as string} query={query as string} scale="role" theme={theme} />
                </div>
              ))}
            </Section>
          </main>
        </ConfirmProvider>
      </ToastProvider>
    </FormatContext.Provider>
  );
}

export function UiKit() {
  return <Kit />;
}
