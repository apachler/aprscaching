// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard ports' health, for `deploy/aprscaching doctor` (through `check.ts --soundcard`), and the
 * operator's deliberate PTT test (`check.ts --ptt-test`).
 *
 * The checks never key the radio: they look for the ALSA tools, open the capture device for a second and play
 * 50 ms of silence on the playback device (silence does not trip a VOX), check that the PTT driver could open
 * (the package or tool is there, the device is writable, rigctld answers a TCP connect), read the watchdog
 * setting and ask the gateway whether the station calls are control-verified. A device the running ingest
 * holds reports as busy, which passes.
 *
 * The PTT test keys the transmitter for half a second, with no audio, and only when the port's transmit is on
 * and every station call it transmits under is verified. The watchdog bounds it, and the PTT is released on
 * every way out.
 */
import net from "node:net";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { alsaArgs, alsaHint, alsaToolsProblem } from "./alsa.js";
import { stationCalls } from "./callverify.js";
import { describePtt, openPtt, pttProblem, type Ptt, type PttDeps, type PttSpec } from "./ptt/index.js";
import { installPttRelease, trackPtt, untrackPtt } from "./ptt/release.js";
import { PttWatchdog } from "./ptt/watchdog.js";
import { soundcardPorts, type SoundcardPortSettings } from "./soundcardconfig.js";

export type CheckStatus = "pass" | "warn" | "fail";
/** One result; `kind` is alsa, audio, ptt or tx, and `port` names the port (empty for alsa). */
export interface CheckRow {
  kind: "alsa" | "audio" | "ptt" | "tx";
  port: string;
  status: CheckStatus;
  message: string;
  fix: string;
}

type SpawnSyncFn = (
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeout: number },
) => { status: number | null; stderr?: string | Buffer | null; error?: Error };

export interface CheckDeps {
  spawnSync?: SpawnSyncFn;
  /** Whether the gateway knows a call as control-verified; throws when it cannot be asked. */
  verified: (call: string) => Promise<boolean>;
  pttDeps?: PttDeps;
  tcpOpen?: (host: string, port: number) => Promise<boolean>;
  openPtt?: (s: PttSpec) => Promise<Ptt>;
  sleep?: (ms: number) => Promise<void>;
}

/** Whether an ALSA tool's failure means the device is held by another process (the running ingest). */
const busy = (stderr: string) => /busy/i.test(stderr);

const defaultSpawnSync: SpawnSyncFn = (cmd, args, opts) =>
  nodeSpawnSync(cmd, args, { input: opts.input, timeout: opts.timeout, encoding: "utf8" });

