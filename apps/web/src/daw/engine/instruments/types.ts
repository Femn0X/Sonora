/**
 * Shared instrument contract. Every built-in instrument (synth, drum kit,
 * sampler, and later third-party/WASM plugins) implements this, so the
 * AudioEngine never needs to know what kind of instrument a track uses.
 */

export interface TriggerParams {
  /** Where the voice's output connects (the track's mixer channel input) */
  destination: AudioNode;
  /** MIDI note number, 0-127 */
  pitch: number;
  /** 0-127 */
  velocity: number;
  /** AudioContext time at which the note starts */
  startTime: number;
  /** Note length in seconds (release tail is added by the instrument) */
  durationSec: number;
}

export interface Instrument {
  readonly pluginId: string;
  trigger(params: TriggerParams): void;
  /** Immediately (but click-free) silence everything, including notes scheduled in the lookahead window. */
  allNotesOff(): void;
  /**
   * Optional live settings update. Notes already sounding keep their old sound; new notes use the new
   * settings. Lets the engine apply knob changes without recreating the instrument (which would cut ringing notes).
   */
  setPreset?(presetData: Record<string, unknown>): void;
  dispose(): void;
}

export function midiToFrequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** Perceptual-ish velocity curve: soft notes are noticeably softer than a linear map. */
export function velocityToGain(velocity: number): number {
  const v = Math.max(0, Math.min(127, velocity)) / 127;
  return Math.pow(v, 1.5);
}
