import { Transport, clampBpm } from "./transport";
import { MixerChannel } from "./mixerChannel";
import { collectNoteEvents } from "./noteScheduling";
import { createInstrument } from "./instruments/registry";
import { EffectChain } from "./effects/effectChain";
import { smooth, dbToLinear } from "./plugins/audioParam";
import type { Instrument } from "./instruments/types";
import type { ProjectManifest, MidiClip, AudioClip, InstrumentRef, Mixer, Track } from "@sonora/schema";

/**
 * AudioEngine is the runtime counterpart to the ProjectManifest: it turns the
 * declarative project data into a live Web Audio graph and drives playback.
 *
 * Key rules:
 *  - loadManifest() is called on EVERY edit (even each mouse-move while
 *    dragging a note). It therefore diffs against the previous manifest and
 *    only touches what changed; it never rebuilds the graph.
 *  - Notes are scheduled window-by-window from the LIVE manifest, so edits made
 *    during playback are heard on the next pass with no restart.
 */

interface LiveInstrument {
  signature: string;
  instrument: Instrument;
}

export class AudioEngine {
  readonly context: AudioContext;
  readonly transport: Transport;
  /** Every channel feeds here; master insert effects follow, then the master fader. */
  private masterIn: GainNode;
  private masterChain: EffectChain;
  private masterFader: GainNode;
  private limiter: DynamicsCompressorNode;
  private masterAnalyser: AnalyserNode;
  private masterMeter = new Uint8Array(256);
  private channels = new Map<string, MixerChannel>();
  private instruments = new Map<string, LiveInstrument>();
  private warnedMissing = new Set<string>();

  private manifest: ProjectManifest | null = null;
  private lastInstruments: InstrumentRef[] | null = null;
  private lastMixer: Mixer | null = null;
  private trackById = new Map<string, Track>();

  private songLoopEnabled = false;
  /** When set, only this clip plays, looped ("pattern mode", like FL Studio's pattern play) */
  private previewClipId: string | null = null;
  private disposed = false;
  private reportedNoteError = false;

