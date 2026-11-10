import type { PluginDescriptor } from "../plugins/params";
import { mulberry32 } from "../plugins/random";
import { DescriptorInstrument, WAVE_OPTIONS, buildAmpEnvelope, makeNoiseBuffer, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * 3xOSC ("sonora.osc3"): three oscillators into a multimode filter, in the spirit of FL Studio's 3x Osc.
 *
 *   osc1 ┐
 *   osc2 ├─(pan, level)─> mix ─> filter (+envelope) ─> amp ADSR ─> channel        osc1 > FM/AM > osc2
 *   osc3 ┤
 *   noise┘
 *
 * `osc2Mode` chooses how osc1 relates to osc2: "mix" (all three simply sum), "fm" (osc1 frequency-modulates
 * osc2 and is not heard on its own) or "am" (osc1 amplitude-modulates osc2, also silent on its own).
 */

export interface Osc3Preset {
  osc1Wave: string; osc1Semi: number; osc1Fine: number; osc1Level: number; osc1Pan: number;
  osc2Wave: string; osc2Semi: number; osc2Fine: number; osc2Level: number; osc2Pan: number;
  osc3Wave: string; osc3Semi: number; osc3Fine: number; osc3Level: number; osc3Pan: number;
  osc2Mode: "mix" | "fm" | "am";
  modAmount: number;
  noise: number;
  filterType: "lowpass" | "highpass" | "bandpass";
  cutoffHz: number; resonance: number; filterEnvOctaves: number; filterDecay: number;
  vibRate: number; vibDepth: number;
  attack: number; decay: number; sustain: number; release: number;
  level: number;
}

const oscParams = (n: 1 | 2 | 3, wave: string, semi: number, fine: number, level: number) => [
  { kind: "enum" as const, key: `osc${n}Wave`, label: `Osc ${n}`, options: WAVE_OPTIONS, default: wave },
  { key: `osc${n}Semi`, label: `Osc ${n} pitch`, min: -24, max: 24, default: semi, step: 1, unit: "st" },
  { key: `osc${n}Fine`, label: `Osc ${n} fine`, min: -100, max: 100, default: fine, step: 1, unit: "ct" },
  { key: `osc${n}Level`, label: `Osc ${n} level`, min: 0, max: 1, default: level, step: 0.01 },
  { key: `osc${n}Pan`, label: `Osc ${n} pan`, min: -1, max: 1, default: 0, step: 0.01 },
];

export const OSC3_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.osc3",
  displayName: "3xOSC",
  category: "instrument",
  params: [
    ...oscParams(1, "sawtooth", 0, 0, 0.8),
    ...oscParams(2, "sawtooth", 0, 8, 0.6),
    ...oscParams(3, "square", -12, 0, 0.3),
    { kind: "enum", key: "osc2Mode", label: "Osc 1 → 2", default: "mix", options: [
      { value: "mix", label: "Mix" }, { value: "fm", label: "FM" }, { value: "am", label: "AM" } ] },
    { key: "modAmount", label: "FM / AM amount", min: 0, max: 1, default: 0.3, step: 0.01 },
    { key: "noise", label: "Noise", min: 0, max: 1, default: 0, step: 0.01 },
    { kind: "enum", key: "filterType", label: "Filter", default: "lowpass", options: [
      { value: "lowpass", label: "Low-pass" }, { value: "highpass", label: "High-pass" }, { value: "bandpass", label: "Band-pass" } ] },
    { key: "cutoffHz", label: "Cutoff", min: 40, max: 18000, default: 6000, unit: "Hz", scale: "log" },
    { key: "resonance", label: "Resonance", min: 0.1, max: 20, default: 1, scale: "log" },
    { key: "filterEnvOctaves", label: "Filter env", min: 0, max: 6, default: 1, step: 0.1, unit: "oct" },
    { key: "filterDecay", label: "Filter decay", min: 0.01, max: 8, default: 0.4, unit: "s", scale: "log" },
    { key: "vibRate", label: "Vibrato rate", min: 0.1, max: 12, default: 5, unit: "Hz", scale: "log" },
    { key: "vibDepth", label: "Vibrato depth", min: 0, max: 100, default: 0, step: 1, unit: "ct" },
    { key: "attack", label: "Attack", min: 0.001, max: 8, default: 0.005, unit: "s", scale: "log" },
    { key: "decay", label: "Decay", min: 0.005, max: 8, default: 0.25, unit: "s", scale: "log" },
    { key: "sustain", label: "Sustain", min: 0, max: 1, default: 0.65, step: 0.01 },
    { key: "release", label: "Release", min: 0.005, max: 10, default: 0.25, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.28, step: 0.01 },
  ],
};

