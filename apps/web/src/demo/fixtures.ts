// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * App fixtures — canned gateway answers that render every surface of the real app with realistic data and no
 * gateway: a region around Graz with caches of every type, live stations, MeshCom nodes, logs in all three
 * tiers, messages, ranks and an instance admin. `/?demo=app` installs them as a `fetch` shim (installAppFixtures);
 * the visual and accessibility harness (apps/web/test/visual/) loads the same page. Typed against the shared
 * DTOs, so a changed response shape fails the typecheck here rather than rendering a stale screen.
 *
 * Personas (`&as=`): `user` (default, OE8APR signed in), `sysop` (the same call, operator of the instance) and
 * `out` (signed out, the landing page). Third-party requests (map tiles, styles) are refused, so the map draws
 * its offline graticule and nothing leaves the page; `&net=1` lets them through, to check the overlays on the
 * real basemaps.
 */
import type {
  ActivityItem,
  CacheDetail,
  CacheLogEntry,
  CacheStage,
  Corroborator,
  LeaderboardEntry,
  MapCache,
  MessageItem,
  MeshcomGroup,
  MeshcomGroupMessage,
  OperatedStation,
  PortStat,
  Profile,
  SearchResults,
  StationDetail,
  StationSummary,
  BbsMessage,
} from "@aprscaching/shared";
import type {
  AdminAdoptions,
  BoxFinds,
  EnrolledBox,
  FederationSync,
  TrustedStation,
  Licence,
  LogResult,
  AdminSetup,
  CallsignIdentity,
  SourceInfo,
  SupportInfo,
  VerifyMethods,
} from "../api.js";

export type Persona = "user" | "sysop" | "out";

const NOW = Math.floor(Date.UTC(2026, 9, 1, 14, 30) / 1000); // fixed, so screenshots are stable
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
const ME = "OE8APR";
const INSTANCE = "aprs.example.net";

const base = {
  ownerCall: ME,
  status: "active" as const,
  origin: INSTANCE,
  mirrored: false,
  originTrust: "native" as const,
  source: "native",
  sourceName: null,
  sourceUrl: null,
  country: "OE" as string | null,
  tags: [] as string[],
};

/** The watchlist's alerts: two unseen, one seen. */
const WATCH_ALERTS = [
  {
    id: 3,
    callsign: "OE3ABC",
    kind: "cache_found",
    detail: "AC0001 Schlossberg clock tower",
    cacheId: 1,
    lat: 47.0763,
    lon: 15.4378,
    ts: NOW - 20 * MIN,
    seen: false,
  },
  {
    id: 2,
    callsign: "OE6XRR-9",
    kind: "near_cache",
    detail: "within 150 m of AC0002",
    cacheId: 2,
    lat: 47.071,
    lon: 15.432,
    ts: NOW - 2 * HOUR,
    seen: false,
  },
  { id: 1, callsign: "OE6XRR-9", kind: "heard", cacheId: null, lat: 47.06, lon: 15.45, ts: NOW - DAY, seen: true },
];

/** The region: around Graz (47.07 N, 15.42 E). */
export const MAP_CACHES: MapCache[] = [
  {
    ...base,
    globalId: `${INSTANCE}:cache:1`,
    id: 1,
    code: "AC0001",
    title: "Schlossberg clock tower",
    tags: ["scenic", "family"],
    type: "traditional",
    difficulty: 1.5,
    terrain: 2,
    lat: 47.0763,
    lon: 15.4378,
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:2`,
    id: 2,
    code: "AC0002",
    title: "Mur island bridges",
    tags: ["scenic", "city"],
    type: "multi",
    difficulty: 3,
    terrain: 1.5,
    lat: 47.0719,
    lon: 15.4337,
    ownerCall: "OE6GHJ",
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:3`,
    id: 3,
    code: "AC0003",
    title: "OE6XRR on the move",
    type: "aprs_living",
    difficulty: 2,
    terrain: 2,
    lat: 47.0602,
    lon: 15.4588,
    ownerCall: "OE6XRR",
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:4`,
    id: 4,
    code: "AC0004",
    title: "Morse in the Stadtpark",
    tags: ["cw", "family"],
    type: "audio",
    difficulty: 3.5,
    terrain: 1,
    lat: 47.0738,
    lon: 15.4469,
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:5`,
    id: 5,
    code: "AC0005",
    title: "The Landhaus courtyard",
    type: "virtual",
    difficulty: 1,
    terrain: 1,
    lat: 47.0703,
    lon: 15.4392,
    ownerCall: "OE6MKL",
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:6`,
    id: 6,
    code: "AC0006",
    title: "Plabutsch summit",
    type: "sota",
    difficulty: 2,
    terrain: 3.5,
    lat: 47.0824,
    lon: 15.3898,
    ownerCall: "SOTA",
    source: "sota",
    sourceName: "SOTA",
    sourceUrl: "https://www.sotadata.org.uk/en/summit/OE/ST-123",
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:7`,
    id: 7,
    code: "AC0007",
    title: "Grazer Bergland park",
    type: "pota",
    difficulty: 1.5,
    terrain: 2.5,
    lat: 47.1094,
    lon: 15.3711,
    ownerCall: "POTA",
    source: "pota",
    sourceName: "POTA",
    sourceUrl: "https://pota.app/#/park/OE-0042",
  },
  {
    ...base,
    globalId: `${INSTANCE}:cache:8`,
    id: 8,
    code: "AC0008",
    title: "Hilmteich",
    tags: ["family"],
    type: "traditional",
    difficulty: 2,
    terrain: 1.5,
    lat: 47.0815,
    lon: 15.4645,
    status: "disabled",
  },
  {
    ...base,
    globalId: "oe5.aprscaching.example:cache:12",
    id: null,
    code: "AC5012",
    title: "Linz Pöstlingberg view",
    country: null,
    type: "traditional",
    difficulty: 2.5,
    terrain: 3,
    lat: 47.0546,
    lon: 15.4021,
    ownerCall: "OE5ABC",
    origin: "oe5.aprscaching.example",
    mirrored: true,
    originTrust: "trusted",
  },
];

