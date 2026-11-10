import type { PluginDescriptor } from "../plugins/params";
import { sanitizeParams } from "../plugins/params";
import { mulberry32 } from "../plugins/random";
import { midiToFrequency, velocityToGain, type Instrument, type TriggerParams } from "./types";
import { VoiceTracker } from "./voiceTracker";

/**
 * Shared scaffolding for descriptor-driven instruments, so each new instrument is only its sound design.
 * Everything here encodes lessons already paid for:
 *  - envelopes use setValueAtTime + ramps ONLY (setTargetAtTime misbehaves when chained; see docs/DAW-ENGINE.md)
 *  - presetData is untrusted: always sanitized through the plugin's descriptor
 *  - "random" noise is seeded, so a project renders identically everywhere
 *  - every voice is tracked, so Stop can silence it and the voice cap only counts sounding voices
 */

export const ENV_FLOOR = 0.0001; // exponential ramps can't target 0

export interface Adsr {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Amp envelope on two gain nodes: env (attack/decay/sustain) -> rel (release at note-off). */
export function buildAmpEnvelope(ctx: BaseAudioContext, p: Adsr, peak: number, t: number, durationSec: number) {
  const env = ctx.createGain();
  env.gain.value = 0;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + p.attack);
  env.gain.exponentialRampToValueAtTime(Math.max(ENV_FLOOR, peak * p.sustain), t + p.attack + p.decay);
  const rel = ctx.createGain();
  rel.gain.value = 1;
  const noteOff = Math.max(t + durationSec, t + p.attack + 0.005); // never shorter than the attack, so short notes still speak
  const releaseEnd = noteOff + p.release;
  rel.gain.setValueAtTime(1, noteOff);
  rel.gain.exponentialRampToValueAtTime(0.001, releaseEnd); // -60 dB over the release time
  rel.gain.setValueAtTime(0, releaseEnd);
  env.connect(rel);
  return { input: env as GainNode, output: rel as GainNode, noteOff, stopAt: releaseEnd + 0.02 };
}

/** Start every source at `t` and stop it at `stopAt`. */
export function runSources(sources: AudioScheduledSourceNode[], t: number, stopAt: number) {
  for (const s of sources) {
    s.start(t);
    s.stop(stopAt);
  }
}

/** Seeded white-noise buffer shared by an instrument instance. */
export function makeNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const rand = mulberry32(seed);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
  return buffer;
}

export interface VoiceContext<P> {
  ctx: AudioContext;
  params: P;
  /** Start time (never in the past) */
  t: number;
  pitch: number;
  freq: number;
  /** Velocity curve already applied, 0..1 */
  velocity: number;
  durationSec: number;
}

export interface VoiceSpec {
  /** Final node of the voice (connected to the channel) */
  output: AudioNode;
  /** The release gain: faded when the voice is killed */
  releaseGain: GainNode;
  sources: AudioScheduledSourceNode[];
}

/**
 * Base for instruments described by a PluginDescriptor. Subclasses provide `descriptor` and `buildVoice`,
 * and call `init(presetData)` at the end of their constructor.
 */
export abstract class DescriptorInstrument<P> implements Instrument {
  abstract readonly descriptor: PluginDescriptor;
  protected params!: P;
  protected tracker: VoiceTracker;
  protected maxVoices = 48;

  constructor(protected ctx: AudioContext) {
    this.tracker = new VoiceTracker(ctx, this.maxVoices);
  }

  get pluginId() {
    return this.descriptor.pluginId;
  }

  protected init(presetData: Record<string, unknown>) {
    this.setPreset(presetData);
  }

  /** Build and START one voice. Must start/stop its own sources. */
  protected abstract buildVoice(v: VoiceContext<P>): VoiceSpec;

  setPreset(presetData: Record<string, unknown>) {
    this.params = sanitizeParams(this.descriptor.params, presetData) as unknown as P;
  }

  trigger({ destination, pitch, velocity, startTime, durationSec }: TriggerParams) {
    const t = Math.max(startTime, this.ctx.currentTime);
    const voice = this.buildVoice({
      ctx: this.ctx, params: this.params, t, pitch, freq: midiToFrequency(pitch),
      velocity: velocityToGain(velocity), durationSec,
    });
    voice.output.connect(destination);
    this.tracker.add({ gain: voice.releaseGain, sources: voice.sources, startTime: t }, voice.sources[0]);
  }

  allNotesOff() {
    this.tracker.killAll();
  }

  dispose() {
    this.tracker.killAll();
  }
}

export const WAVE_OPTIONS = [
  { value: "sine", label: "Sine" },
  { value: "triangle", label: "Triangle" },
  { value: "sawtooth", label: "Saw" },
  { value: "square", label: "Square" },
];
