import { midiToFrequency, velocityToGain, type Instrument, type TriggerParams } from "./types";
import { VoiceTracker } from "./voiceTracker";
import { sanitizeParams, type PluginDescriptor } from "../plugins/params";

/**
 * Sonora Synth ("sonora.synth") — polyphonic two-oscillator subtractive synth.
 *
 *   osc1 + osc2 -> lowpass filter (with envelope) -> amp envelope (ADSR) -> track channel
 *
 * Fully described by plain JSON (SynthPreset), so a patch lives in the project
 * manifest's `presetData`, diffs cleanly, and survives forks/remixes.
 */

export type OscWave = "sine" | "triangle" | "sawtooth" | "square";

export interface SynthPreset {
  wave1: OscWave;
  wave2: OscWave;
  /** osc2 pitch offset in semitones (e.g. -12 for a sub octave) */
  osc2Semitones: number;
  /** osc2 fine detune in cents (thickness) */
  osc2DetuneCents: number;
  /** 0 = only osc1, 1 = only osc2 */
  oscMix: number;
  attack: number;
  decay: number;
  /** 0-1 */
  sustain: number;
  release: number;
  cutoffHz: number;
  resonance: number;
  /** How far the filter envelope opens above cutoff, in octaves */
  filterEnvOctaves: number;
  filterDecay: number;
  /** Per-voice output level, 0-1 */
  level: number;
}

export const DEFAULT_SYNTH_PRESET: SynthPreset = {
  wave1: "sawtooth",
  wave2: "sawtooth",
  osc2Semitones: 0,
  osc2DetuneCents: 10,
  oscMix: 0.5,
  attack: 0.005,
  decay: 0.2,
  sustain: 0.6,
  release: 0.25,
  cutoffHz: 4200,
  resonance: 3,
  filterEnvOctaves: 1.5,
  filterDecay: 0.3,
  level: 0.25,
};

export const SYNTH_PRESETS: Record<string, { name: string; preset: SynthPreset }> = {
  lead: { name: "Saw Lead", preset: DEFAULT_SYNTH_PRESET },
  bass: {
    name: "Bass",
    preset: {
      ...DEFAULT_SYNTH_PRESET,
      wave1: "sawtooth",
      wave2: "square",
      osc2Semitones: -12,
      osc2DetuneCents: 4,
      oscMix: 0.45,
      attack: 0.003,
      decay: 0.2,
      sustain: 0.7,
      release: 0.12,
      cutoffHz: 420,
      resonance: 5,
      filterEnvOctaves: 2.6,
      filterDecay: 0.22,
      level: 0.3,
    },
  },
  pad: {
    name: "Warm Pad",
    preset: {
      ...DEFAULT_SYNTH_PRESET,
      wave1: "sawtooth",
      wave2: "sawtooth",
      osc2DetuneCents: 14,
      attack: 0.6,
      decay: 0.8,
      sustain: 0.8,
      release: 1.2,
      cutoffHz: 1600,
      resonance: 1,
      filterEnvOctaves: 0.8,
      filterDecay: 1.0,
      level: 0.16,
    },
  },
  pluck: {
    name: "Pluck",
    preset: {
      ...DEFAULT_SYNTH_PRESET,
      wave1: "triangle",
      wave2: "sawtooth",
      osc2DetuneCents: 6,
      oscMix: 0.4,
      attack: 0.002,
      decay: 0.25,
      sustain: 0,
      release: 0.15,
      cutoffHz: 1400,
      resonance: 2,
      filterEnvOctaves: 2.5,
      filterDecay: 0.2,
      level: 0.28,
    },
  },
};

const WAVE_OPTIONS = [
  { value: "sine", label: "Sine" },
  { value: "triangle", label: "Triangle" },
  { value: "sawtooth", label: "Saw" },
  { value: "square", label: "Square" },
];

const D = DEFAULT_SYNTH_PRESET;

