// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Soundcard audio through ALSA's command-line tools, `arecord` and `aplay` (package `alsa-utils`, present on
 * Raspberry Pi OS and installable on any Debian or Ubuntu box), run as child processes: raw signed 16-bit
 * little-endian mono at a fixed rate on stdout and stdin. No native addon, and any ALSA device name works
 * (`plughw:1,0`, `hw:CARD=Device,DEV=0`, `default`); `arecord -l` and `aplay -l` list them.
 */
import { spawn as nodeSpawn } from "node:child_process";

/** The part of a ChildProcess the soundcard port uses. */
export interface AudioChild {
  readonly exitCode: number | null;
  stdout: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", cb: (b: Buffer) => void): unknown } | null;
  stdin: { write(b: Uint8Array): boolean; end(): void; on(event: "error", cb: (e: Error) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}
/** The audio tools a soundcard port runs: ALSA's (this module) or PulseAudio's (audioio.ts). */
export type AudioTool = "arecord" | "aplay" | "parec" | "pacat";
export type AudioSpawn = (cmd: AudioTool, args: string[]) => AudioChild;

/** Whether `tool` captures (audio on its stdout) rather than plays (audio on its stdin). */
export const captures = (tool: AudioTool): boolean => tool === "arecord" || tool === "parec";

export const defaultAudioSpawn: AudioSpawn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: captures(cmd) ? ["ignore", "pipe", "pipe"] : ["pipe", "ignore", "pipe"] });

/** The arguments for raw S16_LE mono at `rate` on `device`, read from stdin or written to stdout. */
export function alsaArgs(device: string, rate: number): string[] {
  return ["-q", "-D", device, "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", String(rate)];
}

/** Float PCM (−1…1) as S16_LE bytes, clipped. */
export function floatToS16(pcm: Float32Array, level = 1): Buffer {
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]! * level));
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

/** A converter from S16_LE chunks to float samples that keeps an odd trailing byte for the next chunk. */
export function s16Reader(): (chunk: Buffer) => Float32Array {
  let carry: Buffer | null = null;
  return (chunk) => {
    const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const n = buf.length >> 1;
    carry = buf.length & 1 ? buf.subarray(buf.length - 1) : null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
    return out;
  };
}

/** The operator's fix for an ALSA tool's failure, from its exit or error. */
export function alsaHint(tool: "arecord" | "aplay", err: Error | null, stderr: string): string {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT")
    return `${tool} not found: install ALSA's tools (apt install alsa-utils)`;
  const line = stderr.trim().split("\n").pop() ?? "";
  if (/busy/i.test(line)) return `${line} — another program holds the device`;
  if (/No such file|No such device|cannot find card|Unknown PCM/i.test(line))
    return `${line} — check the device name (${tool} -l lists the cards)`;
  if (/Permission denied/i.test(line)) return `${line} — add the ingest's user to the audio group`;
  return line || err?.message || `${tool} failed`;
}