const defaultTcpOpen = (host: string, port: number) =>
  new Promise<boolean>((res) => {
    const s = net.connect(port, host);
    const done = (ok: boolean) => {
      s.destroy();
      res(ok);
    };
    s.setTimeout(3000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });

/** Every soundcard check for the ports in `env`; empty when there is no soundcard port. */
export async function soundcardChecks(env: Record<string, string | undefined>, deps: CheckDeps): Promise<CheckRow[]> {
  let ports: SoundcardPortSettings[];
  try {
    ports = soundcardPorts(env);
  } catch (e) {
    return [{ kind: "audio", port: "?", status: "fail", message: (e as Error).message, fix: "correct the setting" }];
  }
  if (!ports.length) return [];
  const spawnSync = deps.spawnSync ?? defaultSpawnSync;
  const rows: CheckRow[] = [];
  const tools = alsaToolsProblem((c, a) => spawnSync(c, a, { timeout: 5000 }));
  rows.push(
    tools
      ? { kind: "alsa", port: "", status: "fail", message: tools, fix: "apt install alsa-utils" }
      : { kind: "alsa", port: "", status: "pass", message: "arecord and aplay are installed", fix: "" },
  );
  for (const p of ports) {
    if (!tools) rows.push(audioRow(p, spawnSync));
    rows.push(await pttRow(p, deps));
    rows.push(...(await txRows(p, env, deps)));
  }
  return rows;
}

function audioRow(p: SoundcardPortSettings, spawnSync: SpawnSyncFn): CheckRow {
  const row = (status: CheckStatus, message: string, fix = ""): CheckRow => ({
    kind: "audio",
    port: p.name,
    status,
    message,
    fix,
  });
  const cap = spawnSync("arecord", [...alsaArgs(p.device, p.rate), "-d", "1", "/dev/null"], { timeout: 5000 });
  const capErr = String(cap.stderr ?? "");
  if (cap.status !== 0 && !busy(capErr))
    return row(
      "fail",
      `port ${p.name}: capture ${p.device} does not open: ${alsaHint("arecord", cap.error ?? null, capErr)}`,
      "check SOUNDCARD_DEVICE against arecord -l",
    );
  // 50 ms of silence: enough to open the device, nothing a VOX reacts to
  const silence = Buffer.alloc(Math.round(p.rate * 0.05) * 2);
  const play = spawnSync("aplay", alsaArgs(p.playback, p.rate), { input: silence, timeout: 5000 });
  const playErr = String(play.stderr ?? "");
  if (play.status !== 0 && !busy(playErr))
    return row(
      "fail",
      `port ${p.name}: playback ${p.playback} does not open: ${alsaHint("aplay", play.error ?? null, playErr)}`,
      "check SOUNDCARD_PLAYBACK against aplay -l",
    );
  const held = busy(capErr) || busy(playErr) ? " (in use by the running ingest)" : "";
  return row(
    "pass",
    `port ${p.name}: ${p.device} opens for capture and ${p.playback} for playback at ${p.rate} Hz${held}`,
  );
}

async function pttRow(p: SoundcardPortSettings, deps: CheckDeps): Promise<CheckRow> {
  const row = (status: CheckStatus, message: string, fix = ""): CheckRow => ({
    kind: "ptt",
    port: p.name,
    status,
    message,
    fix,
  });
  if (!p.tx) return row("pass", `port ${p.name}: receive only; the PTT is not used`);
  const what = describePtt(p.ptt);
  if (p.ptt.kind === "none") return row("pass", `port ${p.name}: no PTT line, the interface keys on audio (VOX)`);
  if (p.ptt.kind === "rigctld") {
    const ok = await (deps.tcpOpen ?? defaultTcpOpen)(p.ptt.host, p.ptt.port);
    return ok
      ? row("pass", `port ${p.name}: PTT ${what} answers`)
      : row("fail", `port ${p.name}: PTT ${what} does not answer`, "start rigctld, or correct SOUNDCARD_PTT");
  }
  const problem = await pttProblem(p.ptt, deps.pttDeps);
  if (!problem) return row("pass", `port ${p.name}: PTT ${what} is available`);
  const fix =
    p.ptt.kind === "serial" || p.ptt.kind === "cat"
      ? "install serialport, pass the device in, and add the user to dialout"
      : p.ptt.kind === "cm108"
        ? "check the device (ls /dev/hidraw*) and the udev rule that gives the ingest's user write access"
        : "install gpiod, and give the ingest's user access to the GPIO chip (group gpio)";
  return row("fail", `port ${p.name}: PTT ${what}: ${problem}`, fix);
}

async function txRows(
  p: SoundcardPortSettings,
  env: Record<string, string | undefined>,
  deps: CheckDeps,
): Promise<CheckRow[]> {
  const row = (status: CheckStatus, message: string, fix = ""): CheckRow => ({
    kind: "tx",
    port: p.name,
    status,
    message,
    fix,
  });
  if (!p.tx) return [row("pass", `port ${p.name}: transmit is off (SOUNDCARD_TX)`)];
  const out: CheckRow[] = [];
  out.push(
    p.pttMaxMs > 20_000
      ? row(
          "warn",
          `port ${p.name}: the PTT watchdog allows ${p.pttMaxMs} ms of key time`,
          "lower SOUNDCARD_PTT_MAX_MS; an APRS frame needs well under 10 s",
        )
      : row("pass", `port ${p.name}: the PTT watchdog releases the transmitter after ${p.pttMaxMs} ms`),
  );
  const calls = stationCalls(env, p.call);
  if (!calls.length) {
    out.push(row("fail", `port ${p.name}: no station call is set`, "set SOUNDCARD_CALL (or BOX_CALL) to your call"));
    return out;
  }
  const unverified = await firstUnverified(calls, deps.verified);
  if (unverified === undefined)
    out.push(
      row(
        "warn",
        `port ${p.name}: the gateway did not say whether the station calls (${calls.join(", ")}) are verified`,
        "check INGEST_URL",
      ),
    );
  else if (unverified)
    out.push(
      row(
        "warn",
        `port ${p.name}: ${unverified} is not control-verified, so the port does not transmit`,
        `verify ${unverified} in the app: You → Verify callsign`,
      ),
    );
  else out.push(row("pass", `port ${p.name}: ${calls.join(", ")} control-verified; transmit allowed`));
  return out;
}

/** The first unverified call, null when all are verified, undefined when the gateway could not be asked. */
async function firstUnverified(
  calls: string[],
  verified: (c: string) => Promise<boolean>,
): Promise<string | null | undefined> {
  for (const c of calls) {
    try {
      if (!(await verified(c))) return c;
    } catch {
      return undefined;
    }
  }
  return null;
}

/**
 * Key one port's PTT for `ms` (at most 900), with no audio. Refused unless the port's transmit is on and
 * every station call is verified. Returns the line to print.
 */
export async function pttTest(
  env: Record<string, string | undefined>,
  portName: string | undefined,
  deps: CheckDeps,
  ms = 500,
): Promise<{ ok: boolean; message: string }> {
  const ports = soundcardPorts(env);
  const p = portName ? ports.find((x) => x.name === portName) : ports[0];
  if (!p)
    return {
      ok: false,
      message: portName ? `no soundcard port named ${portName}` : "no soundcard port is set (SOUNDCARD_DEVICE)",
    };
  if (!p.tx) return { ok: false, message: `refused: transmit is off on port ${p.name} (set SOUNDCARD_TX=1)` };
  const calls = stationCalls(env, p.call);
  if (!calls.length) return { ok: false, message: "refused: no station call is set (SOUNDCARD_CALL or BOX_CALL)" };
  const unverified = await firstUnverified(calls, deps.verified);
  if (unverified === undefined)
    return { ok: false, message: "refused: the gateway could not confirm the call's verification" };
  if (unverified)
    return { ok: false, message: `refused: verify ${unverified} to transmit — control-verification required` };
  const keyMs = Math.min(900, Math.max(50, ms));
  installPttRelease();
  let fault: string | null = null;
  const driver = await (deps.openPtt ?? ((s) => openPtt(s, deps.pttDeps)))(p.ptt);
  const ptt = new PttWatchdog(driver, { maxKeyMs: 1000, onFault: (r) => (fault = r) });
  trackPtt(ptt);
  try {
    await ptt.key();
    await (deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(keyMs);
  } finally {
    await ptt.unkey().catch(() => {});
    await ptt.close().catch(() => {});
    untrackPtt(ptt);
  }
  return fault
    ? { ok: false, message: `PTT test on port ${p.name}: ${fault}` }
    : { ok: true, message: `PTT test on port ${p.name}: ${driver.label} keyed for ${keyMs} ms and released` };
}