/** Single source of truth for the synth's parameters: drives sanitizing, defaults and the editor UI. */
export const SYNTH_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.synth",
  displayName: "Sonora Synth",
  category: "instrument",
  params: [
    { kind: "enum", key: "wave1", label: "Osc 1", options: WAVE_OPTIONS, default: D.wave1 },
    { kind: "enum", key: "wave2", label: "Osc 2", options: WAVE_OPTIONS, default: D.wave2 },
    { key: "oscMix", label: "Osc mix", min: 0, max: 1, default: D.oscMix, step: 0.01 },
    { key: "osc2Semitones", label: "Osc 2 pitch", min: -48, max: 48, default: D.osc2Semitones, step: 1, unit: "st" },
    { key: "osc2DetuneCents", label: "Detune", min: -100, max: 100, default: D.osc2DetuneCents, step: 1, unit: "ct" },
    { key: "cutoffHz", label: "Cutoff", min: 40, max: 18000, default: D.cutoffHz, unit: "Hz", scale: "log" },
    { key: "resonance", label: "Resonance", min: 0.1, max: 20, default: D.resonance, unit: "", scale: "log" },
    { key: "filterEnvOctaves", label: "Filter env", min: 0, max: 6, default: D.filterEnvOctaves, step: 0.1, unit: "oct" },
    { key: "filterDecay", label: "Filter decay", min: 0.01, max: 8, default: D.filterDecay, unit: "s", scale: "log" },
    { key: "attack", label: "Attack", min: 0.001, max: 8, default: D.attack, unit: "s", scale: "log" },
    { key: "decay", label: "Decay", min: 0.005, max: 8, default: D.decay, unit: "s", scale: "log" },
    { key: "sustain", label: "Sustain", min: 0, max: 1, default: D.sustain, step: 0.01 },
    { key: "release", label: "Release", min: 0.005, max: 10, default: D.release, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: D.level, step: 0.01 },
  ],
};

/** presetData comes from untrusted project JSON (forks/remixes): clamp and validate, never trust. */
export function sanitizeSynthPreset(data: Record<string, unknown>): SynthPreset {
  return sanitizeParams(SYNTH_DESCRIPTOR.params, data) as unknown as SynthPreset;
}

export class SonoraSynth implements Instrument {
  readonly pluginId = "sonora.synth";
  private preset: SynthPreset;
  private tracker: VoiceTracker;

  constructor(private context: AudioContext, presetData: Record<string, unknown>) {
    this.preset = sanitizeSynthPreset(presetData);
    this.tracker = new VoiceTracker(context, 48);
  }

  trigger({ destination, pitch, velocity, startTime, durationSec }: TriggerParams) {
    const ctx = this.context;
    const p = this.preset;
    const t = Math.max(startTime, ctx.currentTime);
    const freq = midiToFrequency(pitch);
    const peak = velocityToGain(velocity) * p.level;

    const osc1 = ctx.createOscillator();
    osc1.type = p.wave1;
    osc1.frequency.value = freq;
    const osc2 = ctx.createOscillator();
    osc2.type = p.wave2;
    osc2.frequency.value = freq * Math.pow(2, p.osc2Semitones / 12);
    osc2.detune.value = p.osc2DetuneCents;

    const g1 = ctx.createGain();
    g1.gain.value = 1 - p.oscMix;
    const g2 = ctx.createGain();
    g2.gain.value = p.oscMix;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = p.resonance;
    const base = p.cutoffHz;
    const top = Math.min(20000, base * Math.pow(2, p.filterEnvOctaves));
    filter.frequency.setValueAtTime(top, t);
    filter.frequency.exponentialRampToValueAtTime(base, t + Math.max(0.01, p.filterDecay));

    // Amp envelope, split over two gain nodes:
    //   env: attack (linear) -> decay (exponential) -> holds at sustain
    //   rel: release (exponential), applied at note-off
    //
    // Deliberately built from setValueAtTime + ramps ONLY. setTargetAtTime chained after
    // other automation events is evaluated inconsistently across Web Audio implementations
    // (some evaluate it before its start time, which grows exponentially and blows up the
    // output on held notes). Ramps behave identically everywhere.
    const FLOOR = 0.0001; // exponential ramps can't target 0
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + p.attack);
    env.gain.exponentialRampToValueAtTime(Math.max(FLOOR, peak * p.sustain), t + p.attack + p.decay);

    // Notes are at least as long as the attack, so a very short note still speaks.
    const noteOff = Math.max(t + durationSec, t + p.attack + 0.005);
    const releaseEnd = noteOff + p.release;
    const rel = ctx.createGain();
    rel.gain.value = 1;
    rel.gain.setValueAtTime(1, noteOff);
    rel.gain.exponentialRampToValueAtTime(0.001, releaseEnd); // -60 dB over the release time
    rel.gain.setValueAtTime(0, releaseEnd);
    const stopAt = releaseEnd + 0.02;

    osc1.connect(g1);
    osc2.connect(g2);
    g1.connect(filter);
    g2.connect(filter);
    filter.connect(env);
    env.connect(rel);
    rel.connect(destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(stopAt);
    osc2.stop(stopAt);

    this.tracker.add({ gain: rel, sources: [osc1, osc2], startTime: t }, osc1);
  }

  setPreset(presetData: Record<string, unknown>) {
    this.preset = sanitizeSynthPreset(presetData);
  }

  allNotesOff() {
    this.tracker.killAll();
  }

  dispose() {
    this.tracker.killAll();
  }
}
