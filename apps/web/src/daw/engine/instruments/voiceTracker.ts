/**
 * Tracks live voices so that Stop can silence them instantly. Without this,
 * every note already handed to the Web Audio scheduler (up to the whole
 * lookahead window, plus any long sustained/released note) keeps sounding
 * after the user presses stop.
 */

export interface ActiveVoice {
  /** The voice's final envelope gain node (what gets faded on kill) */
  gain: GainNode;
  /** Every source node that must be stopped when the voice is killed */
  sources: AudioScheduledSourceNode[];
  /** When the voice starts sounding. Voices still waiting to start don't count toward the voice cap. */
  startTime?: number;
}

type HoldableParam = AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };

export class VoiceTracker {
  private voices = new Set<ActiveVoice>();
  private maxVoices: number;

  constructor(private context: AudioContext, maxVoices = 64) {
    this.maxVoices = maxVoices;
  }

  add(voice: ActiveVoice, endSource: AudioScheduledSourceNode) {
    // Voice stealing caps CPU: when too many voices are SOUNDING, drop the oldest. Voices merely scheduled
    // for the future don't count; otherwise an offline render (which schedules the whole song up front)
    // would start killing notes that haven't even begun.
    const now = this.context.currentTime;
    const sounding = [...this.voices].filter((v) => (v.startTime ?? 0) <= now);
    if (sounding.length >= this.maxVoices) this.kill(sounding[0]);
    this.voices.add(voice);
    endSource.addEventListener("ended", () => {
      this.voices.delete(voice);
      try {
        voice.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    });
  }

  private kill(voice: ActiveVoice) {
    const now = this.context.currentTime;
    const param = voice.gain.gain as HoldableParam;
    const current = param.value;
    if (param.cancelAndHoldAtTime) {
      param.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
    }
    param.linearRampToValueAtTime(0, now + 0.015); // short fade: instant silence without a click
    for (const source of voice.sources) {
      try {
        source.stop(now + 0.06);
      } catch {
        /* already stopped */
      }
    }
    this.voices.delete(voice);
  }

  killAll() {
    for (const voice of [...this.voices]) this.kill(voice);
  }

  get size() {
    return this.voices.size;
  }
}
