import type { PluginDescriptor } from "../plugins/params";
import { sampleLibrary } from "../samples/sampleLibrary";
import { DescriptorInstrument, buildAmpEnvelope, runSources, type VoiceContext, type VoiceSpec } from "./common";

/**
 * Sampler ("sonora.sampler"): plays a decoded audio sample (a recorded voice, a one-shot, a loop) across the keyboard.
 *
 * The project stores only the sample's id (and a display name); the audio lives in the sample library and is looked up
 * at note time, so a sample that arrives after the instrument was created (loaded from storage, imported) starts
 * sounding immediately, and a MISSING sample is simply silent instead of an error.
 *
 *   pitched: the note repitches the sample around `rootNote`; releasing the key fades it out
 *   oneshot: always plays at original speed to the end, ignoring the key length (drums, vocal hits)
 */
export interface SamplerPreset {
  sampleId: string; sampleName: string; rootNote: number; tuneCents: number; mode: "pitched" | "oneshot";
  loop: "off" | "on"; startOffset: number; attack: number; release: number; gain: number;
}

export const SAMPLER_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.sampler",
  displayName: "Sampler",
  category: "instrument",
  params: [
    { kind: "string", key: "sampleId", label: "Sample", default: "", maxLength: 64, hidden: true },
    { kind: "string", key: "sampleName", label: "Sample name", default: "", maxLength: 80 },
    { key: "rootNote", label: "Root note", min: 0, max: 127, default: 60, step: 1 },
    { key: "tuneCents", label: "Fine tune", min: -100, max: 100, default: 0, step: 1, unit: "ct" },
    { kind: "enum", key: "mode", label: "Mode", default: "pitched", options: [{ value: "pitched", label: "Pitched" }, { value: "oneshot", label: "One-shot" }] },
    { kind: "enum", key: "loop", label: "Loop", default: "off", options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }] },
    { key: "startOffset", label: "Start", min: 0, max: 0.99, default: 0, step: 0.01 },
    { key: "attack", label: "Attack", min: 0.001, max: 4, default: 0.003, unit: "s", scale: "log" },
    { key: "release", label: "Release", min: 0.01, max: 6, default: 0.15, unit: "s", scale: "log" },
    { key: "gain", label: "Gain", min: 0, max: 1.5, default: 0.8, step: 0.01 },
  ],
};

export class Sampler extends DescriptorInstrument<SamplerPreset> {
  readonly descriptor = SAMPLER_DESCRIPTOR;
  protected maxVoices = 32;

  constructor(ctx: AudioContext, presetData: Record<string, unknown>) {
    super(ctx);
    this.init(presetData);
  }

  protected buildVoice({ ctx, params: p, t, pitch, velocity, durationSec }: VoiceContext<SamplerPreset>): VoiceSpec {
    const sample = p.sampleId ? sampleLibrary.get(p.sampleId) : undefined;
    const src = ctx.createBufferSource();
    if (!sample) {
      // Missing sample: a silent voice (keeps the tracker/engine path uniform, and never throws mid-playback)
      const silent = ctx.createGain();
      silent.gain.value = 0;
      src.connect(silent);
      runSources([src], t, t + 0.01);
      return { output: silent, releaseGain: silent, sources: [src] };
    }

    const rate = (p.mode === "pitched" ? Math.pow(2, (pitch - p.rootNote) / 12) : 1) * Math.pow(2, p.tuneCents / 1200);
    src.buffer = sample.buffer;
    src.playbackRate.value = rate;
    const offsetSec = sample.buffer.duration * p.startOffset;
    if (p.loop === "on") {
      src.loop = true;
      src.loopStart = offsetSec;
      src.loopEnd = sample.buffer.duration;
    }

    // One-shots ignore the key length and play out; pitched notes follow it.
    const playLength = (sample.buffer.duration - offsetSec) / rate;
    const gateSec = p.mode === "oneshot" && p.loop === "off" ? playLength : durationSec;
    const amp = buildAmpEnvelope(ctx, { attack: p.attack, decay: 0.01, sustain: 1, release: p.release }, velocity * p.gain, t, gateSec);
    src.connect(amp.input);
    src.start(t, offsetSec);
    src.stop(amp.stopAt);
    return { output: amp.output, releaseGain: amp.output, sources: [src] };
  }
}
