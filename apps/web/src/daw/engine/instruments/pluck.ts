import type { PluginDescriptor } from "../plugins/params";
import { mulberry32 } from "../plugins/random";
import { DescriptorInstrument, buildAmpEnvelope, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * Pluck ("sonora.pluck"): real Karplus-Strong string synthesis.
 *
 * A burst of (low-passed) noise circulates in a short delay line; each pass averages neighbouring samples, which
 * darkens and decays it like a plucked string. A Web Audio DelayNode can't do this (feedback loops have a minimum
 * delay of one 128-sample block, capping the pitch near 340 Hz), so each pitch is rendered into an AudioBuffer once and cached.
 *
 * Deterministic: the excitation noise is seeded by the pitch, so the same note always sounds the same.
 * Tuning: the delay line is an integer length (and the loop filter shortens it by a fraction), so the buffer is rendered
 * slightly off-pitch and corrected exactly with playbackRate.
 */
export interface PluckPreset { decay: number; brightness: number; damping: number; release: number; level: number }

export const PLUCK_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.pluck",
  displayName: "Pluck",
  category: "instrument",
  params: [
    { key: "decay", label: "Decay (T60)", min: 0.1, max: 8, default: 2.5, unit: "s", scale: "log" },
    { key: "brightness", label: "Brightness", min: 0, max: 1, default: 0.7, step: 0.01 },
    { key: "damping", label: "Damping", min: 0, max: 1, default: 0.5, step: 0.01 },
    { key: "release", label: "Release", min: 0.01, max: 2, default: 0.12, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.5, step: 0.01 },
  ],
};

export const PLUCK_PRESETS: Record<string, { name: string; preset: Partial<PluckPreset> }> = {
  guitar: { name: "Nylon Pluck", preset: {} },
  harp: { name: "Harp", preset: { decay: 4, brightness: 0.5, damping: 0.35, level: 0.45 } },
  muted: { name: "Muted Pick", preset: { decay: 0.5, brightness: 0.4, damping: 0.9 } },
};

const MAX_SECONDS = 6;
const MAX_CACHE = 48;

export interface KsString { buffer: AudioBuffer; rate: number }

/** Render one Karplus-Strong string. Exported so tests can check pitch and decay directly. */
export function renderString(sampleRate: number, freq: number, pitch: number, p: Pick<PluckPreset, "decay" | "brightness" | "damping">): { samples: Float32Array; ksFreq: number } {
  // The loop averages y[i] and y[i+1] with weights (mix, 1-mix): at low frequencies that shortens the loop by
  // (1 - mix) samples (0.5 for the classic 50/50 average, 0 with no filtering). Pick the integer length that makes
  // the effective period closest to the target; playbackRate then corrects the remainder exactly.
  const mix = 1 - 0.5 * p.damping; // 1 = no filtering, 0.5 = classic two-point average
  const excess = 1 - mix;
  const N = Math.max(2, Math.round(sampleRate / freq + excess));
  const ksFreq = sampleRate / (N - excess);
  const length = Math.ceil(Math.min(MAX_SECONDS, p.decay * 1.2 + 0.1) * sampleRate);
  const loss = Math.pow(0.001, (N - excess) / (sampleRate * p.decay)); // per-pass gain that reaches -60 dB at `decay`

  const rand = mulberry32(0x9e3779b9 + pitch * 7919);
  const ring = new Float32Array(N);
  const b = 0.1 + 0.9 * p.brightness;
  let y = 0;
  let mean = 0;
  for (let i = 0; i < N; i++) {
    y = b * (rand() * 2 - 1) + (1 - b) * y;
    ring[i] = y;
    mean += y;
  }
  mean /= N;
  let peak = 1e-9;
  for (let i = 0; i < N; i++) {
    ring[i] -= mean; // no DC, or the string "thumps"
    peak = Math.max(peak, Math.abs(ring[i]));
  }
  for (let i = 0; i < N; i++) ring[i] /= peak;

  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const idx = i % N;
    const cur = ring[idx];
    samples[i] = cur;
    ring[idx] = loss * (mix * cur + (1 - mix) * ring[(idx + 1) % N]);
  }
  return { samples, ksFreq };
}

export class Pluck extends DescriptorInstrument<PluckPreset> {
  readonly descriptor = PLUCK_DESCRIPTOR;
  private cache = new Map<string, KsString>();

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.init(presetData);
  }

  private stringFor(pitch: number, freq: number, p: PluckPreset): KsString {
    const key = `${pitch}|${p.decay}|${p.brightness}|${p.damping}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // most recently used goes last
      return hit;
    }
    const { samples, ksFreq } = renderString(this.ctx.sampleRate, freq, pitch, p);
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const made = { buffer, rate: freq / ksFreq };
    this.cache.set(key, made);
    if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    return made;
  }

  protected buildVoice({ ctx, params: p, t, pitch, freq, velocity, durationSec }: VoiceContext<PluckPreset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, { attack: 0.001, decay: 0.01, sustain: 1, release: p.release }, velocity * p.level, t, durationSec);
    const { buffer, rate } = this.stringFor(pitch, freq, p);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(amp.input);
    runSources([src], t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources: [src] };
  }
}
