import type { ProjectManifest } from "@sonora/schema";
import { AudioEngine } from "./audioEngine";
import { clampBpm } from "./transport";

/**
 * Export ("bounce"): render the project to an audio file.
 *
 * It runs the SAME AudioEngine on an OfflineAudioContext, so the file is exactly what you hear: same
 * instruments, effects, mute/solo, panning and master limiter. Because everything audible is seeded
 * (drum noise, reverb impulse), rendering the same project twice gives bit-identical audio.
 */

export const MAX_EXPORT_SECONDS = 30 * 60;
const MIN_TAIL_SECONDS = 0.5;
const MAX_TAIL_SECONDS = 12;

export interface BounceOptions {
  /** Output sample rate. Default 44100. */
  sampleRate?: number;
  /** Extra time after the last clip so release/reverb/delay tails ring out. Default: estimated from the project. */
  tailSeconds?: number;
}

/** End of the last clip, in beats (ignores clips with corrupt, non-finite positions). */
export function projectEndBeat(manifest: ProjectManifest): number {
  let end = 0;
  for (const clip of manifest.clips) {
    const e = clip.startBeat + clip.lengthBeats;
    if (Number.isFinite(e) && clip.lengthBeats > 0) end = Math.max(end, e);
  }
  return end;
}

/**
 * How long the sound keeps ringing after the last note: the longest instrument release, plus reverb decay
 * and delay repeats on any enabled effect. Clamped so a silly setting can't create a huge file.
 */
export function estimateTailSeconds(manifest: ProjectManifest): number {
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  let tail = MIN_TAIL_SECONDS;

  for (const inst of manifest.instruments) {
    if (inst.pluginId === "sonora.synth") tail = Math.max(tail, num(inst.presetData.release, 0.25));
    if (inst.pluginId === "sonora.drums") tail = Math.max(tail, 2); // crash cymbal
  }

  const inserts = [...manifest.mixer.masterInserts, ...manifest.mixer.strips.flatMap((s) => s.inserts)];
  for (const fx of inserts) {
    if (fx.bypassed) continue;
    if (fx.pluginId === "sonora.reverb") {
      tail = Math.max(tail, num(fx.presetData.decay, 2) + num(fx.presetData.preDelayMs, 20) / 1000);
    } else if (fx.pluginId === "sonora.delay") {
      // Repeats fall by `feedback` each pass; stop once they're below -60 dB (0.001).
      const time = num(fx.presetData.timeMs, 350) / 1000;
      const fb = Math.min(0.9, Math.max(0, num(fx.presetData.feedback, 0.35)));
      const repeats = fb > 0 ? Math.ceil(Math.log(0.001) / Math.log(fb)) : 1;
      tail = Math.max(tail, time * (repeats + 1));
    }
  }
  return Math.min(MAX_TAIL_SECONDS, tail);
}

export class ExportError extends Error {}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

export async function bounceProject(
  manifest: ProjectManifest,
  options: BounceOptions = {},
  /** Injectable for tests / non-browser hosts */
  OfflineContext: OfflineCtor = (globalThis as unknown as { OfflineAudioContext: OfflineCtor }).OfflineAudioContext,
): Promise<AudioBuffer> {
  const endBeat = projectEndBeat(manifest);
  if (endBeat <= 0) throw new ExportError("Nothing to export yet: add a clip with some notes first.");
  if (!OfflineContext) throw new ExportError("This browser can't render audio offline.");

  const sampleRate = Math.max(8000, Math.min(96000, Math.round(options.sampleRate ?? 44100)));
  const tail = Number.isFinite(options.tailSeconds) ? Math.max(0, Math.min(MAX_TAIL_SECONDS, options.tailSeconds!)) : estimateTailSeconds(manifest);
  const seconds = (endBeat * 60) / clampBpm(manifest.bpm) + tail;
  if (seconds > MAX_EXPORT_SECONDS) {
    throw new ExportError(`This project is ${Math.ceil(seconds / 60)} minutes long; export is limited to ${MAX_EXPORT_SECONDS / 60} minutes.`);
  }

  const context = new OfflineContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const engine = new AudioEngine(context as unknown as AudioContext);
  try {
    engine.loadManifest(manifest);
    engine.scheduleOffline(endBeat);
    return await context.startRendering();
  } finally {
    engine.dispose();
  }
}

// --- WAV encoding ---------------------------------------------------------------------------

/** The little of AudioBuffer the encoder needs (lets tests pass a plain object). */
export interface PcmSource {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * Encode as an uncompressed PCM WAV. 16-bit is universal; 24-bit is available for further mastering.
 * Samples are clamped to [-1, 1] (the master limiter should already keep them there).
 */
export function encodeWav(source: PcmSource, bitDepth: 16 | 24 = 16): Blob {
  const channels = source.numberOfChannels;
  const frames = source.length;
  const bytes = bitDepth / 8;
  const dataSize = frames * channels * bytes;
  const out = new DataView(new ArrayBuffer(44 + dataSize));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  out.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  out.setUint32(16, 16, true); // fmt chunk size
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, channels, true);
  out.setUint32(24, source.sampleRate, true);
  out.setUint32(28, source.sampleRate * channels * bytes, true);
  out.setUint16(32, channels * bytes, true);
  out.setUint16(34, bitDepth, true);
  ascii(36, "data");
  out.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => source.getChannelData(c));
  const max = bitDepth === 16 ? 32767 : 8388607;
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const raw = data[c][i];
      const v = Math.round(Math.max(-1, Math.min(1, Number.isFinite(raw) ? raw : 0)) * max);
      if (bitDepth === 16) {
        out.setInt16(offset, v, true);
      } else {
        out.setUint8(offset, v & 0xff);
        out.setUint8(offset + 1, (v >> 8) & 0xff);
        out.setUint8(offset + 2, (v >> 16) & 0xff);
      }
      offset += bytes;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

export async function bounceToWavBlob(manifest: ProjectManifest, options: BounceOptions & { bitDepth?: 16 | 24 } = {}): Promise<Blob> {
  const buffer = await bounceProject(manifest, options);
  return encodeWav(buffer, options.bitDepth ?? 16);
}

/** A safe download filename from a project title ("Summer Nights (Demo — not saved)" -> "summer-nights-demo-not-saved.wav"). */
export function exportFileName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "sonora-project"}.wav`;
}