const log = (
  id: number,
  cacheId: number,
  loggerCall: string,
  agoS: number,
  logType: CacheLogEntry["logType"],
  tier: CacheLogEntry["tier"],
  extra: Partial<CacheLogEntry> = {},
): CacheLogEntry => ({
  id,
  cacheId,
  loggerCall,
  ts: NOW - agoS,
  logType,
  verified: tier !== null && tier !== "C",
  tier,
  verifyMethod: tier === "A" ? "rf_track" : tier === "B" ? "app_geo" : null,
  distanceM: tier === "A" ? 18 : tier === "B" ? 6 : null,
  comment: null,
  ...extra,
});

const LOGS: CacheLogEntry[] = [
  log(101, 1, "OE6GHJ", 2 * HOUR, "found", "A", {
    comment: "Heard by OE6XGR-10 on the way up. TFTC!",
    corroboratedBy: null,
  }),
  log(102, 1, "DL4MDW", 1 * DAY, "found", "B", { comment: "Quick find before the lift down." }),
  log(103, 1, "OE8KUR", 3 * DAY, "dnf", null, { comment: "Too many muggles around the clock." }),
  log(104, 1, "OE6MKL", 6 * DAY, "found", "C", { comment: "Logged over APRS-IS from the café." }),
  log(105, 1, ME, 9 * DAY, "maintenance", null, { comment: "New logbook, container dried." }),
];

const detail = (c: MapCache, extra: Partial<CacheDetail> = {}): CacheDetail => ({
  id: c.id ?? 0,
  code: c.code,
  ownerCall: c.ownerCall,
  title: c.title,
  type: c.type,
  status: c.status,
  difficulty: c.difficulty,
  terrain: c.terrain,
  lat: c.lat,
  lon: c.lon,
  stationCall: c.type === "aprs_living" ? "OE6XRR-9" : null,
  source: c.source,
  sourceName: c.sourceName,
  sourceUrl: c.sourceUrl,
  sourceOwner: null,
  sourceAttribution: null,
  minTrust: null,
  fedScope: "public",
  driveIn: false,
  country: "OE",
  tags: [],
  hint: "Look behind the third stone from the gate.",
  description:
    "A small container with a logbook. Beacon your position on the way up and the find can be verified on the air; the app's location check works too.",
  externalId: null,
  createdAt: NOW - 400 * DAY,
  updatedAt: NOW - 9 * DAY,
  finds: 42,
  findsByMonth: [3, 5, 2, 6, 4, 7, 3, 5, 4, 6, 8, 5].map((n, i) => ({
    month: `2026-${String(i + 1).padStart(2, "0")}`,
    n,
  })),
  logs: LOGS.filter((l) => l.cacheId === (c.id ?? 0)),
  logsCursor: null,
  logsHasMore: false,
  favorites: 12,
  favorited: false,
  needsMaintenance: false,
  dnfStreak: 0,
  lastFound: NOW - 2 * HOUR,
  rating: { avg: 4.4, count: 17, mine: null, policy: "finders", canRate: false },
  rendezvous: [],
  stageCount: c.type === "multi" || c.type === "audio" ? 3 : 0,
  ...(c.type === "aprs_living" && { stationHeardAt: NOW - 12 * 60 }),
  ...extra,
});

const DETAILS = new Map<number, CacheDetail>(
  MAP_CACHES.filter((c) => c.id !== null).map((c) => [
    c.id as number,
    detail(
      c,
      c.id === 1
        ? {
            minTrust: "B",
            favorited: true,
            rating: { avg: 4.6, count: 23, mine: 5, policy: "finders", canRate: true },
            // ME hid it: the owner's view, with its stages, for the edit form
            own: { minTrust: null, rendezvous: false, move: { limitM: 100, pinned: null, stagePins: [] } },
            stageCount: 3,
          }
        : {},
    ),
  ]),
);