  /**
   * @param context Defaults to a real-time AudioContext. Export passes an OfflineAudioContext (cast), so the
   *                exact same graph, effects, mute/solo and master limiter produce the rendered file.
   */
  constructor(context: AudioContext = new AudioContext()) {
    this.context = context;
    // Safety limiter on the master bus so stacked tracks can't clip the output.
    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    //   channels -> masterIn -> [master inserts] -> masterFader -> limiter -> analyser -> speakers
    this.masterIn = this.context.createGain();
    this.masterFader = this.context.createGain();
    this.masterChain = new EffectChain(this.context, this.masterIn, this.masterFader);
    this.masterAnalyser = this.context.createAnalyser();
    this.masterAnalyser.fftSize = 256;
    this.masterFader.connect(this.limiter);
    this.limiter.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.context.destination);
    this.transport = new Transport(this.context);
  }

  // --- project sync ------------------------------------------------------

  loadManifest(manifest: ProjectManifest) {
    if (this.disposed) return;
    this.manifest = manifest;
    this.transport.setBpm(manifest.bpm);
    const masterDb = Number.isFinite(manifest.mixer.masterVolumeDb) ? Math.max(-80, Math.min(12, manifest.mixer.masterVolumeDb)) : 0;
    smooth(this.context, this.masterFader.gain, dbToLinear(masterDb), 0.01);
    this.trackById = new Map(manifest.tracks.map((t) => [t.id, t]));

    if (manifest.instruments !== this.lastInstruments) {
      this.lastInstruments = manifest.instruments;
      this.syncInstruments(manifest.instruments);
    }
    if (manifest.mixer !== this.lastMixer) {
      this.lastMixer = manifest.mixer;
      this.syncChannels(manifest.mixer);
    }
    this.applyLoopSettings();
  }

  private syncInstruments(refs: InstrumentRef[]) {
    const wanted = new Set(refs.map((r) => r.id));
    for (const [id, live] of this.instruments) {
      if (!wanted.has(id)) {
        live.instrument.dispose();
        this.instruments.delete(id);
      }
    }
    for (const ref of refs) {
      const signature = `${ref.pluginId}|${JSON.stringify(ref.presetData)}`;
      const existing = this.instruments.get(ref.id);
      if (existing?.signature === signature) continue;
      // Same plugin, new settings: update in place so ringing notes keep sounding while a knob is dragged.
      if (existing && existing.instrument.pluginId === ref.pluginId && existing.instrument.setPreset) {
        existing.instrument.setPreset(ref.presetData);
        existing.signature = signature;
        continue;
      }
      existing?.instrument.dispose();
      const instrument = createInstrument(this.context, ref.pluginId, ref.presetData);
      if (instrument) {
        this.instruments.set(ref.id, { signature, instrument });
      } else {
        this.instruments.delete(ref.id);
        if (!this.warnedMissing.has(ref.id)) {
          this.warnedMissing.add(ref.id);
          console.warn(`[engine] Instrument "${ref.pluginId}" is not available; its tracks will be silent (preset data is preserved).`);
        }
      }
    }
  }

  private syncChannels(mixer: Mixer) {
    const wanted = new Set(mixer.strips.map((s) => s.trackId));
    for (const [id, channel] of this.channels) {
      if (!wanted.has(id)) {
        channel.dispose();
        this.channels.delete(id);
      }
    }
    const anySoloed = mixer.strips.some((s) => s.soloed);
    for (const strip of mixer.strips) {
      const channel = this.channelFor(strip.trackId);
      channel.setVolumeDb(strip.volumeDb);
      channel.setPan(strip.pan);
      channel.setMuted(strip.muted);
      channel.setSoloed(strip.soloed);
      channel.inserts.sync(strip.inserts ?? []);
    }
    this.masterChain.sync(mixer.masterInserts ?? []);
    for (const channel of this.channels.values()) channel.setSoloActive(anySoloed);
  }

  /** A track without a mixer strip still plays (at unity) instead of going silent. */
  private channelFor(trackId: string): MixerChannel {
    let channel = this.channels.get(trackId);
    if (!channel) {
      channel = new MixerChannel(this.context, trackId, this.masterIn);
      this.channels.set(trackId, channel);
    }
    return channel;
  }

  // --- loop range ----------------------------------------------------------

  private beatsPerBar() {
    const n = this.manifest?.timeSignature?.[0];
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 4;
  }

  /** End of the arrangement content, rounded up to a whole bar (min 1 bar). */
  private songEndBeat(): number {
    const bar = this.beatsPerBar();
    let end = 0;
    for (const clip of this.manifest?.clips ?? []) end = Math.max(end, clip.startBeat + clip.lengthBeats);
    return Math.max(bar, Math.ceil(end / bar - 1e-9) * bar);
  }

  private applyLoopSettings() {
    if (this.previewClipId) {
      const clip = this.manifest?.clips.find((c) => c.id === this.previewClipId);
      if (clip) {
        this.transport.setLoop(true, clip.startBeat, clip.startBeat + clip.lengthBeats);
        return;
      }
    }
    this.transport.setLoop(this.songLoopEnabled, 0, this.songEndBeat());
  }

  setLoopEnabled(enabled: boolean) {
    this.songLoopEnabled = enabled;
    this.applyLoopSettings();
  }

  // --- transport -----------------------------------------------------------

  get isPlaying() {
    return this.transport.isPlaying;
  }

  get previewing(): string | null {
    return this.previewClipId;
  }

  async resume() {
    // Browsers start AudioContexts suspended until a user gesture.
    if (this.context.state === "suspended") await this.context.resume();
  }

  /** Song mode: play the whole arrangement from the current position. */
  async play() {
    await this.resume();
    if (this.isPlaying) return;
    this.previewClipId = null;
    this.applyLoopSettings();
    this.transport.play(this.transport.getCurrentBeat(), (from, to, toTime) => this.scheduleWindow(from, to, toTime));
  }

  /** Pattern mode: loop a single clip in isolation. */
  async playClip(clipId: string) {
    const clip = this.manifest?.clips.find((c) => c.id === clipId);
    if (!clip) return;
    await this.resume();
    if (this.isPlaying) this.silenceAndHalt();
    this.previewClipId = clipId;
    this.applyLoopSettings();
    this.transport.play(clip.startBeat, (from, to, toTime) => this.scheduleWindow(from, to, toTime));
  }

  pause() {
    this.transport.pause();
    this.allNotesOff();
  }

  stop() {
    this.silenceAndHalt();
    this.previewClipId = null;
    this.applyLoopSettings();
  }

  private silenceAndHalt() {
    this.transport.stop(0);
    this.allNotesOff();
  }

  seek(beat: number) {
    const target = Math.max(0, beat);
    if (this.isPlaying && !this.previewClipId) {
      this.transport.stop(target);
      this.allNotesOff();
      this.transport.play(target, (from, to, toTime) => this.scheduleWindow(from, to, toTime));
    } else if (!this.isPlaying) {
      this.transport.setPosition(target);
    }
  }

  private allNotesOff() {
    for (const live of this.instruments.values()) live.instrument.allNotesOff();
  }

  // --- scheduling ------------------------------------------------------------

  private scheduleWindow(from: number, to: number, toTime: (beat: number) => number) {
    if (!this.manifest) return;
    for (const clip of this.manifest.clips) {
      if (this.previewClipId && clip.id !== this.previewClipId) continue;
      if (clip.type === "midi") this.scheduleMidiClip(clip, from, to, toTime);
      else this.scheduleAudioClip(clip, from, to);
    }
  }

  private instrumentForTrack(trackId: string, clip: MidiClip): Instrument | undefined {
    const instrumentId = this.trackById.get(trackId)?.instrumentId || clip.instrumentId;
    return instrumentId ? this.instruments.get(instrumentId)?.instrument : undefined;
  }

  private scheduleMidiClip(clip: MidiClip, from: number, to: number, toTime: (beat: number) => number) {
    const events = collectNoteEvents(clip, from, to);
    if (events.length === 0) return;
    const instrument = this.instrumentForTrack(clip.trackId, clip);
    if (!instrument) return;
    const channel = this.channelFor(clip.trackId);

    for (const e of events) {
      // One bad note must never take down the rest of the window (or the whole scheduler).
      try {
        const startTime = toTime(e.startBeat);
        instrument.trigger({
          destination: channel.input,
          pitch: e.pitch,
          velocity: e.velocity,
          startTime,
          durationSec: Math.max(0.01, toTime(e.startBeat + e.lengthBeats) - startTime),
        });
      } catch (error) {
        if (!this.reportedNoteError) {
          this.reportedNoteError = true;
          console.warn("[engine] a note could not be played and was skipped:", error);
        }
      }
    }
  }

  /**
   * Offline rendering: schedule the whole song [0, endBeat) in one go at the project tempo. There is no
   * lookahead timer offline, so this replaces the transport. Tempo is constant (the engine has no tempo map yet).
   */
  scheduleOffline(endBeat: number) {
    if (!this.manifest || !Number.isFinite(endBeat) || endBeat <= 0) return;
    const bpm = clampBpm(this.manifest.bpm);
    this.scheduleWindow(0, endBeat, (beat) => (beat * 60) / bpm);
  }

  private scheduleAudioClip(_clip: AudioClip, _from: number, _to: number) {
    // Audio clips need the asset decode/cache pipeline (ARCHITECTURE §4.5/4.6),
    // which is a separate milestone. Intentionally a no-op, not faked.
  }

  // --- auditioning (piano roll keys, drum pads, note placement) --------------

  /** Play a one-off note on a track's instrument right now. */
  async auditionNote(trackId: string, pitch: number, velocity = 100, durationSec = 0.3) {
    if (this.disposed || !this.manifest) return;
    await this.resume();
    const track = this.trackById.get(trackId);
    const instrument = track?.instrumentId ? this.instruments.get(track.instrumentId)?.instrument : undefined;
    if (!instrument) return;
    instrument.trigger({
      destination: this.channelFor(trackId).input,
      pitch,
      velocity,
      startTime: this.context.currentTime + 0.005,
      durationSec,
    });
  }

  // --- metering (UI polls these on requestAnimationFrame) ---------------------------

  getPeak(trackId: string): number {
    return this.channels.get(trackId)?.getPeakLevel() ?? 0;
  }

  getMasterPeak(): number {
    this.masterAnalyser.getByteTimeDomainData(this.masterMeter);
    let peak = 0;
    for (const v of this.masterMeter) peak = Math.max(peak, Math.abs(v - 128) / 128);
    return peak;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.dispose();
    for (const live of this.instruments.values()) live.instrument.dispose();
    this.instruments.clear();
    for (const channel of this.channels.values()) channel.dispose();
    this.channels.clear();
    this.masterChain.dispose();
    // OfflineAudioContext has no close(); a real AudioContext should be released.
    if (typeof this.context.close === "function" && this.context.state !== "closed") void this.context.close();
  }
}
