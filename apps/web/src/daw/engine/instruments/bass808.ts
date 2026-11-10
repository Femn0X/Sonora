import type { PluginDescriptor } from "../plugins/params";
import { makeCurve } from "../effects/distortion";
import { DescriptorInstrument, buildAmpEnvelope, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * 808 Bass ("sonora.bass808"): a sine whose pitch drops from above the note to the note (the "boom"), a long
 * decay, and optional tanh saturation for harmonics that survive small speakers. Releasing the key fades it quickly.
 */
export interface Bass808Preset { decay: number; glideSemitones: number; glideTime: number; drive: number; release: number; level: number }

export const BASS808_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.bass808",
  displayName: "808 Bass",
  category: "instrument",
  params: [
    { key: "decay", label: "Decay", min: 0.1, max: 6, default: 1.4, unit: "s", scale: "log" },
    { key: "glideSemitones", label: "Pitch drop", min: 0, max: 36, default: 12, step: 1, unit: "st" },
    { key: "glideTime", label: "Drop time", min: 0.005, max: 0.5, default: 0.08, unit: "s", scale: "log" },
    { key: "drive", label: "Drive", min: 0, max: 1, default: 0.3, step: 0.01 },
    { key: "release", label: "Release", min: 0.01, max: 2, default: 0.08, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.5, step: 0.01 },
  ],
};

export const BASS808_PRESETS: Record<string, { name: string; preset: Partial<Bass808Preset> }> = {
  boom: { name: "808 Boom", preset: {} },
  tight: { name: "Tight Sub", preset: { decay: 0.45, glideSemitones: 5, glideTime: 0.04, drive: 0.15 } },
  dirty: { name: "Dirty 808", preset: { decay: 2.2, drive: 0.8, glideSemitones: 7 } },
};

export class Bass808 extends DescriptorInstrument<Bass808Preset> {
  readonly descriptor = BASS808_DESCRIPTOR;
  private curveDrive = -1;
  private curve: ReturnType<typeof makeCurve> | null = null;

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.init(presetData);
  }

  protected buildVoice({ ctx, params: p, t, freq, velocity, durationSec }: VoiceContext<Bass808Preset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, { attack: 0.002, decay: p.decay, sustain: 0, release: p.release }, velocity * p.level, t, durationSec);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq * Math.pow(2, p.glideSemitones / 12), t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + p.glideTime);

    if (p.drive > 0) {
      const d = 1 + p.drive * 8;
      if (d !== this.curveDrive) {
        this.curve = makeCurve(d);
        this.curveDrive = d;
      }
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.curve;
      shaper.oversample = "2x";
      osc.connect(shaper);
      shaper.connect(amp.input);
    } else {
      osc.connect(amp.input);
    }
    runSources([osc], t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources: [osc] };
  }
}