const STAGES: CacheStage[] = [
  {
    stageNo: 1,
    unlock: "geo",
    clue: "Start at the bridge with the shell.",
    // an unlocked location stage's clip: it loads on demand through the session
    mediaUrl: "/api/media/cache/1/stage/1/clue.mp3",
    radiusM: 60,
    unlocked: true,
    lat: 47.0719,
    lon: 15.4337,
  },
  { stageNo: 2, unlock: "nfc", clue: null, mediaUrl: null, radiusM: 60, unlocked: false, lat: null, lon: null },
  { stageNo: 3, unlock: "audio", clue: null, mediaUrl: null, radiusM: 60, unlocked: false, lat: null, lon: null },
];

export const STATIONS: StationSummary[] = [
  {
    callsign: "OE6XRR-9",
    lat: 47.0602,
    lon: 15.4588,
    symbol: "/>",
    course: 210,
    speedKn: 21,
    altitudeM: 355,
    comment: "Mobile, 144.800",
    lastSeen: NOW - 2 * MIN,
  },
  {
    callsign: "OE6XGR-10",
    lat: 47.0756,
    lon: 15.4349,
    symbol: "I&",
    course: null,
    speedKn: null,
    altitudeM: 470,
    comment: "Schlossberg IGate",
    lastSeen: NOW - 30,
    roles: ["igate", "digipeater"],
  },
  {
    callsign: "OE6GHJ-7",
    lat: 47.0688,
    lon: 15.4421,
    symbol: "/[",
    course: 90,
    speedKn: 3,
    altitudeM: 360,
    comment: "On foot",
    lastSeen: NOW - 8 * MIN,
  },
  {
    callsign: "OE6XWX",
    lat: 47.0909,
    lon: 15.4102,
    symbol: "/_",
    course: null,
    speedKn: null,
    altitudeM: 520,
    comment: "Weather, Gösting",
    lastSeen: NOW - 5 * MIN,
    roles: ["weather"],
  },
];

const MOBILE = STATIONS[0] as StationSummary;
const STATION_DETAIL: StationDetail = {
  ...MOBILE,
  track: [0, 1, 2, 3, 4, 5].map((i) => ({
    ts: NOW - (12 - i * 2) * MIN,
    lat: 47.0602 + i * 0.002,
    lon: 15.4588 - i * 0.003,
    heardVia: i % 2 ? "rf" : "aprs_is",
  })),
  wx: null,
  packets: 214,
  registered: true,
  mine: false,
};

const ACTIVITY: ActivityItem[] = LOGS.map((l) => ({
  id: l.id,
  loggerCall: l.loggerCall,
  ts: l.ts,
  logType: l.logType,
  verified: l.verified,
  tier: l.tier,
  cacheId: l.cacheId,
  cacheCode: "AC0001",
  cacheTitle: "Schlossberg clock tower",
}));

const LEADERS: LeaderboardEntry[] = [
  { rank: 1, loggerCall: "OE6GHJ", finds: 128, points: 412 },
  { rank: 2, loggerCall: ME, finds: 97, points: 355 },
  { rank: 3, loggerCall: "DL4MDW", finds: 61, points: 190 },
  { rank: 4, loggerCall: "OE8KUR", finds: 44, points: 133 },
  { rank: 5, loggerCall: "OE6MKL", finds: 21, points: 70 },
];

const CORROBORATORS: Corroborator[] = [
  { rank: 1, igate: "OE6XGR-10", corroborations: 88 },
  { rank: 2, igate: "OE8XKR-10", corroborations: 31 },
];

const PROFILE = (callsign: string): Profile => ({
  callsign,
  accountVerified: true,
  homeInstance: INSTANCE,
  supporter: callsign === ME,
  finds: 97,
  points: 355,
  firstFind: NOW - 700 * DAY,
  lastFind: NOW - 2 * DAY,
  hides: 6,
  corroborations: 14,
  byTier: { A: 41, B: 38, C: 18 },
  byType: { traditional: 60, multi: 14, aprs_living: 9, audio: 6, virtual: 8 },
  badges: [
    { badge: "first-find", earnedAt: NOW - 700 * DAY },
    { badge: "finder-50", earnedAt: NOW - 300 * DAY },
    { badge: "rover-hunter", earnedAt: NOW - 90 * DAY },
  ],
  profile: { displayName: "Andreas", homeGrid: "JN76", bio: "Portable on summits when the weather allows." },
});

const MESSAGES: MessageItem[] = [
  {
    id: 1,
    ts: NOW - 4 * MIN,
    fromCall: "OE6GHJ-7",
    toCall: `${ME}-7`,
    body: "QRV on 144.800? Meet at the clock tower.",
    direction: "in",
    transport: "tnc",
  },
  {
    id: 2,
    ts: NOW - 3 * MIN,
    fromCall: `${ME}-7`,
    toCall: "OE6GHJ-7",
    body: "On my way, 10 minutes.",
    direction: "tx",
    transport: "browser-rf",
    msgNo: "12",
    delivery: "acked",
  },
  {
    id: 3,
    ts: NOW - 50 * MIN,
    fromCall: "OE6XGR-10",
    toCall: "BLN1",
    body: "Digi maintenance Saturday 08:00-10:00.",
    direction: "in",
    transport: "aprs-is",
  },
  {
    id: 4,
    ts: NOW - 70 * MIN,
    fromCall: "OE6MCF-1",
    toCall: `${ME}-12`,
    body: "Node on the Schoeckl is back up.",
    direction: "in",
    transport: "meshcom",
  },
];

