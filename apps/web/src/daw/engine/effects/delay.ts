import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { BUTTERWORTH_Q_DB } from "../plugins/audioParam";
import { BaseEffect } from "./types";

export const DELAY_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.delay",
  displayName: "Delay",
  category: "effect",
  params: [
    { key: "timeMs", label: "Time", min: 1, max: 2000, default: 350, unit: "ms", scale: "log" },
    // Capped below 1: feedback >= 1 never decays and would build up forever.
    { key: "feedback", label: "Feedback", min: 0, max: 0.9, default: 0.35, step: 0.01 },
    { key: "tone", label: "Tone", min: 500, max: 16000, default: 5000, unit: "Hz", scale: "log" },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.3, step: 0.01 },
  ],
};

/**
 * Feedback delay. Each repeat passes through a lowpass, so echoes get progressively darker
 * (the classic analog/tape character) and the loop is always stable.
 *
 *   fxIn ─┬─ dry ────────────────────────────┬─> fxOut
 *         └─ delay ─ tone ─┬─ wet ───────────┘
 *              ^           └─ feedback ─┐
 *              └──────────────────────────┘
 */
export class Delay extends BaseEffect {
  readonly descriptor = DELAY_DESCRIPTOR;
  private delay: DelayNode;
  private tone: BiquadFilterNode;
  private feedback: GainNode;
  private wet: GainNode;
  private dry: GainNode;

  constructor(ctx: AudioContext, data: Record<string, unknown>) {
    super(ctx);
    this.delay = this.track(ctx.createDelay(2));
    this.tone = this.track(ctx.createBiquadFilter());
    this.tone.type = "lowpass";
    this.tone.Q.value = BUTTERWORTH_Q_DB; // flat: no resonant bump (and loop gain can never exceed feedback)
    this.feedback = this.track(ctx.createGain());
    this.wet = this.track(ctx.createGain());
    this.dry = this.track(ctx.createGain());

    this.fxIn.connect(this.dry);
    this.dry.connect(this.fxOut);
    this.fxIn.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.fxOut);
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.init(data);
  }

  protected apply(v: ParamValues) {
    this.set(this.delay.delayTime, (v.timeMs as number) / 1000);
    this.set(this.feedback.gain, v.feedback as number);
    this.set(this.tone.frequency, v.tone as number);
    this.set(this.wet.gain, v.mix as number);
    this.set(this.dry.gain, 1 - (v.mix as number));
  }
}
