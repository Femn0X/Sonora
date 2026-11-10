import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { dbToLinear, BUTTERWORTH_Q_DB } from "../plugins/audioParam";
import { BaseEffect } from "./types";

export const DISTORTION_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.distortion",
  displayName: "Distortion",
  category: "effect",
  params: [
    { key: "drive", label: "Drive", min: 1, max: 40, default: 4, unit: "", scale: "log" },
    { key: "tone", label: "Tone", min: 500, max: 20000, default: 8000, unit: "Hz", scale: "log" },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 1, step: 0.01 },
    { key: "level", label: "Level", min: -24, max: 6, default: 0, step: 0.1, unit: "dB" },
  ],
};

const CURVE_SIZE = 4096;

/** Soft-clipping transfer curve tanh(drive*x), normalized so full scale stays at full scale. */
export function makeCurve(drive: number) {
  const curve = new Float32Array(CURVE_SIZE);
  const norm = Math.tanh(drive);
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = (i / (CURVE_SIZE - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Tanh saturation (odd harmonics, "warm" overdrive) with 4x oversampling to keep aliasing down.
 * Loudness grows with drive, so the wet path is auto-compensated by 1/sqrt(drive); `level` trims on top.
 */
export class Distortion extends BaseEffect {
  readonly descriptor = DISTORTION_DESCRIPTOR;
  private shaper: WaveShaperNode;
  private tone: BiquadFilterNode;
  private wet: GainNode;
  private dry: GainNode;
  private lastDrive = 0;

  constructor(ctx: AudioContext, data: Record<string, unknown>) {
    super(ctx);
    this.shaper = this.track(ctx.createWaveShaper());
    this.shaper.oversample = "4x";
    this.tone = this.track(ctx.createBiquadFilter());
    this.tone.type = "lowpass";
    this.tone.Q.value = BUTTERWORTH_Q_DB; // flat: no resonant bump (and loop gain can never exceed feedback)
    this.wet = this.track(ctx.createGain());
    this.dry = this.track(ctx.createGain());

    this.fxIn.connect(this.dry);
    this.dry.connect(this.fxOut);
    this.fxIn.connect(this.shaper);
    this.shaper.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.fxOut);
    this.init(data);
  }

  protected apply(v: ParamValues) {
    const drive = v.drive as number;
    if (drive !== this.lastDrive) {
      this.shaper.curve = makeCurve(drive);
      this.lastDrive = drive;
    }
    const mix = v.mix as number;
    this.set(this.tone.frequency, v.tone as number);
    this.set(this.wet.gain, (mix * dbToLinear(v.level as number)) / Math.sqrt(drive));
    this.set(this.dry.gain, 1 - mix);
  }
}