const MESHCOM_GROUPS: MeshcomGroup[] = [
  { group: "232", messages: 3, lastHeard: NOW - 6 * MIN },
  { group: "*", messages: 1, lastHeard: NOW - 3 * HOUR },
];

const MESHCOM_GROUP_MESSAGES: Record<string, MeshcomGroupMessage[]> = {
  "232": [
    {
      id: 3,
      ts: NOW - 6 * MIN,
      fromCall: "OE6MCF-1",
      body: "Anyone QRV for the summit net at 18z?",
      receiver: `${ME}-12`,
      heard: "direct",
    },
    {
      id: 2,
      ts: NOW - 25 * MIN,
      fromCall: "OE3XYZ-4",
      body: "Gateway in Vienna restarted, all good.",
      receiver: `${ME}-12`,
      heard: "server",
    },
    {
      id: 1,
      ts: NOW - 2 * HOUR,
      fromCall: "OE6GHJ-7",
      body: "Testing the new antenna, please report.",
      receiver: `${ME}-12`,
      heard: "relayed",
    },
  ],
  "*": [{ id: 4, ts: NOW - 3 * HOUR, fromCall: "OE8KLU-1", body: "CQ CQ via MeshCom", receiver: null, heard: null }],
};

const MY_STATIONS: OperatedStation[] = [
  {
    id: 1,
    callsign: `${ME}-10`,
    lat: 47.0712,
    lon: 15.4395,
    symbol: "I&",
    description: "Home IGate",
    roles: ["igate"],
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 20 * DAY,
  },
  {
    id: 2,
    callsign: `${ME}-9`,
    lat: null,
    lon: null,
    symbol: ">",
    description: "Car",
    roles: [],
    createdAt: NOW - 90 * DAY,
    updatedAt: NOW - 30 * DAY,
    livingCaches: [{ id: 7, code: "AC0007", title: "Catch the car", rendezvous: false }],
  },
];

const BBS: BbsMessage[] = [
  {
    id: 1,
    bid: "12345_OE6XGR",
    type: "P",
    fromCall: "OE6GHJ",
    toCall: ME,
    subject: "Saturday hunt",
    body: "Shall we try the Plabutsch multi on Saturday?",
    postedAt: NOW - 5 * HOUR,
    origin: "OE6XGR",
    readAt: null,
  },
  {
    id: 2,
    bid: "12346_OE6XGR",
    type: "B",
    fromCall: "OE6XGR",
    toCall: "ALL",
    subject: "Digi maintenance",
    body: "Saturday 08:00-10:00 UTC.",
    postedAt: NOW - 1 * DAY,
    origin: "OE6XGR",
    readAt: NOW - 20 * HOUR,
  },
];

const PORTS: PortStat[] = [
  { port: "aprs_is", rx: 18234, tx: 0, lastBucket: NOW - MIN },
  { port: "kiss:tnc0", rx: 912, tx: 37, lastBucket: NOW - MIN },
  { port: "meshcom", rx: 204, tx: 0, lastBucket: NOW - 5 * MIN },
];

/** The callsign identity records of the demo instance, on 44Net at the default name, and its self-check. */
const IDENTITY_KEY = "uKq3Hk2c7oP4Wm1xVt9sR6dN8bF5gL0aZyJ2eQhTiCw";
const IDENTITY: CallsignIdentity = {
  applicable: true,
  callsign: "OE8APR",
  host: "aprscaching.oe8apr.ampr.org",
  web: `https://${INSTANCE}`,
  records: [
    {
      name: "aprscaching.oe8apr.ampr.org",
      portal: "aprscaching",
      type: "A",
      value: "<your 44.x address>",
      placeholder: true,
      purpose: "The 44Net address peers connect to.",
    },
    {
      name: "_aprscaching.oe8apr.ampr.org",
      portal: "_aprscaching",
      type: "TXT",
      value: `v=acs1; inst=${INSTANCE}; key=${IDENTITY_KEY}; host=aprscaching.oe8apr.ampr.org; web=https://${INSTANCE}`,
      placeholder: false,
      purpose: `Your federation identity: peers add you by callsign, OE8APR, and connect over 44Net or over https at https://${INSTANCE}.`,
    },
  ],
  alternative: {
    name: "_aprscaching.oe8apr.ampr.org",
    portal: "_aprscaching",
    type: "TXT",
    value: `v=acs1; inst=${INSTANCE}; key=${IDENTITY_KEY}`,
    placeholder: false,
    purpose: "The same identity without your https address: peers then connect over 44Net only.",
  },
  lines: [
    {
      id: "endpoint",
      status: "pass",
      label: "44net endpoint",
      detail: "aprscaching.oe8apr.ampr.org — callsign OE8APR",
    },
    { id: "a", status: "pass", label: "Address record", detail: "aprscaching.oe8apr.ampr.org → 44.143.10.7" },
    {
      id: "txt",
      status: "pass",
      label: "Identity TXT",
      detail: `_aprscaching.oe8apr.ampr.org binds ${INSTANCE} and its current key`,
    },
    {
      id: "target",
      status: "pass",
      label: "Where peers connect",
      detail: `44Net aprscaching.oe8apr.ampr.org and https https://${INSTANCE}`,
    },
    {
      id: "dnssec",
      status: "info",
      label: "DNSSEC",
      detail: "the TXT answer is not DNSSEC-validated: a peer's operator confirms your key once when adding you",
    },
  ],
};

