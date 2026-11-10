import type { PluginDescriptor } from "../plugins/params";
import { DescriptorInstrument, ENV_FLOOR, buildAmpEnvelope, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * FM Keys ("sonora.fm"): two-operator FM (modulator -> carrier frequency). The modulation index decays over the
 * note, which is what gives electric pianos, bells and marimbas their bright-attack-then-mellow character.
 */
export interface FmPreset {
  carrierRatio: number; ratio: number; index: number; indexDecay: number; indexSustain: number; velocityToIndex: number;
  attack: number; decay: number; sustain: number; release: number; level: number;
}

export const FM_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.fm",
  displayName: "FM Keys",
  category: "instrument",
  params: [
    { key: "carrierRatio", label: "Carrier ratio", min: 0.25, max: 8, default: 1, step: 0.25 },
    { key: "ratio", label: "Modulator ratio", min: 0.25, max: 16, default: 1, step: 0.25 },
    { key: "index", label: "FM amount", min: 0, max: 20, default: 2.5, step: 0.1 },
    { key: "indexDecay", label: "FM decay", min: 0.02, max: 6, default: 0.6, unit: "s", scale: "log" },
    { key: "indexSustain", label: "FM sustain", min: 0, max: 1, default: 0.15, step: 0.01 },
    { key: "velocityToIndex", label: "Velocity → FM", min: 0, max: 1, default: 0.5, step: 0.01 },
    { key: "attack", label: "Attack", min: 0.001, max: 4, default: 0.002, unit: "s", scale: "log" },
    { key: "decay", label: "Decay", min: 0.01, max: 8, default: 1.2, unit: "s", scale: "log" },
    { key: "sustain", label: "Sustain", min: 0, max: 1, default: 0.15, step: 0.01 },
    { key: "release", label: "Release", min: 0.01, max: 6, default: 0.35, unit: "s", scale: "log" },
    { key: "level", label: "Level", min: 0, max: 1, default: 0.3, step: 0.01 },
  ],
};

export const FM_PRESETS: Record<string, { name: string; preset: Partial<FmPreset> }> = {
  epiano: { name: "E-Piano", preset: {} },
  bell: { name: "FM Bell", preset: { carrierRatio: 1, ratio: 3.5, index: 6, indexDecay: 1.6, indexSustain: 0.05, decay: 3, sustain: 0, release: 1.5, level: 0.26 } },
  marimba: { name: "Marimba", preset: { ratio: 4, index: 3, indexDecay: 0.12, indexSustain: 0, decay: 0.5, sustain: 0, release: 0.12, level: 0.34 } },
};

export class FmKeys extends DescriptorInstrument<FmPreset> {
  readonly descriptor = FM_DESCRIPTOR;
  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.init(presetData);
  }

  protected buildVoice({ ctx, params: p, t, freq, velocity, durationSec }: VoiceContext<FmPreset>): VoiceSpec {
    const amp = buildAmpEnvelope(ctx, p, velocity * p.level, t, durationSec);
    const carrier = ctx.createOscillator();
    carrier.frequency.value = freq * p.carrierRatio;
    const modulator = ctx.createOscillator();
    const modFreq = freq * p.ratio;
    modulator.frequency.value = modFreq;

    // Deviation in Hz = index * modulator frequency; the index decays toward a sustain level.
    const index = p.index * (1 - p.velocityToIndex + p.velocityToIndex * velocity);
    const dev = ctx.createGain();
    dev.gain.value = index * modFreq;
    dev.gain.setValueAtTime(index * modFreq, t);
    dev.gain.exponentialRampToValueAtTime(Math.max(ENV_FLOOR, index * modFreq * p.indexSustain), t + p.indexDecay);

    modulator.connect(dev);
    dev.connect(carrier.frequency);
    carrier.connect(amp.input);
    const sources: AudioScheduledSourceNode[] = [carrier, modulator];
    runSources(sources, t, amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources };
  }
}
