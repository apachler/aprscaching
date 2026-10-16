// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT through a USB radio interface on an Android phone (the Digirig, the AIOC, a CM108 dongle), for a Pocket
 * station whose soundcard port runs in Termux. Termux reaches no /dev/tty* or /dev/hidraw* without root;
 * Android grants USB access per app, and Termux:API's `termux-usb -e <command> <device>` runs a command with a
 * file descriptor for the device. The command is the helper `deploy/pocket/extras/usb_ptt.py`, which keys the
 * line with usbfs control transfers: a CDC-ACM, CP210x, FTDI or CH340 serial line, or a CM108 GPIO.
 *
 * The driver runs one helper per port and speaks its line protocol: `KEY`, `UNKEY` and `QUIT` on its stdin,
 * each answered `OK` or `ERR <reason>` on its stderr (termux-usb captures the command's stdout until it exits),
 * after a first `READY <what it drives>`. One request is in flight at a time and each is bounded; a helper that
 * does not answer in time is stopped. The helper unkeys on its own whenever its input ends, so the radio drops
 * when the ingest exits or dies, and it holds a watchdog of its own behind the port's. A helper that exits
 * once the line is confirmed unkeyed is started again in the background, with a backoff (a replugged interface
 * comes back under a new device path, found again when the setting is `auto`); a key meanwhile is refused at
 * once, so a transmission never waits on a restart. A helper that exits while the line may be keyed fails the
 * unkey, so the port's watchdog latches its fault.
 */
import fs from "node:fs";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Ptt, PttSpec } from "./types.js";

type TermuxUsbSpec = Extract<PttSpec, { kind: "termux-usb" }>;

/** The part of a ChildProcess the driver uses. */
export interface UsbPttChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  stdin: { write(s: string): boolean; end(): void; on(event: "error", cb: (e: Error) => void): unknown } | null;
  stdout: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "close", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}
export type UsbPttSpawn = (cmd: string, args: string[]) => UsbPttChild;
interface RunResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}
/** Runs a short command to its end (`termux-usb -l`, `python3 --version`), synchronously or not. */
type RunFn = (cmd: string, args: string[]) => RunResult | Promise<RunResult>;

/** The helper, beside the checkout's other Pocket scripts. */
const HELPER = fileURLToPath(new URL("../../../../deploy/pocket/extras/usb_ptt.py", import.meta.url));
/** How long the helper may take to answer READY: termux-usb's permission dialog waits 30 s for a tap. */
const READY_MS = 35_000;
/** How long one KEY or UNKEY may wait for its answer (a control transfer times out after 1 s). */
const REPLY_MS = 1500;
/** The helper's own watchdog when the port names none. */
const HELPER_MAX_KEY_MS = 15_000;
/** The backoff between restarts of a helper that exited. */
const RESTART_MS = { first: 1000, cap: 30_000 };

const defaultSpawn: UsbPttSpawn = (cmd, args) =>
  // its own process group, so a stop reaches the helper under termux-usb's shells too
  nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
/** Termux:API's commands hang while its app does not answer; give up after 8 s, as the Pocket scripts do. */
const defaultRun: RunFn = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { encoding: "utf8", timeout: 8000 }, (error, stdout, stderr) =>
      resolve({
        status: error ? null : 0,
        stdout,
        stderr,
        error: error ?? undefined,
      }),
    ),
  );

/** The spec with the helper's watchdog set just behind the port's (`SOUNDCARD_PTT_MAX_MS`). */
export function withPttMax(s: PttSpec, pttMaxMs: number): PttSpec {
  return s.kind === "termux-usb" ? { ...s, maxKeyMs: pttMaxMs + 2000 } : s;
}

/** The devices `termux-usb -l` lists; throws with the fix when it cannot be asked. */
async function listDevices(run: RunFn): Promise<string[]> {
  const r = await run("termux-usb", ["-l"]);
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    throw new Error("termux-usb not found: install the Termux:API app, then pkg install termux-api");
  if (r.error || r.status !== 0)
    throw new Error(
      `termux-usb -l did not answer (${r.error?.message ?? `exit ${r.status}`}): open the Termux:API app once`,
    );
  try {
    const list: unknown = JSON.parse(String(r.stdout ?? "").trim() || "[]");
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
  } catch {
    throw new Error(`termux-usb -l answered something else than a device list: ${String(r.stdout).slice(0, 80)}`);
  }
}

