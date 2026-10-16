// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a soundcard port's audio comes from and goes to (`SOUNDCARD_AUDIO`, per port `audio`):
 *
 *  - `alsa` (the default): ALSA's `arecord` and `aplay` (alsa.ts). The device is an ALSA name such as
 *    `plughw:1,0`; `arecord -l` and `aplay -l` list them.
 *  - `pulse`: PulseAudio's `parec` and `pacat`, for a box with no ALSA of its own (Termux on an Android phone,
 *    whose PulseAudio reaches the phone's audio, a USB interface included, through Android's OpenSL ES) and for
 *    a Linux desktop where PulseAudio or PipeWire owns the card. The capture device is a PulseAudio source and
 *    the playback device a sink (`pactl list short sources` / `sinks`); `default` is the server's default.
 *
 * Both run as child processes with raw signed 16-bit little-endian mono at the port's rate on stdout and stdin,
 * so the port treats them alike. A playback ends when the tool exits: `aplay` once its buffer has drained,
 * `pacat` once the server reports its stream drained (pacat drains the stream at the end of its input). That
 * is what times the unkey.
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { alsaArgs, alsaHint, type AudioTool } from "./alsa.js";

export type AudioBackend = "alsa" | "pulse";
export const AUDIO_BACKENDS: readonly AudioBackend[] = ["alsa", "pulse"];

/** PulseAudio's buffer for capture: short, so carrier detect sees the channel promptly. */
const PULSE_CAPTURE_MS = 50;
/** PulseAudio's buffer for playback: long enough that a busy phone does not underrun inside a frame. */
const PULSE_PLAYBACK_MS = 100;

/** The part of a port's settings the audio tools need. */
export interface AudioPort {
  audio?: AudioBackend;
  device: string;
  playback: string;
  rate: number;
}

/** The tool and arguments that capture from, or play to, a port's device. */
export function audioCommand(p: AudioPort, dir: "capture" | "playback"): { cmd: AudioTool; args: string[] } {
  const device = dir === "capture" ? p.device : p.playback;
  if (p.audio !== "pulse") return { cmd: dir === "capture" ? "arecord" : "aplay", args: alsaArgs(device, p.rate) };
  return { cmd: dir === "capture" ? "parec" : "pacat", args: pulseArgs(device, p.rate, dir) };
}

/** The arguments for raw s16le mono at `rate` on a PulseAudio source or sink; `default` names none. */
export function pulseArgs(device: string, rate: number, dir: "capture" | "playback"): string[] {
  return [
    ...(dir === "playback" ? ["--playback"] : []),
    ...(device && device !== "default" ? [`--device=${device}`] : []),
    "--raw",
    "--format=s16le",
    "--channels=1",
    `--rate=${rate}`,
    `--latency-msec=${dir === "capture" ? PULSE_CAPTURE_MS : PULSE_PLAYBACK_MS}`,
    "--client-name=APRScaching",
    `--stream-name=soundcard ${dir}`,
  ];
}

/** The operator's fix for an audio tool's failure, from its exit or error. */
export function audioHint(tool: AudioTool, err: Error | null, stderr: string): string {
  if (tool === "arecord" || tool === "aplay") return alsaHint(tool, err, stderr);
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
    return `${tool} not found: install PulseAudio (Termux: pkg install pulseaudio; Debian: apt install pulseaudio-utils)`;
  const line = stderr.trim().split("\n").pop() ?? "";
  if (/Connection (refused|failure)|Access denied/i.test(line))
    return `${line} — start PulseAudio (on the phone: pulseaudio --start --load=module-sles-source --exit-idle-time=-1)`;
  if (/No such entity|No such device/i.test(line))
    return `${line} — check the device name (pactl list short ${tool === "parec" ? "sources" : "sinks"})`;
  return line || err?.message || `${tool} failed`;
}

/** Whether the tools of `backend` are installed; null when they are, else the fix. */
export function audioToolsProblem(
  backend: AudioBackend,
  spawnSync: (c: string, a: string[]) => { error?: Error } = (c, a) => nodeSpawnSync(c, a, { stdio: "ignore" }),
): string | null {
  const tools: AudioTool[] = backend === "pulse" ? ["parec", "pacat"] : ["arecord", "aplay"];
  for (const tool of tools) {
    const r = spawnSync(tool, ["--version"]);
    if (r.error) return audioHint(tool, r.error, "");
  }
  return null;
}
