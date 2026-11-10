import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { dbToLinear } from "../plugins/audioParam";
import { BaseEffect } from "./types";

export const COMPRESSOR_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.compressor",
  displayName: "Compressor",
  category: "effect",
  params: [
    { key: "threshold", label: "Threshold", min: -60, max: 0, default: -24, step: 0.5, unit: "dB" },
    { key: "ratio", label: "Ratio", min: 1, max: 20, default: 4, step: 0.1, unit: ":1" },
    { key: "attackMs", label: "Attack", min: 1, max: 200, default: 10, unit: "ms", scale: "log" },
    { key: "releaseMs", label: "Release", min: 20, max: 1000, default: 150, unit: "ms", scale: "log" },
    { key: "knee", label: "Knee", min: 0, max: 40, default: 12, step: 1, unit: "dB" },
    { key: "makeup", label: "Makeup", min: 0, max: 24, default: 0, step: 0.1, unit: "dB" },
  ],
};

/**
 * Feed-forward compressor on the Web Audio DynamicsCompressorNode, plus a manual makeup gain.
 * Note: the node applies its own automatic makeup per the Web Audio spec, so absolute level
 * changes depend on threshold/ratio; the *dynamics* (loud vs quiet) are what this controls.
 */
export class Compressor extends BaseEffect {
  readonly descriptor = COMPRESSOR_DESCRIPTOR;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;

  constructor(ctx: AudioContext, data: Record<string, unknown>) {
    super(ctx);
    this.comp = this.track(ctx.createDynamicsCompressor());
    this.makeup = this.track(ctx.createGain());
    this.fxIn.connect(this.comp);
    this.comp.connect(this.makeup);
    this.makeup.connect(this.fxOut);
    this.init(data);
  }

  protected apply(v: ParamValues) {
    this.set(this.comp.threshold, v.threshold as number);
    this.set(this.comp.ratio, v.ratio as number);
    this.set(this.comp.attack, (v.attackMs as number) / 1000);
    this.set(this.comp.release, (v.releaseMs as number) / 1000);
    this.set(this.comp.knee, v.knee as number);
    this.set(this.makeup.gain, dbToLinear(v.makeup as number));
  }
}
