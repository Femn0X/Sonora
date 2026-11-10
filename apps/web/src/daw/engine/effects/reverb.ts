import type { PluginDescriptor, ParamValues } from "../plugins/params";
import { BUTTERWORTH_Q_DB } from "../plugins/audioParam";
import { mulberry32 } from "../plugins/random";
import { BaseEffect } from "./types";

export const REVERB_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.reverb",
  displayName: "Reverb",
  category: "effect",
  params: [
    { key: "decay", label: "Decay", min: 0.2, max: 8, default: 2, unit: "s", scale: "log" },
    { key: "preDelayMs", label: "Pre-delay", min: 0, max: 200, default: 20, step: 1, unit: "ms" },
    { key: "tone", label: "Tone", min: 1000, max: 20000, default: 8000, unit: "Hz", scale: "log" },
    { key: "mix", label: "Mix", min: 0, max: 1, default: 0.25, step: 0.01 },
  ],
};

/**
 * Synthetic stereo impulse response: decorrelated noise with an exponential decay that reaches
 * -60 dB at `decay` seconds (the standard RT60 definition). Seeded, so it's reproducible.
 */
export function buildImpulse(ctx: BaseAudioContext, decaySeconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(Math.min(decaySeconds, 8) * sr));
  const buffer = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(0x9e3779b9 + ch * 7919);
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const envelope = Math.pow(10, (-3 * t) / decaySeconds); // -60 dB at t = decay
      const onset = Math.min(1, t / 0.0015); // 1.5ms fade-in avoids a click on the first sample
      data[i] = (rand() * 2 - 1) * envelope * onset;
    }
  }
  return buffer;
}

/**
 * Convolution reverb.
 *   fxIn ─┬─ dry ─────────────────────────────┬─> fxOut
 *         └─ pre-delay ─ convolver ─ tone ─ wet ┘
 * Changing `decay` regenerates the impulse (a brief artifact is possible while it swaps); every
 * other parameter changes smoothly.
 */
export class Reverb extends BaseEffect {
  readonly descriptor = REVERB_DESCRIPTOR;
  private pre: DelayNode;
  private convolver: ConvolverNode;
  private tone: BiquadFilterNode;
  private wet: GainNode;
  private dry: GainNode;
  private lastDecay = 0;

  constructor(ctx: AudioContext, data: Record<string, unknown>) {
    super(ctx);
    this.pre = this.track(ctx.createDelay(0.25));
    this.convolver = this.track(ctx.createConvolver());
    this.tone = this.track(ctx.createBiquadFilter());
    this.tone.type = "lowpass";
    this.tone.Q.value = BUTTERWORTH_Q_DB; // flat: no resonant bump (and loop gain can never exceed feedback)
    this.wet = this.track(ctx.createGain());
    this.dry = this.track(ctx.createGain());

    this.fxIn.connect(this.dry);
    this.dry.connect(this.fxOut);
    this.fxIn.connect(this.pre);
    this.pre.connect(this.convolver);
    this.convolver.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.fxOut);
    this.init(data);
  }

  protected apply(v: ParamValues) {
    const decay = v.decay as number;
    // Only rebuild when decay actually moved: it's the one expensive parameter.
    if (Math.abs(Math.log(decay / (this.lastDecay || decay * 2))) > 0.01) {
      this.convolver.buffer = buildImpulse(this.ctx, decay);
      this.lastDecay = decay;
    }
    this.set(this.pre.delayTime, (v.preDelayMs as number) / 1000);
    this.set(this.tone.frequency, v.tone as number);
    this.set(this.wet.gain, v.mix as number);
    this.set(this.dry.gain, 1 - (v.mix as number));
  }
}