export const OSC3_PRESETS: Record<string, { name: string; preset: Partial<Osc3Preset> }> = {
  lead: { name: "Fat Lead", preset: {} },
  bass: {
    name: "Sub Bass",
    preset: { osc1Wave: "sine", osc1Level: 0.7, osc2Wave: "square", osc2Semi: -12, osc2Fine: 3, osc2Level: 0.4, osc3Wave: "sine", osc3Semi: -24, osc3Level: 0.6,
      cutoffHz: 700, filterEnvOctaves: 1.6, filterDecay: 0.25, attack: 0.003, sustain: 0.8, release: 0.12, level: 0.34 },
  },
  bell: {
    name: "FM Bell",
    preset: { osc1Wave: "sine", osc1Semi: 12, osc2Wave: "sine", osc2Fine: 0, osc2Level: 0.8, osc3Level: 0, osc2Mode: "fm", modAmount: 0.4,
      cutoffHz: 12000, filterEnvOctaves: 0, attack: 0.002, decay: 1.8, sustain: 0, release: 1.2, level: 0.3 },
  },
  pad: {
    name: "Soft Pad",
    preset: { osc1Wave: "triangle", osc2Wave: "sawtooth", osc2Fine: 12, osc2Level: 0.4, osc3Wave: "sine", osc3Semi: 12, osc3Level: 0.2,
      cutoffHz: 1800, filterEnvOctaves: 0.8, filterDecay: 1.2, attack: 0.7, decay: 0.8, sustain: 0.8, release: 1.4, level: 0.2 },
  },
  vibrato: { name: "Vibrato Lead", preset: { osc1Wave: "square", osc1Level: 0.5, osc2Wave: "sawtooth", osc2Fine: 6, osc3Level: 0, vibDepth: 18, vibRate: 5.5, cutoffHz: 4500 } },
};

export class Osc3 extends DescriptorInstrument<Osc3Preset> {
  readonly descriptor = OSC3_DESCRIPTOR;
  private noise: AudioBuffer;
  private rand = mulberry32(0x30530c3);

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.noise = makeNoiseBuffer(ctx, 2, 0x30530c3);
    this.init(presetData);
  }

  protected buildVoice({ ctx, params: p, t, freq, velocity, durationSec }: VoiceContext<Osc3Preset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, p, velocity * p.level, t, durationSec);

    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    const top = Math.min(20000, p.cutoffHz * Math.pow(2, p.filterEnvOctaves));
    filter.frequency.setValueAtTime(top, t);
    filter.frequency.exponentialRampToValueAtTime(p.cutoffHz, t + p.filterDecay);
    filter.connect(amp.input);

    const sources: AudioScheduledSourceNode[] = [];
    const mk = (n: 1 | 2 | 3) => {
      const osc = ctx.createOscillator();
      osc.type = p[`osc${n}Wave` as "osc1Wave"] as OscillatorType;
      osc.frequency.value = freq * Math.pow(2, p[`osc${n}Semi` as "osc1Semi"] / 12);
      osc.detune.value = p[`osc${n}Fine` as "osc1Fine"];
      sources.push(osc);
      return osc;
    };
    const [o1, o2, o3] = [mk(1), mk(2), mk(3)];

    // Keep the summed level at or below 1 so stacking oscillators never costs headroom.
    const modulated = p.osc2Mode !== "mix";
    const heard = (modulated ? 0 : p.osc1Level) + p.osc2Level + p.osc3Level + p.noise * 0.5;
    const norm = 1 / Math.max(1, heard);

    const route = (src: AudioNode, level: number, pan: number, into: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = level * norm;
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      src.connect(g);
      g.connect(panner);
      panner.connect(into);
    };

    if (p.osc2Mode === "fm") {
      // osc1 modulates osc2's frequency: peak deviation = index * modulator frequency
      const dev = ctx.createGain();
      dev.gain.value = p.modAmount * 8 * (freq * Math.pow(2, p.osc1Semi / 12));
      o1.connect(dev);
      dev.connect(o2.frequency);
      route(o2, p.osc2Level, p.osc2Pan, filter);
    } else if (p.osc2Mode === "am") {
      // osc1 modulates osc2's amplitude: gain = (1 - a/2) + (a/2) * osc1
      const am = ctx.createGain();
      am.gain.value = 1 - p.modAmount * 0.5;
      const depth = ctx.createGain();
      depth.gain.value = p.modAmount * 0.5;
      o1.connect(depth);
      depth.connect(am.gain);
      o2.connect(am);
      route(am, p.osc2Level, p.osc2Pan, filter);
    } else {
      route(o1, p.osc1Level, p.osc1Pan, filter);
      route(o2, p.osc2Level, p.osc2Pan, filter);
    }
    route(o3, p.osc3Level, p.osc3Pan, filter);

    if (p.noise > 0) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const g = ctx.createGain();
      g.gain.value = p.noise * 0.5 * norm;
      n.connect(g);
      g.connect(filter);
      sources.push(n);
    }

    if (p.vibDepth > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibRate;
      const depth = ctx.createGain();
      depth.gain.value = p.vibDepth; // cents
      lfo.connect(depth);
      for (const o of [o1, o2, o3]) depth.connect(o.detune);
      sources.push(lfo);
    }

    runSources(sources, t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources };
  }
}
