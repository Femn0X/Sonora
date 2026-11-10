import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { BaseEffect } from "./types";

export const EQ_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.eq",
  displayName: "EQ",
  category: "effect",
  params: [
    { key: "lowFreq", label: "Low freq", min: 40, max: 500, default: 150, unit: "Hz", scale: "log" },
    { key: "lowGain", label: "Low", min: -18, max: 18, default: 0, step: 0.1, unit: "dB" },
    { key: "midFreq", label: "Mid freq", min: 200, max: 8000, default: 1000, unit: "Hz", scale: "log" },
    { key: "midGain", label: "Mid", min: -18, max: 18, default: 0, step: 0.1, unit: "dB" },
    { key: "midQ", label: "Mid Q", min: 0.2, max: 10, default: 1, unit: "", scale: "log" },
    { key: "highFreq", label: "High freq", min: 2000, max: 16000, default: 6000, unit: "Hz", scale: "log" },
    { key: "highGain", label: "High", min: -18, max: 18, default: 0, step: 0.1, unit: "dB" },
  ],
};

/** 3-band EQ: low shelf, parametric mid, high shelf. All gains at 0 dB is transparent. */
export class Eq extends BaseEffect {
  readonly descriptor = EQ_DESCRIPTOR;
  private low: BiquadFilterNode;
  private mid: BiquadFilterNode;
  private high: BiquadFilterNode;

  constructor(ctx: AudioContext, data: Record<string, unknown>) {
    super(ctx);
    this.low = this.track(ctx.createBiquadFilter());
    this.mid = this.track(ctx.createBiquadFilter());
    this.high = this.track(ctx.createBiquadFilter());
    this.low.type = "lowshelf";
    this.mid.type = "peaking";
    this.high.type = "highshelf";
    this.fxIn.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.fxOut);
    this.init(data);
  }

  protected apply(v: ParamValues) {
    this.set(this.low.frequency, v.lowFreq as number);
    this.set(this.low.gain, v.lowGain as number);
    this.set(this.mid.frequency, v.midFreq as number);
    this.set(this.mid.gain, v.midGain as number);
    this.set(this.mid.Q, v.midQ as number);
    this.set(this.high.frequency, v.highFreq as number);
    this.set(this.high.gain, v.highGain as number);
  }
}