const SETUP: AdminSetup = {
  update: {
    current: "1.0.0",
    latest: "v1.1.0",
    url: "https://github.com/apachler/aprscaching/releases/tag/v1.1.0",
    checkedAt: NOW - 3 * 3600,
    available: true,
    desktop: false,
  },
  items: [
    {
      key: "operator",
      label: "Operator callsign",
      group: "identity",
      level: "blocking",
      status: "ok",
      source: "env",
      detail: `${ME} is the operator.`,
    },
    {
      key: "ingest",
      label: "Ingest secret",
      group: "security",
      level: "blocking",
      status: "ok",
      source: "env",
      detail: "Set; the ingest posts with it.",
    },
    {
      key: "imprint",
      label: "Imprint",
      group: "legal",
      level: "recommended",
      status: "warn",
      source: "db",
      detail: "Add the operator's name and address for a public instance.",
    },
    {
      key: "smtp",
      label: "Email delivery",
      group: "delivery",
      level: "recommended",
      status: "missing",
      source: "env",
      detail: "Sign-in links and digests need SMTP or a mail API.",
    },
    {
      key: "backup",
      label: "Backups",
      group: "data",
      level: "recommended",
      status: "ok",
      source: "env",
      detail: "Nightly to the bucket.",
    },
  ],
};

const SOURCE: SourceInfo = {
  repo: "https://github.com/apachler/aprscaching",
  commit: "15a1f08",
  tag: null,
  builtAt: NOW - DAY,
  license: "AGPL-3.0-or-later",
};

const SUPPORT: SupportInfo = {
  model: "recognition",
  donationLinks: [],
  ledger: { currency: "EUR", totalInCents: 0, totalOutCents: 0, balanceCents: 0, buckets: {}, months: [] },
  supporters: [ME],
  supporterCount: 1,
};

const SEARCH: SearchResults = {
  caches: MAP_CACHES.slice(0, 2).map((c) => ({
    kind: "cache",
    id: c.id ?? 0,
    code: c.code,
    title: c.title,
    ownerCall: c.ownerCall,
    type: c.type,
    lat: c.lat,
    lon: c.lon,
  })),
  stations: STATIONS.slice(0, 1).map((s) => ({
    kind: "station",
    callsign: s.callsign,
    symbol: s.symbol,
    comment: s.comment,
    lat: s.lat,
    lon: s.lon,
  })),
};

let nearRadio = false;
// Instance admin → Ingest boxes: the sysop's own box, and a receiver a neighbouring ham lends, trusted
const BOXES: EnrolledBox[] = [
  {
    box: "shack-pi",
    label: "Shack Pi",
    callsign: null,
    enrolledBy: "demo-sysop",
    enrolledAt: NOW - 60 * DAY,
    revokedBy: null,
    revokedAt: null,
    lastSeenAt: NOW - 120,
    trust: null,
    services: true,
  },
  {
    box: "oe6xyz-hill",
    label: "Schöckl receiver",
    callsign: "OE6XYZ",
    enrolledBy: "demo-sysop",
    enrolledAt: NOW - 21 * DAY,
    revokedBy: null,
    revokedAt: null,
    lastSeenAt: NOW - 300,
    trust: { sites: ["OE6XYZ-10"], trustedBy: "demo-sysop", trustedByCall: "OE6XGR", trustedAt: NOW - 20 * DAY },
    services: false,
  },
];
// Instance admin → Trusted receiving stations: the configuration's preset, one added here, the trusted lent box
const trustedStations = (): TrustedStation[] => [
  { site: "OE6XGR-10", source: "config", trustedBy: null, trustedByCall: null, trustedAt: null },
  ...BOXES.flatMap((b) =>
    (b.trust?.sites ?? []).map((site): TrustedStation => ({
      site,
      source: "box",
      box: b.box,
      boxLabel: b.label,
      trustedBy: b.trust!.trustedBy,
      trustedByCall: b.trust!.trustedByCall,
      trustedAt: b.trust!.trustedAt,
    })),
  ),
  { site: "OE6XGR-12", source: "admin", trustedBy: "demo-sysop", trustedByCall: "OE6XGR", trustedAt: NOW - 45 * DAY },
];
const boxFinds = (box: string): BoxFinds => {
  const b = BOXES.find((x) => x.box === box);
  if (!b?.trust) return { box, trust: null, count: 0, recent: [] };
  return {
    box,
    trust: b.trust,
    count: 7,
    recent: [
      { code: "AC-7Q2K", loggerCall: "OE6ABC", ts: NOW - 2 * 3600, site: "OE6XYZ-10" },
      { code: "AC-3MHT", loggerCall: "DL4FND-7", ts: NOW - 3 * DAY, site: "OE6XYZ-10" },
      { code: "AC-9WEZ", loggerCall: "OE3KLM", ts: NOW - 9 * DAY, site: "OE6XYZ-10" },
    ],
  };
};
type Route = [method: string, pattern: RegExp, answer: (m: RegExpMatchArray, persona: Persona) => unknown];
const page = <T extends object>(o: T) => ({ ...o, nextCursor: null, hasMore: false });

