import type { PluginDescriptor } from "../plugins/params";
import { DescriptorInstrument, buildAmpEnvelope, makeNoiseBuffer, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * Vox ("sonora.vox"): a synthesized singing voice using formant synthesis.
 *
 * A glottal-like sawtooth (optionally doubled with detuned copies for a choir) feeds three parallel band-pass
 * filters tuned to the first three formants of a vowel. Moving the formants is what turns "buzz" into "ah / eh / ee /
 * oh / oo". A second vowel makes the sound glide from one to the other during the note (the formants and their gains
 * ramp), vibrato fades in after a delay like a real singer's, and a little shaped noise adds breath.
 */
interface Vowel { f: [number, number, number]; db: [number, number, number]; bw: [number, number, number] }

// Typical formant frequencies (Hz), relative levels (dB) and bandwidths (Hz) for a tenor voice
export const VOWELS: Record<string, Vowel> = {
  a: { f: [650, 1080, 2650], db: [0, -6, -7], bw: [80, 90, 120] },
  e: { f: [400, 1700, 2600], db: [0, -14, -12], bw: [70, 80, 100] },
  i: { f: [290, 1870, 2800], db: [0, -15, -18], bw: [60, 90, 100] },
  o: { f: [400, 800, 2600], db: [0, -10, -12], bw: [70, 80, 100] },
  u: { f: [350, 600, 2700], db: [0, -20, -17], bw: [40, 80, 100] },
};
/** Shorter vocal tracts have higher formants */
const TYPE_SCALE: Record<string, number> = { bass: 0.85, tenor: 1, alto: 1.1, soprano: 1.25 };

const VOWEL_OPTIONS = [
  { value: "a", label: "Ah" }, { value: "e", label: "Eh" }, { value: "i", label: "Ee" }, { value: "o", label: "Oh" }, { value: "u", label: "Oo" },
];

export interface VoxPreset {
  vowel: string; vowel2: string; morphTime: number; voiceType: string; choir: number;
  vibratoRate: number; vibratoDepth: number; vibratoDelay: number; breath: number;
  attack: number; release: number; level: number;
}

export const VOX_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.vox",
  displayName: "Vox",
  category: "instrument",
  params: [
    { kind: "enum", key: "vowel", label: "Vowel", options: VOWEL_OPTIONS, default: "a" },
    { kind: "enum", key: "vowel2", label: "Glide to", options: [{ value: "same", label: "(none)" }, ...VOWEL_OPTIONS], default: "same" },
    { key: "morphTime", label: "Glide time", min: 0.05, max: 4, default: 0.5, unit: "s", scale: "log" },
    { kind: "enum", key: "voiceType", label: "Voice", default: "tenor", options: [
      { value: "bass", label: "Bass" }, { value: "tenor", label: "Tenor" }, { value: "alto", label: "Alto" }, { value: "soprano", label: "Soprano" } ] },
    { key: "choir", label: "Choir", min: 0, max: 1, default: 0.4, step: 0.01 },
    { key: "vibratoRate", label: "Vibrato rate", min: 0.5, max: 9, default: 5.5, unit: "Hz", scale: "log" },
    { key: "vibratoDepth", label: "Vibrato depth", min: 0, max: 100, default: 18, step: 1, unit: "ct" },
    { key: "vibratoDelay", label: "Vibrato delay", min: 0, max: 2, default: 0.25, step: 0.01, unit: "s" },
    { key: "breath", label: "Breath", min: 0, max: 1, default: 0.08, step: 0.01 },
    { key: "attack", label: "Attack", min: 0.005, max: 3, default: 0.06, unit: "s", scale: "log" },
    { key: "release", label: "Release", min: 0.02, max: 4, default: 0.35, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.36, step: 0.01 },
  ],
};

export const VOX_PRESETS: Record<string, { name: string; preset: Partial<VoxPreset> }> = {
  ah: { name: "Ah Choir", preset: { vowel: "a", voiceType: "soprano", choir: 0.8, attack: 0.25, release: 0.8, vibratoDepth: 14 } },
  oo: { name: "Oo Pad", preset: { vowel: "u", voiceType: "alto", choir: 0.6, attack: 0.5, release: 1.2, vibratoDepth: 10 } },
  lead: { name: "Lead Voice", preset: { vowel: "o", choir: 0.1, vibratoDepth: 30, vibratoDelay: 0.3, breath: 0.12 } },
  sweep: { name: "Ah-Ee Sweep", preset: { vowel: "a", vowel2: "i", morphTime: 0.8, choir: 0.5 } },
  bass: { name: "Bass Voice", preset: { vowel: "o", voiceType: "bass", choir: 0.2 } },
};

export class Vox extends DescriptorInstrument<VoxPreset> {
  readonly descriptor = VOX_DESCRIPTOR;
  private noise: AudioBuffer;

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.noise = makeNoiseBuffer(ctx, 2, 0x0a1b2c3d);
    this.init(presetData);
  }

  protected buildVoice({ ctx, params: p, t, freq, velocity, durationSec }: VoiceContext<VoxPreset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, { attack: p.attack, decay: 0.05, sustain: 1, release: p.release }, velocity * p.level, t, durationSec);
    const scale = TYPE_SCALE[p.voiceType] ?? 1;
    const from = VOWELS[p.vowel] ?? VOWELS.a;
    const to = p.vowel2 !== "same" ? VOWELS[p.vowel2] : undefined;

    // Source: the voice itself, plus detuned copies for a choir
    const source = ctx.createGain();
    const sources: AudioScheduledSourceNode[] = [];
    const saws: OscillatorNode[] = [];
    const addSaw = (detuneCents: number, level: number) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = detuneCents;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      g.connect(source);
      saws.push(o);
      sources.push(o);
    };
    addSaw(0, 1);
    if (p.choir > 0) {
      const spread = 6 + 14 * p.choir;
      addSaw(-spread, p.choir * 0.6);
      addSaw(spread, p.choir * 0.6);
    }

    if (p.vibratoDepth > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibratoRate;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + p.vibratoDelay);
      depth.gain.linearRampToValueAtTime(p.vibratoDepth, t + p.vibratoDelay + 0.4); // a singer's vibrato eases in
      lfo.connect(depth);
      for (const s of saws) depth.connect(s.detune);
      sources.push(lfo);
    }

    if (p.breath > 0) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const g = ctx.createGain();
      g.gain.value = p.breath * 0.6;
      n.connect(g);
      g.connect(source);
      sources.push(n);
    }

    // Three formant band-pass filters in parallel
    const sum = ctx.createGain();
    sum.gain.value = 2.5; // the narrow bands remove most of the source energy
    for (let k = 0; k < 3; k++) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      const f1 = from.f[k] * scale;
      bp.Q.value = f1 / from.bw[k]; // band-pass Q is a plain ratio (unlike low-/high-pass, which are in dB)
      bp.frequency.setValueAtTime(f1, t);
      const g = ctx.createGain();
      const g1 = Math.pow(10, from.db[k] / 20);
      g.gain.setValueAtTime(g1, t);
      if (to) {
        bp.frequency.linearRampToValueAtTime(to.f[k] * scale, t + p.morphTime);
        g.gain.linearRampToValueAtTime(Math.pow(10, to.db[k] / 20), t + p.morphTime);
      }
      source.connect(bp);
      bp.connect(g);
      g.connect(sum);
    }
    sum.connect(amp.input);

    runSources(sources, t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources };
  }
}