/** The device to open: the one named, or the only one attached. */
async function resolveDevice(s: TermuxUsbSpec, run: RunFn): Promise<string> {
  const list = await listDevices(run);
  if (s.device !== "auto") {
    if (!list.includes(s.device))
      throw new Error(
        `${s.device} is not attached (termux-usb -l lists ${list.join(", ") || "nothing"}); a replugged interface gets a new path, or use auto`,
      );
    return s.device;
  }
  if (list.length === 1) return list[0]!;
  if (!list.length) throw new Error("no USB device is attached (a USB-C OTG adapter may be needed)");
  throw new Error(`several USB devices are attached (${list.join(", ")}): name the radio interface's path`);
}

/** The command termux-usb runs; it appends the descriptor. termux-callback splits it at spaces, unquoted. */
export function helperCommand(s: TermuxUsbSpec, helper = HELPER): string {
  if (/\s/.test(helper)) throw new Error(`the helper's path holds a space, which termux-usb cannot pass: ${helper}`);
  const maxKey = Math.ceil((s.maxKeyMs ?? HELPER_MAX_KEY_MS) / 1000);
  return ["python3", helper, "--method", s.method, "--gpio", String(s.gpio), "--max-key", String(maxKey)].join(" ");
}

interface Waiter {
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

/** One running helper. */
interface Helper {
  child: UsbPttChild;
  device: string;
  /** Running and taking commands: false once it exits or is told to stop. */
  alive: boolean;
  label: string;
  waiter: Waiter | null;
  /** Resolves once the helper has exited and its output is read. */
  closed: Promise<void>;
}

const tail = (s: string) => (s.length > 2048 ? s.slice(-2048) : s);

/** Whether `p` settles within `ms`. */
function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    void p.then(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export async function openTermuxUsbPtt(
  o: TermuxUsbSpec,
  deps: {
    spawn?: UsbPttSpawn;
    run?: RunFn;
    helper?: string;
    readyMs?: number;
    replyMs?: number;
    restartMs?: { first: number; cap: number };
  } = {},
): Promise<Ptt> {
  const spawn = deps.spawn ?? defaultSpawn;
  const run = deps.run ?? defaultRun;
  const restartMs = deps.restartMs ?? RESTART_MS;
  const helperPath = deps.helper ?? HELPER;
  const readyMs = deps.readyMs ?? READY_MS;
  const replyMs = deps.replyMs ?? REPLY_MS;
  const command = helperCommand(o, helperPath);
  let h: Helper | null = null;
  /** Whether the line may be keyed: from a KEY sent until an UNKEY is confirmed. */
  let keyed = false;
  let closed = false;
  let restarting = false;
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  const stopHelper = (x: Helper, signal: NodeJS.Signals) => {
    x.alive = false;
    x.child.stdin?.end();
    try {
      if (x.child.pid) process.kill(-x.child.pid, signal);
      else x.child.kill(signal);
    } catch {
      x.child.kill(signal);
    }
  };

  /** Wait for the helper's next answer: resolves on OK or READY, rejects on ERR, on exit and after `ms`. */
  const answer = (x: Helper, ms: number, what: string) =>
    new Promise<string>((resolve, reject) => {
      if (!x.alive) return reject(new Error(`the USB PTT helper is not running`));
      const t = setTimeout(() => {
        x.waiter = null;
        stopHelper(x, "SIGTERM"); // a helper that does not answer is stopped; it unkeys on the way out
        reject(new Error(`the USB PTT helper did not answer ${what} within ${ms} ms`));
      }, ms);
      x.waiter = {
        resolve: (text) => {
          clearTimeout(t);
          resolve(text);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });

  const start = async (): Promise<Helper> => {
    if (!fs.existsSync(helperPath)) throw new Error(`the USB PTT helper is missing: ${helperPath}`);
    const device = await resolveDevice(o, run);
    const child = spawn("termux-usb", ["-r", "-e", command, device]);
    let onClosed = () => {};
    const closedP = new Promise<void>((res) => (onClosed = res));
    const x: Helper = { child, device, alive: true, label: "", waiter: null, closed: closedP };
    let errBuf = "";
    let errTail = "";
    let outTail = "";
    const settle = (fn: (w: Waiter) => void) => {
      const w = x.waiter;
      x.waiter = null;
      if (w) fn(w);
    };
    child.stderr?.on("data", (b) => {
      errBuf += b.toString();
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const line = errBuf.slice(0, i).trim();
        errBuf = errBuf.slice(i + 1);
        if (/^UNKEYED\b/.test(line))
          keyed = false; // the unkey on its way out went through
        else if (/^(READY|OK)\b/.test(line)) settle((w) => w.resolve(line.replace(/^\w+\s*/, "")));
        else if (/^ERR\b/.test(line)) settle((w) => w.reject(new Error(line.replace(/^ERR\s*/, ""))));
        else if (/^WATCHDOG\b/.test(line)) {
          keyed = false;
          console.error("[ptt] USB PTT helper: %s", line);
        } else if (line) {
          errTail = tail(`${errTail}${line}\n`);
          console.error("[ptt] USB PTT helper: %s", line);
        }
      }
    });
    // termux-usb's own messages (Permission denied., No such device.) come out on stdout as it exits
    child.stdout?.on("data", (b) => (outTail = tail(outTail + b.toString())));
    child.stdin?.on("error", () => {
      /* the helper exited; its exit reports why */
    });
    const gone = (why: string) => {
      x.alive = false;
      const said = (outTail.trim() || errTail.trim()).split("\n").pop();
      settle((w) => w.reject(new Error(`the USB PTT helper exited (${said || why})`)));
    };
    child.on("error", (e) => {
      gone(e.message);
      onClosed();
    });
    child.on("exit", (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code}`));
    child.on("close", () => {
      gone("closed");
      onClosed();
      // the port's helper gone with the line confirmed unkeyed: bring it back for the next transmission
      if (x === h && !keyed) restart();
    });
    try {
      x.label = await answer(x, readyMs, "READY");
    } catch (e) {
      stopHelper(x, "SIGTERM");
      throw e;
    }
    return x;
  };

  /** Send one command to a running helper and wait for its OK. */
  const request = async (x: Helper, cmd: "KEY" | "UNKEY" | "QUIT"): Promise<void> => {
    const reply = answer(x, replyMs, cmd);
    x.child.stdin?.write(`${cmd}\n`);
    await reply;
  };

  h = await start();
  let label = `termux-usb ${h.device}: ${h.label}`;

  /** Start the helper again until one runs, with a backoff; never while the line may be keyed. */
  const restart = () => {
    if (closed || restarting) return;
    restarting = true;
    void (async () => {
      let wait = restartMs.first;
      while (!closed && !keyed && !h?.alive) {
        await new Promise((r) => setTimeout(r, wait).unref?.());
        if (closed || keyed) break;
        try {
          const x = await start();
          if (closed) {
            stopHelper(x, "SIGTERM");
            break;
          }
          h = x;
          label = `termux-usb ${x.device}: ${x.label}`;
          console.error("[ptt] USB PTT helper started again: %s", label);
        } catch (e) {
          console.error("[ptt] USB PTT helper did not start again: %s", (e as Error).message);
          wait = Math.min(restartMs.cap, wait * 2);
        }
      }
    })().finally(() => {
      restarting = false;
    });
  };

  return {
    get label() {
      return label;
    },
    key: () =>
      locked(async () => {
        if (closed) throw new Error("the USB PTT is closed");
        if (!h?.alive) {
          if (keyed) throw new Error("the USB PTT helper exited while the line may be keyed");
          restart();
          throw new Error("the USB PTT helper is not running; it is being started again");
        }
        keyed = true;
        await request(h, "KEY");
      }),
    unkey: () =>
      locked(async () => {
        if (h && !h.alive) {
          // a helper that is stopping reports UNKEYED once its unkey on the way out went through
          await within(h.closed, replyMs);
        }
        if (!h?.alive) {
          if (keyed) throw new Error("the USB PTT helper exited while the line may be keyed");
          return;
        }
        await request(h, "UNKEY");
        keyed = false;
      }),
    close: () =>
      locked(async () => {
        if (closed) return;
        closed = true;
        const x = h;
        if (!x?.alive) return;
        try {
          await request(x, "UNKEY");
          keyed = false;
          await request(x, "QUIT");
        } finally {
          x.child.stdin?.end();
          if (!(await within(x.closed, 2000))) stopHelper(x, "SIGTERM");
        }
      }),
    releaseSync: () => {
      // the helper unkeys at the end of its input and on SIGTERM; both reach it without waiting here
      if (h?.alive) stopHelper(h, "SIGTERM");
    },
  };
}

/**
 * Whether the driver can work here, checked without opening the device: termux-usb, python3 and the helper
 * are there, and the device is attached. Returns null when it looks usable, else what is missing.
 */
export async function termuxUsbProblem(
  s: TermuxUsbSpec,
  deps: { run?: RunFn; fs?: Pick<typeof fs, "existsSync">; helper?: string } = {},
): Promise<string | null> {
  const run = deps.run ?? defaultRun;
  const helper = deps.helper ?? HELPER;
  try {
    if (!(deps.fs ?? fs).existsSync(helper)) return `the USB PTT helper is missing: ${helper}`;
    const py = await run("python3", ["--version"]);
    if (py.error) return "python3 not found: pkg install python";
    await resolveDevice(s, run);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
