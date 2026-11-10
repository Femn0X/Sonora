/**
 * One mixer channel strip = one small Web Audio subgraph:
 *
 *   instrument voices -> input -> [insert effects] -> gainNode -> panNode -> analyser -> destination
 *
 * Mute/solo are implemented as gain multipliers rather than disconnecting
 * nodes, so toggling them doesn't click/pop and doesn't require rebuilding
 * the graph.
 */

import { EffectChain } from "./effects/effectChain";
import { smooth } from "./plugins/audioParam";

export class MixerChannel {
  readonly id: string;
  private context: AudioContext;
  readonly input: GainNode; // clips/instruments connect here
  private gainNode: GainNode;
  private panNode: StereoPannerNode;
  readonly analyser: AnalyserNode;
  /** Insert effects between `input` and the fader. */
  readonly inserts: EffectChain;
  /** Reused every frame (fftSize is 256) so metering allocates nothing. Type is inferred to stay TS-version agnostic. */
  private meterBuffer = new Uint8Array(256);

  private baseVolumeDb = 0;
  private muted = false;
  /** Set by the mixer when ANY track is soloed, so non-soloed tracks self-silence */
  private soloActive = false;
  private isSoloed = false;

  constructor(context: AudioContext, id: string, destination: AudioNode) {
    this.context = context;
    this.id = id;
    this.input = context.createGain();
    this.gainNode = context.createGain();
    this.panNode = context.createStereoPanner();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;

    // The chain owns input -> gainNode (directly when empty, through the effects otherwise).
    this.inserts = new EffectChain(context, this.input, this.gainNode);
    this.gainNode.connect(this.panNode);
    this.panNode.connect(this.analyser);
    this.analyser.connect(destination);
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }

  setVolumeDb(db: number) {
    // Project JSON is untrusted (forks/remixes): never let a bad value become effectively infinite gain.
    this.baseVolumeDb = Number.isFinite(db) ? Math.max(-80, Math.min(12, db)) : 0;
    this.applyGain();
  }

  setPan(pan: number) {
    smooth(this.context, this.panNode.pan, Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0, 0.01);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyGain();
  }

  setSoloed(soloed: boolean) {
    this.isSoloed = soloed;
    this.applyGain();
  }

  /** Called by the parent Mixer whenever the global solo state changes */
  setSoloActive(active: boolean) {
    this.soloActive = active;
    this.applyGain();
  }

  private applyGain() {
    const silencedBySolo = this.soloActive && !this.isSoloed;
    const effectiveGain = this.muted || silencedBySolo ? 0 : this.dbToLinear(this.baseVolumeDb);
    // A short ramp avoids audible clicks when toggling mute/solo mid-playback.
    smooth(this.context, this.gainNode.gain, effectiveGain, 0.01);
  }

  /** Disconnect this strip from the graph (track removed) */
  dispose() {
    this.inserts.dispose();
    for (const node of [this.input, this.gainNode, this.panNode, this.analyser]) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Simple peak-level read for the UI meter (poll on rAF, not audio thread). Reuses one buffer: no per-frame allocation. */
  getPeakLevel(): number {
    this.analyser.getByteTimeDomainData(this.meterBuffer);
    let peak = 0;
    for (const v of this.meterBuffer) peak = Math.max(peak, Math.abs(v - 128) / 128);
    return peak;
  }
}
