import type { PluginDescriptor } from "../plugins/params";
import { DescriptorInstrument, buildAmpEnvelope, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * Organ ("sonora.organ"): nine drawbars as additive harmonics. The oscillator runs at the 16' fundamental (half the
 * played pitch) so every drawbar lands on an INTEGER harmonic of it, which means a single PeriodicWave per voice
 * replaces nine oscillators:
 *   16'=1  5⅓'=3  8'=2  4'=4  2⅔'=6  2'=8  1⅗'=10  1⅓'=12  1'=16
 * Drawbar levels are 0..8 in ~3 dB steps, like the real thing.
 */
const HARMONICS = [1, 3, 2, 4, 6, 8, 10, 12, 16];
const BAR_LABELS = ["16'", "5⅓'", "8'", "4'", "2⅔'", "2'", "1⅗'", "1⅓'", "1'"];
const DEFAULT_BARS = [8, 8, 8, 0, 0, 0, 0, 0, 0];

export interface OrganPreset {
  bar1: number; bar2: number; bar3: number; bar4: number; bar5: number; bar6: number; bar7: number; bar8: number; bar9: number;
  percussion: number; vibratoDepth: number; vibratoRate: number; attack: number; release: number; level: number;
}

export const ORGAN_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.organ",
  displayName: "Organ",
  category: "instrument",
  params: [
    ...BAR_LABELS.map((label, i) => ({ key: `bar${i + 1}`, label: `Drawbar ${label}`, min: 0, max: 8, default: DEFAULT_BARS[i], step: 1 })),
    { key: "percussion", label: "Percussion", min: 0, max: 1, default: 0, step: 0.01 },
    { key: "vibratoDepth", label: "Vibrato depth", min: 0, max: 50, default: 0, step: 1, unit: "ct" },
    { key: "vibratoRate", label: "Vibrato rate", min: 2, max: 9, default: 6, step: 0.1, unit: "Hz" },
    { key: "attack", label: "Attack", min: 0.001, max: 1, default: 0.006, unit: "s", scale: "log" },
    { key: "release", label: "Release", min: 0.01, max: 2, default: 0.08, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.3, step: 0.01 },
  ],
};

export const ORGAN_PRESETS: Record<string, { name: string; preset: Partial<OrganPreset> }> = {
  full: { name: "Full Organ", preset: {} },
  jazz: { name: "Jazz Organ", preset: { bar1: 8, bar2: 8, bar3: 8, bar4: 0, bar5: 0, bar6: 0, bar7: 0, bar8: 0, bar9: 0, percussion: 0.6, vibratoDepth: 12 } },
  gospel: { name: "Gospel", preset: { bar1: 8, bar2: 0, bar3: 8, bar4: 8, bar5: 0, bar6: 8, bar7: 0, bar8: 0, bar9: 6, vibratoDepth: 18 } },
};

const barGain = (level: number) => (level <= 0 ? 0 : Math.pow(10, ((level - 8) * 3) / 20));

export class Organ extends DescriptorInstrument<OrganPreset> {
  readonly descriptor = ORGAN_DESCRIPTOR;
  private waveKey = "";
  private wave: PeriodicWave | null = null;

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.init(presetData);
  }

  private waveFor(p: OrganPreset): PeriodicWave {
    const bars = [p.bar1, p.bar2, p.bar3, p.bar4, p.bar5, p.bar6, p.bar7, p.bar8, p.bar9];
    const key = bars.join(",");
    if (this.wave && key === this.waveKey) return this.wave;
    const real = new Float32Array(HARMONICS[HARMONICS.length - 1] + 1);
    const imag = new Float32Array(real.length);
    bars.forEach((level, i) => (imag[HARMONICS[i]] = barGain(level)));
    // An all-zero drawbar setting would give a silent (invalid) wave: fall back to the 8' bar so it still sounds.
    if (!bars.some((b) => b > 0)) imag[2] = 1;
    this.wave = this.ctx.createPeriodicWave(real, imag); // normalized: loudness doesn't change with how many bars are out
    this.waveKey = key;
    return this.wave;
  }

  protected buildVoice({ ctx, params: p, t, freq, velocity, durationSec }: VoiceContext<OrganPreset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, { attack: p.attack, decay: 0.01, sustain: 1, release: p.release }, velocity * p.level, t, durationSec);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.waveFor(p));
    osc.frequency.value = freq / 2;
    osc.connect(amp.input);
    const sources: AudioScheduledSourceNode[] = [osc];

    if (p.vibratoDepth > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibratoRate;
      const depth = ctx.createGain();
      depth.gain.value = p.vibratoDepth;
      lfo.connect(depth);
      depth.connect(osc.detune);
      sources.push(lfo);
    }

    if (p.percussion > 0) {
      // Key-click percussion: a decaying 4' tone on top
      const perc = ctx.createOscillator();
      perc.frequency.value = freq * 2;
      const g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setValueAtTime(p.percussion * 0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      g.gain.setValueAtTime(0, t + 0.26);
      perc.connect(g);
      g.connect(amp.input);
      sources.push(perc);
    }

    runSources(sources, t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources };
  }
}
