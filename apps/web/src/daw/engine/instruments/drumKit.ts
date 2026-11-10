import { velocityToGain, type Instrument, type TriggerParams } from "./types";
import { VoiceTracker } from "./voiceTracker";
import type { PluginDescriptor } from "../plugins/params";
import { mulberry32 } from "../plugins/random";

/**
 * Sonora Drums ("sonora.drums") — a fully synthesized drum kit. No sample
 * files, so it works instantly, costs no storage, and has no missing-asset
 * failure mode. Pads are addressed by General-MIDI drum note numbers, which
 * means a drum clip is an ordinary MidiClip (diffable, mergeable, editable in
 * either the step sequencer or the piano roll).
 */

export interface DrumPad {
  pitch: number;
  id: string;
  name: string;
  /** Pads in the same choke group cut each other off (closed hat chokes open hat) */
  chokeGroup?: string;
}

export const DRUM_PADS: DrumPad[] = [
  { pitch: 36, id: "kick", name: "Kick" },
  { pitch: 38, id: "snare", name: "Snare" },
  { pitch: 39, id: "clap", name: "Clap" },
  { pitch: 42, id: "chat", name: "Closed Hat", chokeGroup: "hat" },
  { pitch: 46, id: "ohat", name: "Open Hat", chokeGroup: "hat" },
  { pitch: 45, id: "tom", name: "Tom" },
  { pitch: 37, id: "rim", name: "Rim" },
  { pitch: 49, id: "crash", name: "Crash" },
];

export const DRUM_PAD_BY_PITCH = new Map(DRUM_PADS.map((p) => [p.pitch, p]));

export interface DrumKitPreset {
  /** Overall kit level 0-1 */
  level: number;
  /** Per-pad level multiplier, keyed by MIDI pitch */
  padLevels: Record<string, number>;
  /** Kick base pitch in Hz (808-style tuning lives here) */
  kickHz: number;
}

export const DEFAULT_DRUM_PRESET: DrumKitPreset = { level: 0.55, padLevels: {}, kickHz: 48 };

export const DRUM_PRESETS: Record<string, { name: string; preset: DrumKitPreset }> = {
  punchy: { name: "Punchy Kit", preset: DEFAULT_DRUM_PRESET },
  deep: { name: "Deep 808 Kit", preset: { level: 0.55, padLevels: { "36": 1.2 }, kickHz: 38 } },
};

/** What the editor UI shows. (Per-pad levels live in presetData too but aren't exposed as knobs yet.) */
export const DRUM_DESCRIPTOR: PluginDescriptor = {
  pluginId: "sonora.drums",
  displayName: "Sonora Drums",
  category: "instrument",
  params: [
    { key: "level", label: "Level", min: 0, max: 1.5, default: DEFAULT_DRUM_PRESET.level, step: 0.01 },
    { key: "kickHz", label: "Kick pitch", min: 25, max: 120, default: DEFAULT_DRUM_PRESET.kickHz, step: 1, unit: "Hz" },
  ],
};

function sanitizeDrumPreset(data: Record<string, unknown>): DrumKitPreset {
  const level = typeof data.level === "number" && Number.isFinite(data.level) ? Math.max(0, Math.min(1.5, data.level)) : DEFAULT_DRUM_PRESET.level;
  const kickHz = typeof data.kickHz === "number" && Number.isFinite(data.kickHz) ? Math.max(25, Math.min(120, data.kickHz)) : DEFAULT_DRUM_PRESET.kickHz;
  const padLevels: Record<string, number> = {};
  if (data.padLevels && typeof data.padLevels === "object") {
    for (const [k, v] of Object.entries(data.padLevels as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) padLevels[k] = Math.max(0, Math.min(2, v));
    }
  }
  return { level, padLevels, kickHz };
}

interface DrumVoice {
  /** Envelope node (faded on Stop) */
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  /**
   * Last node before the output, used ONLY for choking. Choke automation must
   * not share a param with the envelope: layering setTarget on top of an
   * in-flight exponentialRamp is ill-defined in the Web Audio spec and
   * misbehaves across implementations.
   */
  choke?: GainNode;
}

