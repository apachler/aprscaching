// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard ports' health, for `deploy/aprscaching doctor` (through `check.ts --soundcard`), and the
 * operator's deliberate PTT test (`check.ts --ptt-test`).
 *
 * The checks never key the radio: they look for the audio tools (ALSA's, or PulseAudio's for a port with
 * `SOUNDCARD_AUDIO=pulse`), open the capture device for a second and play 50 ms of silence on the playback
 * device (silence does not trip a VOX), load the port's modem (Direwolf's
 * WebAssembly build, so a box whose install lacks it shows up here), check that the PTT driver could open
 * (the package or tool is there, the device is writable, rigctld answers a TCP connect), read the watchdog
 * setting and ask the gateway whether the station calls are control-verified. A device the running ingest
 * holds reports as busy, which passes.
 *
 * The PTT test keys the transmitter for half a second, with no audio, and only when the port's transmit is on,
 * the gateway confirms every station call for this box, and a second of listening heard a clear channel. The
 * watchdog bounds it, and the PTT is released on every way out.
 */
import net from "node:net";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import type { DirewolfWasm } from "@aprscaching/direwolf";
import { s16Reader } from "./alsa.js";
import { audioCommand, audioHint, audioToolsProblem, type AudioBackend } from "./audioio.js";
import { stationCalls, type TxGateLookup } from "./callverify.js";
import { describePtt, openPtt, pttProblem, type Ptt, type PttDeps, type PttSpec } from "./ptt/index.js";
import { installPttRelease, trackPtt, untrackPtt } from "./ptt/release.js";
import { PttWatchdog } from "./ptt/watchdog.js";
import { soundcardPorts, type SoundcardPortSettings } from "./soundcardconfig.js";
import { describeModem, direwolfModem, openModem } from "./soundcardmodem.js";