const ROUTES: Route[] = [
  [
    "GET",
    /^\/auth\/session$/,
    (_, p) => (p === "out" ? { callsign: null } : { callsign: ME, verified: true, email: "oe8apr@example.org" }),
  ],
  ["GET", /^\/api\/admin\/whoami$/, (_, p) => ({ sysop: p === "sysop", callsign: ME, configured: true })],
  ["GET", /^\/api\/prefs$/, () => ({ prefs: { seeded: true } })],
  ["PUT", /^\/api\/prefs$/, () => ({ ok: true, prefs: {} })],
  ["GET", /^\/api\/profile\/([^/]+)$/, (m) => PROFILE(decodeURIComponent(m[1] ?? ""))],
  [
    "GET",
    /^\/\.well-known\/aprscaching$/,
    () => ({
      instance: INSTANCE,
      signed: true,
      publicKey: "demo",
      aprsCall: ME,
      operator: ME,
      addresses: [
        { transport: "https", address: `https://${INSTANCE}` },
        { transport: "44net", address: "aprscaching.oe8apr.ampr.org" },
      ],
      peers: ["oe.aprscaching.org"],
    }),
  ],
  ["GET", /^\/\.well-known\/source$/, () => SOURCE],
  // a shared map view with the first cache open, so a frame can show the cache sheet (`?v=demo`)
  [
    "GET",
    /^\/v\/demo$/,
    () => ({
      slug: "demo",
      name: "Demo",
      ownerCall: ME,
      createdAt: NOW,
      state: { center: [15.4378, 47.0763], zoom: 15, selected: 1 },
    }),
  ],
  ["GET", /^\/api\/v1\/stats$/, () => ({ caches: 128, findsOnAirThisWeek: 23, stationsHeardLastHour: 41, at: NOW })],
  ["GET", /^\/api\/caches$/, () => ({ caches: MAP_CACHES })],
  ["GET", /^\/api\/caches\/(\d+)$/, (m) => ({ cache: DETAILS.get(Number(m[1])) ?? DETAILS.get(1) })],
  // a find logged from the app: located by the device, Tier B
  [
    "POST",
    /^\/api\/caches\/\d+\/logs$/,
    () =>
      ({
        logged: true,
        logType: "found",
        accountVerified: true,
        verified: true,
        tier: "B",
        method: "app_geo",
        distanceM: 6,
      }) satisfies LogResult,
  ],
  ["POST", /^\/keys\/register$/, () => ({ ok: true })],
  ["GET", /^\/api\/caches\/(\d+)\/logs$/, (m) => page({ logs: LOGS.filter((l) => l.cacheId === Number(m[1])) })],
  ["GET", /^\/api\/caches\/\d+\/stages$/, () => ({ stages: STAGES })],
  ["GET", /^\/api\/caches\/\d+\/media$/, () => ({ media: [] })],
  ["GET", /^\/api\/caches\/\d+\/adoption$/, () => ({ offer: null, requests: [], mine: null })],
  ["GET", /^\/api\/stations$/, () => ({ stations: STATIONS })],
  ["GET", /^\/api\/stations\/([^/]+)$/, () => ({ station: STATION_DETAIL })],
  ["GET", /^\/api\/stations\/[^/]+\/packets$/, () => ({ callsign: STATION_DETAIL.callsign, count: 0, packets: [] })],
  ["GET", /^\/api\/meshcom\/nodes$/, () => ({ exact: true, nodes: [] })],
  ["GET", /^\/api\/meshcom\/links$/, () => ({ exact: true, links: [] })],
  ["GET", /^\/api\/meshcom\/groups$/, () => ({ groups: MESHCOM_GROUPS })],
  [
    "GET",
    /^\/api\/meshcom\/groups\/([^/]+)\/messages$/,
    (m) => {
      const group = decodeURIComponent(m[1]!);
      return page({ group, messages: MESHCOM_GROUP_MESSAGES[group] ?? [] });
    },
  ],
  ["GET", /^\/api\/spots$/, () => ({ enabled: false, count: 0, fetchedAt: NOW, spots: [] })],
  ["GET", /^\/api\/search$/, () => SEARCH],
  ["GET", /^\/api\/activity$/, () => page({ activity: ACTIVITY })],
  ["GET", /^\/api\/leaderboard$/, () => ({ leaderboard: LEADERS })],
  ["GET", /^\/api\/corroborators$/, () => ({ period: "all", corroborators: CORROBORATORS })],
  ["GET", /^\/api\/messages$/, () => page({ messages: MESSAGES })],
  [
    "GET",
    /^\/api\/mailbox$/,
    () => ({
      sent: [
        {
          id: 2,
          from: "OE8APR-7",
          to: "OE6XRR",
          text: "QRV on the summit at 14z",
          via: "app",
          status: "held",
          deliveredTo: null,
          createdAt: NOW - 1800,
          expiresAt: NOW + 6 * 86400,
          deliveredAt: null,
          attempts: 0,
        },
        {
          id: 1,
          from: "OE8APR-7",
          to: "OE5XYZ",
          text: "thanks for the QSO",
          via: "radio",
          status: "delivered",
          deliveredTo: "OE5XYZ-9",
          createdAt: NOW - 86400,
          expiresAt: NOW + 5 * 86400,
          deliveredAt: NOW - 80000,
          attempts: 1,
        },
      ],
      received: [
        {
          id: 3,
          from: "OE6XRR-9",
          to: "OE8APR",
          text: "see you at the field day",
          via: "radio",
          status: "sent",
          deliveredTo: "OE8APR-7",
          createdAt: NOW - 3600,
          expiresAt: NOW + 6 * 86400,
          deliveredAt: null,
          attempts: 1,
        },
      ],
    }),
  ],
  ["GET", /^\/api\/adoptions$/, () => ({ adoptions: [] })],
  ["GET", /^\/api\/notify\/prefs$/, () => ({ digest: "weekly", hasEmail: true, pushConfigured: false })],
  // the near-cache radio message: off by default, and the switch flips it (a fixture sees no request body)
  ["GET", /^\/api\/near-radio$/, () => ({ on: nearRadio })],
  ["POST", /^\/api\/near-radio$/, () => ({ on: (nearRadio = !nearRadio) })],
  ["GET", /^\/api\/support$/, () => SUPPORT],
  ["GET", /^\/api\/support\/prefs$/, () => ({ supporter: true, hideNag: false })],
  ["GET", /^\/auth\/callsigns$/, () => ({ active: ME, callsigns: [{ callsign: ME, verified: true }] })],
  [
    "GET",
    /^\/auth\/passkeys$/,
    () => ({
      callsign: ME,
      hasEmail: true,
      passkeys: [
        { id: "demo-phone", createdAt: NOW - 86400 * 40, transports: ["internal", "hybrid"] },
        { id: "demo-key", createdAt: NOW - 86400 * 3, transports: ["usb", "nfc"] },
      ],
    }),
  ],
  [
    "GET",
    /^\/api\/keys$/,
    () => ({
      cap: 5,
      keys: [{ id: 1, name: "logbook sync", prefix: "acg_3f9c21d0", createdAt: NOW - 12 * DAY, lastUsedAt: NOW - DAY }],
    }),
  ],
  ["GET", /^\/api\/my\/stations$/, () => page({ stations: MY_STATIONS })],
  ["GET", /^\/api\/watch$/, () => ({ watching: [{ callsign: "OE6XRR-9", addedAt: NOW - 9 * DAY }], unseen: 2 })],
  ["GET", /^\/api\/watch\/alerts$/, () => page({ alerts: WATCH_ALERTS })],
  ["GET", /^\/api\/wx\/key$/, () => ({ key: null, lastSeen: null, ecowittPath: null, wuUrl: null })],
  [
    "GET",
    /^\/api\/licence\/([^/]+)$/,
    (m) =>
      ({
        callsign: decodeURIComponent(m[1] ?? ""),
        status: "licensed",
        sourceName: "Fernmeldebehörde (AT)",
        checkedAt: NOW - DAY,
      }) satisfies Licence,
  ],
  ["GET", /^\/api\/radio\/commands$/, () => ({ serviceCall: "OE8APR-15", commands: [] })],
  [
    "GET",
    /^\/verify\/methods$/,
    () => ({ methods: { rf_heard: true, ampr_dns: true, lotw: true }, rfSites: ["OE6XGR-10"] }) satisfies VerifyMethods,
  ],
  ["GET", /^\/api\/offline\/tiles$/, () => ({ url: null })],
  ["GET", /^\/api\/admin\/setup$/, () => SETUP],
  ["GET", /^\/api\/admin\/federation\/identity$/, () => IDENTITY],
  ["GET", /^\/api\/admin\/verifications$/, () => ({ verifications: [] })],
  [
    "GET",
    /^\/api\/admin\/adoptions$/,
    () => ({ noticeSec: 30 * DAY, withdrawn: [], offered: [], log: [] }) satisfies AdminAdoptions,
  ],
  ["GET", /^\/api\/admin\/moderation\/reports$/, () => ({ reports: [], counts: { open: 0, resolved: 0 } })],
  ["GET", /^\/api\/admin\/moderation\/log$/, () => ({ entries: [], nextBefore: null })],
  ["GET", /^\/api\/admin\/moderation\/accounts$/, () => ({ accounts: [] })],
  ["GET", /^\/api\/admin\/boxes$/, () => ({ boxes: BOXES, openCodes: [] })],
  ["GET", /^\/api\/admin\/sites$/, () => ({ sites: trustedStations() })],
  [
    "GET",
    /^\/api\/admin\/imports$/,
    () => ({
      places: [
        {
          id: 9001,
          code: "OC1A2B",
          title: "Am Schlossberg",
          source: "opencaching",
          sourceName: "Opencaching.de",
          externalId: "OC1A2B",
          status: "active",
        },
      ],
      removed: [],
    }),
  ],
  [
    "GET",
    /^\/api\/admin\/sites\/([^/]+)\/finds$/,
    (m) => {
      const site = decodeURIComponent(m[1] ?? "");
      const { count, recent } = boxFinds("oe6xyz-hill");
      return site === "OE6XGR-12"
        ? { site, count: 0, recent: [] }
        : { site, count: site === "OE6XGR-10" ? count + 5 : count, recent: recent.map((f) => ({ ...f, site })) };
    },
  ],
  ["GET", /^\/api\/admin\/boxes\/([^/]+)\/finds$/, (m) => boxFinds(decodeURIComponent(m[1] ?? ""))],
  [
    "POST",
    /^\/api\/admin\/boxes\/([^/]+)\/trust$/,
    (m) => {
      // the fixtures see no body: the switch flips, trusting the box's own call with SSID 10
      const b = BOXES.find((x) => x.box === decodeURIComponent(m[1] ?? ""));
      if (!b) return { trust: null };
      b.trust = b.trust
        ? null
        : { sites: [`${b.callsign ?? "OE6XGR"}-10`], trustedBy: "demo-sysop", trustedByCall: "OE6XGR", trustedAt: NOW };
      return { trust: b.trust };
    },
  ],
  [
    "POST",
    /^\/api\/admin\/boxes\/([^/]+)\/services$/,
    (m) => {
      // the fixtures see no body: the switch flips
      const b = BOXES.find((x) => x.box === decodeURIComponent(m[1] ?? ""));
      if (!b) return { services: false };
      b.services = !b.services;
      return { box: b.box, services: b.services };
    },
  ],
  [
    "GET",
    /^\/api\/admin\/federation\/sync$/,
    () => ({ hub: null, spokes: [], staleHours: 24 }) satisfies FederationSync,
  ],
  [
    "GET",
    /^\/federation\/peers$/,
    () => ({ self: { instance: "aprscaching.example", fingerprint: "3f2a 9c01 bb7e 4d10" }, peers: [] }),
  ],
  ["GET", /^\/api\/ports$/, () => ({ window: 3600, ports: PORTS })],
  ["GET", /^\/api\/bbs\/(messages|sent)$/, () => ({ messages: BBS.filter((b) => b.type === "P") })],
  ["GET", /^\/api\/bbs\/bulletins$/, () => ({ bulletins: BBS.filter((b) => b.type === "B") })],
  ["GET", /^\/api\/bbs\/partners$/, () => ({ partners: [] })],
  ["GET", /^\/api\/bbs\/forward$/, () => ({ rules: [] })],
  ["GET", /^\/api\/node\/nodes$/, () => ({ nodes: [] })],
  ["GET", /^\/api\/node\/mheard$/, () => ({ mheard: [] })],
];

/** The fixture answer for METHOD PATH, or undefined when the fixtures have none. */
export function fixtureAnswer(method: string, path: string, persona: Persona): unknown {
  for (const [m, re, answer] of ROUTES) {
    if (m !== method) continue;
    const hit = path.match(re);
    if (hit) return answer(hit, persona);
  }
  return undefined;
}

/** Answer the app's gateway requests from the fixtures; refuse third-party requests. */
export function installAppFixtures(persona: Persona, network = false): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url, location.href);
    if (url.origin !== location.origin && !/^https?:\/\/127\.0\.0\.1:8787$/.test(url.origin)) {
      if (network) return real(input, init);
      return new Response("third-party request refused by the demo fixtures", { status: 503 });
    }
    if (url.origin === location.origin && !/^\/(api|auth|verify|federation|\.well-known|keys|v)\b/.test(url.pathname))
      return real(input, init);
    const body = fixtureAnswer(req.method, url.pathname, persona);
    if (body === undefined) {
      if (req.method !== "GET") return Response.json({ ok: true });
      return Response.json({ error: `no fixture for ${req.method} ${url.pathname}` }, { status: 404 });
    }
    return Response.json(body);
  };
}