export class SonoraDrumKit implements Instrument {
  readonly pluginId = "sonora.drums";
  private preset: DrumKitPreset;
  private tracker: VoiceTracker;
  private noise: AudioBuffer;
  /** Seeded, so a project's drums sound identical every time (see plugins/random.ts) */
  private rand = mulberry32(0x5eed1234);
  /** Most recent voice per choke group, so a later hit can cut it off */
  private chokeVoices = new Map<string, { choke: GainNode; startTime: number }>();

  constructor(private context: AudioContext, presetData: Record<string, unknown>) {
    this.preset = sanitizeDrumPreset(presetData);
    this.tracker = new VoiceTracker(context, 48);
    // 2.5s of white noise, shared by every noise-based drum. Each hit starts at a (seeded) pseudo-random
    // offset so repeated hats/snares don't sound machine-gunned, yet renders stay reproducible.
    const length = Math.floor(context.sampleRate * 2.5);
    this.noise = context.createBuffer(1, length, context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = this.rand() * 2 - 1;
  }

  trigger({ destination, pitch, velocity, startTime }: TriggerParams) {
    const pad = DRUM_PAD_BY_PITCH.get(pitch);
    if (!pad) return; // not a pad in this kit — silently ignore, like a real drum rack
    const t = Math.max(startTime, this.context.currentTime);
    const level = velocityToGain(velocity) * this.preset.level * (this.preset.padLevels[String(pitch)] ?? 1);

    if (pad.chokeGroup) {
      const prev = this.chokeVoices.get(pad.chokeGroup);
      if (prev && prev.startTime <= t) {
        // Ramps only (see synth.ts): a ~8ms fade avoids a click without relying on setTarget semantics.
        prev.choke.gain.setValueAtTime(1, t);
        prev.choke.gain.linearRampToValueAtTime(0, t + 0.008);
      }
    }

    let voice: DrumVoice;
    switch (pad.id) {
      case "kick":
        voice = this.kick(destination, t, level);
        break;
      case "snare":
        voice = this.snare(destination, t, level);
        break;
      case "clap":
        voice = this.clap(destination, t, level);
        break;
      case "chat":
        voice = this.hat(destination, t, level, 0.05);
        break;
      case "ohat":
        voice = this.hat(destination, t, level, 0.4);
        break;
      case "tom":
        voice = this.tom(destination, t, level);
        break;
      case "rim":
        voice = this.rim(destination, t, level);
        break;
      default:
        voice = this.crash(destination, t, level);
    }

    if (pad.chokeGroup && voice.choke) this.chokeVoices.set(pad.chokeGroup, { choke: voice.choke, startTime: t });
    this.tracker.add({ ...voice, startTime: t }, voice.sources[0]);
  }

  // --- helpers -----------------------------------------------------------

  private noiseSource(t: number, duration: number) {
    const src = this.context.createBufferSource();
    src.buffer = this.noise;
    src.start(t, this.rand() * (this.noise.duration - duration - 0.05), duration);
    return src;
  }

  private envelope(t: number, peak: number, decay: number) {
    const g = this.context.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(peak, t);
    // Ramp to -60 dB (the usual "decay time" convention); a -80 dB floor would make
    // the audible tail only about half the nominal length.
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    g.gain.setValueAtTime(0, t + decay + 0.01);
    return g;
  }

  // --- drums ---------------------------------------------------------------

  private kick(dest: AudioNode, t: number, level: number) {
    const ctx = this.context;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(this.preset.kickHz * 3.2, t);
    osc.frequency.exponentialRampToValueAtTime(this.preset.kickHz, t + 0.12);
    const env = this.envelope(t, level, 0.5);
    osc.connect(env);
    env.connect(dest);
    osc.start(t);
    osc.stop(t + 0.55);

    // Short noise click for beater attack
    const click = this.noiseSource(t, 0.012);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const clickEnv = this.envelope(t, level * 0.25, 0.012);
    click.connect(hp);
    hp.connect(clickEnv);
    clickEnv.connect(dest);
    return { gain: env, sources: [osc, click] as AudioScheduledSourceNode[] };
  }

  private snare(dest: AudioNode, t: number, level: number) {
    const ctx = this.context;
    const noise = this.noiseSource(t, 0.25);
    const bp = ctx.createBiquadFilter();
    bp.type = "highpass";
    bp.frequency.value = 1400;
    const nEnv = this.envelope(t, level * 0.55, 0.2);
    noise.connect(bp);
    bp.connect(nEnv);
    nEnv.connect(dest);

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(220, t);
    osc.frequency.exponentialRampToValueAtTime(130, t + 0.08);
    const oEnv = this.envelope(t, level * 0.5, 0.12);
    osc.connect(oEnv);
    oEnv.connect(dest);
    osc.start(t);
    osc.stop(t + 0.15);
    return { gain: nEnv, sources: [noise, osc] as AudioScheduledSourceNode[] };
  }

  private clap(dest: AudioNode, t: number, level: number) {
    const ctx = this.context;
    const noise = this.noiseSource(t, 0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.value = 0;
    // Three quick "hand" bursts, then a decaying tail
    for (let i = 0; i < 3; i++) {
      const bt = t + i * 0.011;
      g.gain.setValueAtTime(level, bt);
      g.gain.exponentialRampToValueAtTime(level * 0.25, bt + 0.010);
    }
    g.gain.setValueAtTime(level, t + 0.033);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.033 + 0.2);
    g.gain.setValueAtTime(0, t + 0.25);
    noise.connect(bp);
    bp.connect(g);
    g.connect(dest);
    return { gain: g, sources: [noise] as AudioScheduledSourceNode[] };
  }

  private hat(dest: AudioNode, t: number, level: number, decay: number) {
    const ctx = this.context;
    const noise = this.noiseSource(t, decay + 0.1);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7500;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 10500;
    bp.Q.value = 0.6;
    const env = this.envelope(t, level * 0.55, decay);
    const choke = ctx.createGain();
    noise.connect(hp);
    hp.connect(bp);
    bp.connect(env);
    env.connect(choke);
    choke.connect(dest);
    return { gain: env, choke, sources: [noise] as AudioScheduledSourceNode[] };
  }

  private tom(dest: AudioNode, t: number, level: number) {
    const osc = this.context.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(170, t);
    osc.frequency.exponentialRampToValueAtTime(95, t + 0.2);
    const env = this.envelope(t, level, 0.4);
    osc.connect(env);
    env.connect(dest);
    osc.start(t);
    osc.stop(t + 0.45);
    return { gain: env, sources: [osc] as AudioScheduledSourceNode[] };
  }

  private rim(dest: AudioNode, t: number, level: number) {
    const ctx = this.context;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 820;
    const oEnv = this.envelope(t, level * 0.35, 0.03);
    osc.connect(oEnv);
    oEnv.connect(dest);
    osc.start(t);
    osc.stop(t + 0.05);

    const noise = this.noiseSource(t, 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3200;
    const nEnv = this.envelope(t, level * 0.5, 0.04);
    noise.connect(bp);
    bp.connect(nEnv);
    nEnv.connect(dest);
    return { gain: oEnv, sources: [osc, noise] as AudioScheduledSourceNode[] };
  }

  private crash(dest: AudioNode, t: number, level: number) {
    const ctx = this.context;
    const noise = this.noiseSource(t, 1.9);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4500;
    const env = this.envelope(t, level * 0.5, 1.7);
    noise.connect(hp);
    hp.connect(env);
    env.connect(dest);
    return { gain: env, sources: [noise] as AudioScheduledSourceNode[] };
  }

  setPreset(presetData: Record<string, unknown>) {
    this.preset = sanitizeDrumPreset(presetData);
  }

  allNotesOff() {
    this.tracker.killAll();
    this.chokeVoices.clear();
  }

  dispose() {
    this.allNotesOff();
  }
}