export type CheckStatus = "pass" | "warn" | "fail";
/** One result; `kind` is alsa, pulse, audio, modem, ptt or tx, and `port` names the port (empty for the tools). */
export interface CheckRow {
  kind: "alsa" | "pulse" | "audio" | "modem" | "ptt" | "tx";
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

/** Capture `seconds` of audio, as raw S16_LE bytes. */
type ListenFn = (
  device: string,
  rate: number,
  seconds: number,
  audio?: AudioBackend,
) => { status: number | null; stdout: Buffer; stderr: string; error?: Error };

export interface CheckDeps {
  spawnSync?: SpawnSyncFn;
  /** The gateway's transmit gate for the box (callverify.ts); throws when it cannot be asked. */
  gate: TxGateLookup;
  listen?: ListenFn;
  pttDeps?: PttDeps;
  tcpOpen?: (host: string, port: number) => Promise<boolean>;
  openPtt?: (s: PttSpec) => Promise<Ptt>;
  sleep?: (ms: number) => Promise<void>;
  /** Where Direwolf's WebAssembly comes from; the package's own build when absent. */
  wasm?: DirewolfWasm;
}

/** Whether an ALSA tool's failure means the device is held by another process (the running ingest). */
const busy = (stderr: string) => /busy/i.test(stderr);

const defaultSpawnSync: SpawnSyncFn = (cmd, args, opts) =>
  nodeSpawnSync(cmd, args, { input: opts.input, timeout: opts.timeout, encoding: "utf8" });

const defaultListen: ListenFn = (device, rate, seconds, audio) => {
  const io = audioCommand({ audio, device, playback: device, rate }, "capture");
  if (io.cmd === "parec") {
    // parec has no duration: it runs until stopped, and a clean stop after `seconds` is the success
    const r = nodeSpawnSync(io.cmd, io.args, { timeout: seconds * 1000 + 300, maxBuffer: rate * 2 * (seconds + 1) });
    const stdout = r.stdout ?? Buffer.alloc(0);
    const stopped = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" && stdout.length > 0;
    return {
      status: stopped ? 0 : (r.status ?? 1),
      stdout,
      stderr: String(r.stderr ?? ""),
      error: stopped ? undefined : r.error,
    };
  }
  const r = nodeSpawnSync(io.cmd, [...io.args, "-d", String(seconds)], {
    timeout: (seconds + 4) * 1000,
    maxBuffer: rate * 2 * (seconds + 1),
  });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? ""), error: r.error };
};

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
  const missing = new Map<AudioBackend, string | null>();
  for (const backend of new Set(ports.map((p) => p.audio ?? "alsa"))) {
    const tools = audioToolsProblem(backend, (c, a) => spawnSync(c, a, { timeout: 5000 }));
    missing.set(backend, tools);
    const names = backend === "pulse" ? "parec and pacat" : "arecord and aplay";
    const fix =
      backend === "pulse"
        ? "pkg install pulseaudio (Termux) or apt install pulseaudio-utils"
        : "apt install alsa-utils";
    rows.push(
      tools
        ? { kind: backend, port: "", status: "fail", message: tools, fix }
        : { kind: backend, port: "", status: "pass", message: `${names} are installed`, fix: "" },
    );
  }
  for (const p of ports) {
    if (!missing.get(p.audio ?? "alsa")) rows.push(audioRow(p, spawnSync));
    rows.push(await modemRow(p, deps));
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
  const pulse = p.audio === "pulse";
  const capIo = audioCommand(p, "capture");
  // a second of capture: arecord stops itself after `-d 1`; parec runs until the timeout stops it, which passes
  const cap = pulse
    ? spawnSync(capIo.cmd, [...capIo.args, "/dev/null"], { timeout: 1000 })
    : spawnSync(capIo.cmd, [...capIo.args, "-d", "1", "/dev/null"], { timeout: 5000 });
  const capErr = String(cap.stderr ?? "");
  const capStopped = pulse && (cap.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (cap.status !== 0 && !capStopped && !busy(capErr))
    return row(
      "fail",
      `port ${p.name}: capture ${p.device} does not open: ${audioHint(capIo.cmd, cap.error ?? null, capErr)}`,
      pulse ? "check SOUNDCARD_DEVICE against pactl list short sources" : "check SOUNDCARD_DEVICE against arecord -l",
    );
  // 50 ms of silence: enough to open the device, nothing a VOX reacts to
  const silence = Buffer.alloc(Math.round(p.rate * 0.05) * 2);
  const playIo = audioCommand(p, "playback");
  const play = spawnSync(playIo.cmd, playIo.args, { input: silence, timeout: 5000 });
  const playErr = String(play.stderr ?? "");
  if (play.status !== 0 && !busy(playErr))
    return row(
      "fail",
      `port ${p.name}: playback ${p.playback} does not open: ${audioHint(playIo.cmd, play.error ?? null, playErr)}`,
      pulse ? "check SOUNDCARD_PLAYBACK against pactl list short sinks" : "check SOUNDCARD_PLAYBACK against aplay -l",
    );
  const held = busy(capErr) || busy(playErr) ? " (in use by the running ingest)" : "";
  return row(
    "pass",
    `port ${p.name}: ${p.device} opens for capture and ${p.playback} for playback at ${p.rate} Hz${held}`,
  );
}

async function modemRow(p: SoundcardPortSettings, deps: CheckDeps): Promise<CheckRow> {
  const row = (status: CheckStatus, message: string, fix = ""): CheckRow => ({
    kind: "modem",
    port: p.name,
    status,
    message,
    fix,
  });
  if (p.demod === "builtin") return row("pass", `port ${p.name}: ${describeModem(p)} (SOUNDCARD_DEMOD=builtin)`);
  try {
    await direwolfModem(p, deps.wasm);
    return row("pass", `port ${p.name}: ${describeModem(p)}`);
  } catch (e) {
    return row(
      "fail",
      `port ${p.name}: the Direwolf modem does not load: ${(e as Error).message}`,
      p.modem === "9600"
        ? "reinstall the ingest (pnpm install) so modems/direwolf/wasm is there"
        : "reinstall the ingest (pnpm install) so modems/direwolf/wasm is there, or set SOUNDCARD_DEMOD=builtin",
    );
  }
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
        : p.ptt.kind === "termux-usb"
          ? "install the Termux:API app and pkg install termux-api python, attach the interface, and check termux-usb -l"
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
  const g = await gateProblem(calls, deps.gate);
  if (g?.down)
    out.push(
      row(
        "warn",
        `port ${p.name}: the gateway did not confirm the station calls (${calls.join(", ")}): ${g.down}`,
        "check INGEST_URL (https for an enrolled box) and the box's credential",
      ),
    );
  else if (g)
    out.push(
      row(
        "warn",
        `port ${p.name}: ${g.call} ${g.reason}, so no frame goes out under it`,
        g.reason === "not control-verified"
          ? `verify ${g.call} in the app: You → Verify callsign`
          : "transmit under calls of the account that owns this box",
      ),
    );
  else out.push(row("pass", `port ${p.name}: the gateway confirms ${calls.join(", ")} for this box; transmit allowed`));
  return out;
}

/** What keeps `calls` from transmitting: the gateway is down, or a call is refused; null when all pass. */
async function gateProblem(
  calls: string[],
  gate: TxGateLookup,
): Promise<
  { down: string; call?: undefined; reason?: undefined } | { down?: undefined; call: string; reason: string } | null
> {
  let got: Map<string, { ok: boolean; reason?: string }>;
  try {
    got = await gate(calls);
  } catch (e) {
    return { down: (e as Error).message };
  }
  for (const c of calls) {
    const a = got.get(c.toUpperCase());
    if (!a?.ok) return { call: c, reason: a?.reason ?? "not confirmed" };
  }
  return null;
}

/**
 * Key one port's PTT for `ms` (at most 900), with no audio. Refused unless the port's transmit is on, the
 * gateway confirms every station call for this box, and the channel is clear: the test first listens for a
 * second with the port's own carrier detect. That needs the sound card, so the test runs with the ingest
 * stopped; the running box owns the card, the PTT and its transmit switch. Returns the line to print.
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
  const g = await gateProblem(calls, deps.gate);
  if (g?.down) return { ok: false, message: `refused: the gateway did not confirm the station calls (${g.down})` };
  if (g)
    return {
      ok: false,
      message:
        g.reason === "not control-verified"
          ? `refused: verify ${g.call} to transmit — control-verification required`
          : `refused: ${g.call} ${g.reason}`,
    };
  // listen before keying: a busy channel, or a sound card the running ingest holds, refuses the test
  const heard = (deps.listen ?? defaultListen)(p.device, p.rate, 1, p.audio);
  if (heard.status !== 0)
    return {
      ok: false,
      message: busy(heard.stderr)
        ? "refused: the sound card is in use; stop the ingest first (it owns the card, the PTT and the transmit switch)"
        : `refused: cannot listen on ${p.device}: ${audioHint(audioCommand(p, "capture").cmd, heard.error ?? null, heard.stderr)}`,
    };
  let rx;
  try {
    rx = await openModem(p, { wasm: deps.wasm });
  } catch (e) {
    return { ok: false, message: `refused: no carrier detect on port ${p.name}: ${(e as Error).message}` };
  }
  const pcm = s16Reader()(heard.stdout);
  let busyChannel = false;
  for (let i = 0; i < pcm.length; i += 480) {
    rx.push(pcm.subarray(i, i + 480));
    busyChannel ||= rx.dcd;
  }
  if (busyChannel) return { ok: false, message: "refused: the channel is busy (carrier detected); try again later" };
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
    await ptt.close().catch(() => ptt.releaseSync());
    untrackPtt(ptt);
  }
  return fault
    ? { ok: false, message: `PTT test on port ${p.name}: ${fault}` }
    : { ok: true, message: `PTT test on port ${p.name}: ${driver.label} keyed for ${keyMs} ms and released` };
}
