// SPDX-License-Identifier: MIT
// Packet decoder 1.1.0, built by scripts/build.mjs from tools/packet-decoder/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // vendor/aprscaching/packages/aprs/src/tnc2.ts
  function parseTNC2(line) {
    const s = line.trimEnd();
    if (!s || s.startsWith("#")) return null;
    const colon = s.indexOf(":");
    if (colon < 0) return null;
    const header = s.slice(0, colon);
    const payload = s.slice(colon + 1);
    const gt = header.indexOf(">");
    if (gt < 0) return null;
    const src = header.slice(0, gt);
    const rest = header.slice(gt + 1).split(",");
    const dst = rest[0] ?? "";
    const path = rest.slice(1);
    return { src, dst, path, payload, raw: s };
  }

  // vendor/aprscaching/packages/aprs/src/qconstruct.ts
  var RF_Q = /* @__PURE__ */ new Set(["qAR", "qAr", "qAo", "qAO"]);
  var NET_Q = /* @__PURE__ */ new Set(["qAC", "qAX", "qAU", "qAS", "qAI"]);
  function classifyQ(path) {
    for (let i = 0; i < path.length; i++) {
      const tok = path[i];
      if (RF_Q.has(tok)) return { heardVia: "rf", igateCall: path[i + 1] };
      if (NET_Q.has(tok)) return { heardVia: "aprs_is", igateCall: path[i + 1] };
    }
    return { heardVia: "aprs_is" };
  }

  // vendor/aprscaching/packages/aprs/src/geo.ts
  function isValidLatLon(lat, lon) {
    return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  // vendor/aprscaching/packages/aprs/src/sun.ts
  var RAD = Math.PI / 180;

  // vendor/aprscaching/packages/aprs/src/symbols.ts
  var PRIMARY = {
    "!": ["Police/Sheriff", "infra"],
    "#": ["Digipeater", "digi"],
    $: ["Phone", "infra"],
    "%": ["DX cluster", "infra"],
    "&": ["HF gateway", "digi"],
    "'": ["Small aircraft", "air"],
    "(": ["Mobile satellite station", "infra"],
    ")": ["Wheelchair", "vehicle"],
    "*": ["Snowmobile", "vehicle"],
    "+": ["Red Cross", "infra"],
    ",": ["Boy Scouts", "event"],
    "-": ["House (HF)", "station"],
    ".": ["X (unknown)", "other"],
    "/": ["Red dot", "other"],
    "0": ["Circle (number)", "other"],
    "<": ["Motorcycle", "vehicle"],
    "=": ["Railroad engine", "vehicle"],
    ">": ["Car", "vehicle"],
    A: ["Aid station", "infra"],
    B: ["BBS", "infra"],
    C: ["Canoe", "marine"],
    E: ["Eyeball (event)", "event"],
    F: ["Farm vehicle/tractor", "vehicle"],
    I: ["TCP/IP", "infra"],
    K: ["School", "infra"],
    O: ["Balloon", "air"],
    P: ["Police", "infra"],
    R: ["Recreational vehicle", "vehicle"],
    U: ["Bus", "vehicle"],
    V: ["ATV", "vehicle"],
    W: ["National weather service", "weather"],
    X: ["Helicopter", "air"],
    Y: ["Yacht/sailboat", "marine"],
    "[": ["Jogger", "station"],
    "^": ["Large aircraft", "air"],
    _: ["Weather station", "weather"],
    a: ["Ambulance", "vehicle"],
    b: ["Bicycle", "vehicle"],
    f: ["Fire truck", "vehicle"],
    g: ["Glider", "air"],
    h: ["Hospital", "infra"],
    j: ["Jeep", "vehicle"],
    k: ["Truck", "vehicle"],
    l: ["Laptop", "station"],
    m: ["Mic-E repeater", "digi"],
    n: ["Node", "infra"],
    o: ["EOC", "infra"],
    p: ["Dog/rover", "station"],
    r: ["Antenna/repeater", "digi"],
    s: ["Ship/power boat", "marine"],
    t: ["Truck stop", "infra"],
    u: ["Truck (18-wheeler)", "vehicle"],
    v: ["Van", "vehicle"],
    y: ["Yagi at QTH", "station"],
    "<>": ["", ""]
  };
  var ALTERNATE = {
    "!": ["Emergency", "event"],
    "#": ["Overlay digipeater", "digi"],
    "&": ["Overlay gateway", "digi"],
    "(": ["Cloudy", "weather"],
    "*": ["Snow", "weather"],
    "<": ["Gale/storm", "weather"],
    ">": ["Overlay car", "vehicle"],
    A: ["Overlay box", "other"],
    O: ["Rocket", "air"],
    W: ["Flooding", "weather"],
    _: ["Weather (alt)", "weather"],
    n: ["Overlay triangle", "other"],
    s: ["Overlay ship", "marine"],
    u: ["Overlay truck", "vehicle"]
  };
  function lookupSymbol(table, code) {
    const isPrimary = table === "/";
    const isAlt = table === "\\";
    const overlay = !isPrimary && !isAlt ? table : void 0;
    const map = isPrimary ? PRIMARY : ALTERNATE;
    const hit = map[code];
    if (hit && hit[0]) return { table, code, label: hit[0], category: hit[1], overlay };
    return { table, code, label: `Symbol ${table}${code}`, category: "other", overlay };
  }

  // vendor/aprscaching/packages/aprs/src/compressed.ts
  var d = (c) => c.charCodeAt(0) - 33;
  function isCompressedLead(c) {
    return c === "/" || c === "\\" || c >= "A" && c <= "Z" || c >= "a" && c <= "j";
  }
  function parseCompressed(s) {
    if (s.length < 13 || !isCompressedLead(s[0])) return null;
    for (let i = 1; i <= 8; i++) {
      const v = d(s[i]);
      if (v < 0 || v > 90) return null;
    }
    const y = d(s[1]) * 753571 + d(s[2]) * 8281 + d(s[3]) * 91 + d(s[4]);
    const x = d(s[5]) * 753571 + d(s[6]) * 8281 + d(s[7]) * 91 + d(s[8]);
    const lat = 90 - y / 380926;
    const lon = -180 + x / 190463;
    const table = s[0], code = s[9];
    const c = s[10], cc = s[11], t = s[12];
    const fix = { lat, lon, table, code };
    if (c !== " ") {
      const tByte = t.charCodeAt(0) - 33;
      if ((tByte & 24) === 16) {
        const alt = Math.pow(1.002, d(c) * 91 + d(cc));
        fix.altitudeM = Math.round(alt * 0.3048 * 10) / 10;
      } else if (d(c) >= 0 && d(c) <= 89) {
        fix.course = d(c) * 4;
        fix.speedKn = Math.round((Math.pow(1.08, d(cc)) - 1) * 10) / 10;
      } else if (c === "{") {
        fix.rangeKm = Math.round(2 * Math.pow(1.08, d(cc)) * 1.609 * 10) / 10;
      }
    }
    return fix;
  }

  // vendor/aprscaching/packages/aprs/src/mice.ts
  var STD_MSG = ["Emergency", "Priority", "Special", "Committed", "Returning", "In Service", "En Route", "Off Duty"];
  var CUSTOM_MSG = ["Emergency", "Custom-6", "Custom-5", "Custom-4", "Custom-3", "Custom-2", "Custom-1", "Custom-0"];
  function decodeDest(dest) {
    const call = dest.split("-")[0];
    if (call.length < 6) return null;
    const digits = [], mbits = [];
    let custom = false, ambiguity = 0;
    let north = false, lonOffset = false, west = false;
    for (let i = 0; i < 6; i++) {
      const c = call[i];
      let digit = 0, mbit = 0, high = false, space = false;
      if (c >= "0" && c <= "9") {
        digit = c.charCodeAt(0) - 48;
      } else if (c >= "A" && c <= "J") {
        digit = c.charCodeAt(0) - 65;
        mbit = 1;
        custom = true;
      } else if (c === "K") {
        space = true;
        mbit = 1;
        custom = true;
      } else if (c === "L") {
        space = true;
        mbit = 0;
      } else if (c >= "P" && c <= "Y") {
        digit = c.charCodeAt(0) - 80;
        mbit = 1;
        high = true;
      } else if (c === "Z") {
        space = true;
        mbit = 1;
        high = true;
      } else return null;
      if (space) ambiguity++;
      digits.push(digit);
      mbits.push(mbit);
      if (i === 3) north = high;
      if (i === 4) lonOffset = high;
      if (i === 5) west = high;
    }
    return { digits, mbits, custom, north, lonOffset, west, ambiguity };
  }
  function decodeMicE(dest, info) {
    const dd = decodeDest(dest);
    if (!dd || info.length < 9) return null;
    const [d0, d1, d2, d3, d4, d5] = dd.digits;
    const latDeg = d0 * 10 + d1;
    const latMin = d2 * 10 + d3 + (d4 * 10 + d5) / 100;
    if (latMin >= 60) return null;
    let lat = latDeg + latMin / 60;
    if (!dd.north) lat = -lat;
    let lonDeg = info.charCodeAt(1) - 28;
    if (dd.lonOffset) lonDeg += 100;
    if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
    else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
    let lonMin = info.charCodeAt(2) - 28;
    if (lonMin >= 60) lonMin -= 60;
    const lonHund = info.charCodeAt(3) - 28;
    if (lonDeg < 0 || lonMin < 0 || lonHund < 0 || lonHund > 99 || lonMin + lonHund / 100 >= 60) return null;
    let lon = lonDeg + (lonMin + lonHund / 100) / 60;
    if (dd.west) lon = -lon;
    if (!isValidLatLon(lat, lon)) return null;
    const sp = info.charCodeAt(4) - 28, dc = info.charCodeAt(5) - 28, se = info.charCodeAt(6) - 28;
    let speedKn = sp * 10 + Math.floor(dc / 10);
    let course = dc % 10 * 100 + se;
    if (speedKn >= 800) speedKn -= 800;
    if (course >= 400) course -= 400;
    const code = info[7] ?? "/";
    const table = info[8] ?? "/";
    const msgNum = dd.mbits[0] << 2 | dd.mbits[1] << 1 | dd.mbits[2];
    const messageType = (dd.custom ? CUSTOM_MSG : STD_MSG)[msgNum];
    const fix = {
      lat: round(lat),
      lon: round(lon),
      table,
      code,
      course,
      speedKn,
      messageType,
      ambiguity: dd.ambiguity
    };
    const rest = info.slice(9);
    const altM = /(.)(.)(.)}/.exec(rest);
    if (altM && rest.indexOf("}") === 3) {
      const a = (altM[1].charCodeAt(0) - 33) * 8281 + (altM[2].charCodeAt(0) - 33) * 91 + (altM[3].charCodeAt(0) - 33);
      fix.altitudeM = a - 1e4;
      fix.comment = rest.slice(4).trim() || void 0;
    } else if (rest.trim()) {
      fix.comment = rest.trim();
    }
    return fix;
  }
  var round = (n) => Math.round(n * 1e6) / 1e6;

  // vendor/aprscaching/packages/aprs/src/decode.ts
  var UNCOMP_RE = /^(\d{2})([0-7 ][0-9 ]\.[0-9 ]{2})([NS])(.)(\d{3})([0-7 ][0-9 ]\.[0-9 ]{2})([EW])(.)/;
  function parseUncompressed(s) {
    const m = UNCOMP_RE.exec(s);
    if (!m) return null;
    const [whole, latDeg, latMin, ns, table, lonDeg, lonMin, ew, code] = m;
    const ambiguity = (latMin.match(/ /g)?.length ?? 0) + (lonMin.match(/ /g)?.length ?? 0);
    const latMinNum = Number(latMin.replace(/ /g, "0"));
    const lonMinNum = Number(lonMin.replace(/ /g, "0"));
    if (!(latMinNum < 60 && lonMinNum < 60)) return null;
    let lat = Number(latDeg) + latMinNum / 60;
    let lon = Number(lonDeg) + lonMinNum / 60;
    if (ns === "S") lat = -lat;
    if (ew === "W") lon = -lon;
    if (!isValidLatLon(lat, lon)) return null;
    const fix = { lat: round2(lat), lon: round2(lon), symbol: lookupSymbol(table, code), ambiguity };
    return { fix, rest: s.slice(whole.length) };
  }
  function applyExtensions(fix, comment) {
    const cs = /^(\d{3})\/(\d{3})/.exec(comment);
    if (cs) {
      fix.course = Number(cs[1]);
      fix.speedKn = Number(cs[2]);
      comment = comment.slice(7);
    }
    const alt = /\/A=(-\d{5,6}|\d{6})/.exec(comment);
    if (alt) {
      fix.altitudeM = Math.round(Number(alt[1]) * 0.3048);
      comment = comment.replace(alt[0], "");
    }
    const c = comment.trim();
    if (c) fix.comment = c;
  }
  function parseWeather(s) {
    const wx = {};
    const num = (re, scale = 1) => {
      const m = re.exec(s);
      return m && m[1] !== "..." ? Number(m[1]) * scale : void 0;
    };
    const head = /^[/_]?(\d{3})\/(\d{3})/.exec(s) ?? /^(\d{3})\/(\d{3})/.exec(s);
    if (head) {
      wx.windDirDeg = Number(head[1]);
      wx.windKn = Number(head[2]);
    }
    const g = num(/g(\d{3})/);
    if (g !== void 0) wx.gustKn = g;
    const t = /t(-?\d{2,3})/.exec(s);
    if (t) wx.tempC = Math.round((Number(t[1]) - 32) * 5 / 9 * 10) / 10;
    const r = num(/r(\d{3})/, 0.254);
    if (r !== void 0) wx.rain1hMm = round2(r);
    const p = num(/p(\d{3})/, 0.254);
    if (p !== void 0) wx.rain24hMm = round2(p);
    const P = num(/P(\d{3})/, 0.254);
    if (P !== void 0) wx.rainMidnightMm = round2(P);
    const h = /h(\d{2})/.exec(s);
    if (h) wx.humidity = Number(h[1]) === 0 ? 100 : Number(h[1]);
    const b = num(/b(\d{5})/, 0.1);
    if (b !== void 0) wx.pressureHpa = round2(b);
    return wx;
  }
  var isWeather = (s) => /^[/_]?\d{3}\/\d{3}/.test(s) && /[tgrph]/.test(s);
  function decodeAprs(frame) {
    const p = frame.payload;
    const t = p[0] ?? "";
    if ((t === "`" || t === "'" || t === "" || t === "") && frame.dst) {
      const me = decodeMicE(frame.dst, p);
      if (me)
        return {
          kind: "position",
          lat: me.lat,
          lon: me.lon,
          symbol: lookupSymbol(me.table, me.code),
          course: me.course,
          speedKn: me.speedKn,
          altitudeM: me.altitudeM,
          comment: me.comment,
          ambiguity: me.ambiguity,
          messageType: me.messageType
        };
    }
    switch (t) {
      case "!":
      case "=":
      case "@":
      case "/": {
        let body = p.slice(1), timestamp;
        if (t === "@" || t === "/") {
          timestamp = body.slice(0, 7);
          body = body.slice(7);
        }
        return decodePosition(body, timestamp);
      }
      case ";":
        return decodeObject(p);
      case ")":
        return decodeItem(p);
      case ":":
        return decodeMessage(p);
      case ">":
        return { kind: "status", text: p.slice(1).trim() };
      case "_": {
        return { kind: "weather", ...parseWeather(p.slice(9)) };
      }
      case "T": {
        return decodeTelemetry(p);
      }
      default:
        return { kind: "other" };
    }
  }
  function decodePosition(body, timestamp) {
    let fix = null, rest = "";
    const comp = parseCompressed(body);
    if (comp && isValidLatLon(comp.lat, comp.lon)) {
      fix = {
        lat: round2(comp.lat),
        lon: round2(comp.lon),
        symbol: lookupSymbol(comp.table, comp.code),
        course: comp.course,
        speedKn: comp.speedKn,
        altitudeM: comp.altitudeM
      };
      rest = body.slice(13);
    } else {
      const u = parseUncompressed(body);
      if (u) {
        fix = u.fix;
        rest = u.rest;
      }
    }
    if (!fix) return { kind: "other" };
    if (timestamp) fix.timestamp = timestamp;
    if (fix.symbol?.code === "_" && isWeather(rest))
      return { kind: "weather", lat: fix.lat, lon: fix.lon, symbol: fix.symbol, ...parseWeather(rest) };
    applyExtensions(fix, rest);
    return { kind: "position", ...fix };
  }
  function posFields(pos) {
    if (pos.kind !== "position") return {};
    const { kind, ...fields } = pos;
    return fields;
  }
  function decodeObject(p) {
    const name = p.slice(1, 10).trim();
    const alive = p[10] === "*";
    const body = p.slice(11).slice(7);
    return { kind: "object", name, alive, ...posFields(decodePosition(body)) };
  }
  function decodeItem(p) {
    const m = /^\)([^!_]{3,9})([!_])(.*)$/s.exec(p);
    if (!m) return { kind: "other" };
    return { kind: "item", name: m[1].trim(), alive: m[2] === "!", ...posFields(decodePosition(m[3])) };
  }
  function decodeMessage(p) {
    const m = /^:(.{9}):(.*)$/s.exec(p);
    if (!m) return { kind: "other" };
    const addressee = m[1].trim();
    const text = m[2];
    const out = { kind: "message", addressee, text };
    if (/^ack/.test(text)) {
      out.ack = true;
      out.msgNo = text.slice(3).trim();
      out.text = "";
      return out;
    }
    if (/^rej/.test(text)) {
      out.rej = true;
      out.msgNo = text.slice(3).trim();
      out.text = "";
      return out;
    }
    const brace = text.indexOf("{", text.lastIndexOf("}") + 1);
    if (brace >= 0 && brace < text.length - 1) {
      out.msgNo = text.slice(brace + 1);
      out.text = text.slice(0, brace);
    }
    if (/^(BLN|NWS|SKY)/.test(addressee)) out.bulletin = addressee;
    return out;
  }
  var LINE_BREAK = /[\n\r\u2028\u2029]/;
  function decodeTelemetry(p) {
    const s = p.slice(1);
    if (LINE_BREAK.test(s)) return { kind: "telemetry", analog: [], digital: [] };
    let i = s[0] === "#" ? 1 : 0;
    const seqStart = i;
    while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
    const seq = i > seqStart ? Number(s.slice(seqStart, i)) : void 0;
    if (s[i] === ",") i++;
    const parts = s.slice(i).split(",");
    const analog = parts.slice(0, 5).map(Number).filter((n) => !Number.isNaN(n));
    const bits = parts[5] ?? "";
    const digital = /^[01]{1,8}$/.test(bits) ? [...bits].map((b) => b === "1") : [];
    return { kind: "telemetry", seq, analog, digital };
  }
  var round2 = (n) => Math.round(n * 1e6) / 1e6;

  // vendor/aprscaching/packages/aprs/src/ax25.ts
  function crcTable(poly, xor = 0) {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? c >>> 1 ^ poly : c >>> 1;
      t[i] = c ^ xor;
    }
    return t;
  }
  var SMACK_TABLE = crcTable(40961);
  var FLEX_TABLE = crcTable(33800, 3975);

  // vendor/aprscaching/packages/aprs/src/meshcom/parse.ts
  var utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

  // vendor/aprscaching/packages/aprs/src/meshcom/encode.ts
  var utf82 = new TextEncoder();

  // lib/aprs-decode.js
  var PACKET_SAMPLE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";
  function decodeAprsLine(input) {
    const raw = String(input).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
    if (!raw) return { ok: false, error: "Paste a raw TNC2 or APRS-IS line." };
    const frame = parseTNC2(raw);
    if (!frame) return { ok: false, error: "Not a TNC2 line: expected SOURCE>DEST,PATH:payload." };
    const q = classifyQ(frame.path);
    const data = decodeAprs(frame);
    return {
      ok: true,
      frame: {
        src: frame.src,
        dst: frame.dst,
        path: frame.path,
        payload: frame.payload,
        heardVia: q.heardVia,
        ...q.igateCall ? { igateCall: q.igateCall } : {}
      },
      data
    };
  }
  function aprsFields(data) {
    const out = [];
    for (const [k, v] of Object.entries(data)) {
      if (k === "kind" || v == null) continue;
      if (typeof v === "object") {
        const str = (x) => typeof x === "string" ? x : "";
        if (k === "symbol" && typeof v.label === "string") {
          out.push([k, `${v.label} (${str(v.table)}${str(v.code)})`]);
          continue;
        }
        out.push([k, JSON.stringify(v)]);
      } else out.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
    }
    return out;
  }

  // tools/packet-decoder/src/index.js
  var VIA = {
    rf: { text: "RF", tone: "ok" },
    aprs_is: { text: "APRS-IS", tone: "muted" }
  };
  function show(r) {
    if (!r.ok) {
      tool.setPanel({ title: "Packet decoder", nodes: [{ kind: "text", text: r.error, tone: "bad" }] });
      return r.error;
    }
    const { frame, data } = r;
    const via = VIA[frame.heardVia] ?? { text: String(frame.heardVia), tone: "default" };
    const fields = aprsFields(data);
    tool.setPanel({
      title: "Packet decoder",
      nodes: [
        { kind: "kv", key: "Source", value: frame.src, tone: "accent" },
        { kind: "kv", key: "Destination", value: frame.dst },
        { kind: "kv", key: "Path", value: frame.path.join(" · ") || "(no path)" },
        { kind: "kv", key: "Heard via", value: frame.igateCall ? `${via.text} (${frame.igateCall})` : via.text },
        { kind: "badge", text: String(data.kind), tone: via.tone },
        ...fields.length ? [{ kind: "table", head: ["Field", "Value"], rows: fields }] : []
      ]
    });
    return `${frame.src} > ${frame.dst}: ${data.kind}, ${fields.length} field${fields.length === 1 ? "" : "s"} in the Packet decoder panel.`;
  }
  tool.setPanel({
    title: "Packet decoder",
    nodes: [{ kind: "text", text: "Paste a raw TNC2 or APRS-IS line into Decode.", tone: "muted" }]
  });
  register({
    decoders: [
      {
        id: "aprs",
        label: "APRS packet",
        kind: "aprs",
        decode: (input) => show(decodeAprsLine(input)),
        sample: PACKET_SAMPLE,
        placeholder: "paste a raw TNC2 / APRS-IS line…"
      }
    ]
  });
})();
