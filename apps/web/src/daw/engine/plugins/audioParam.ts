/**
 * Click-free parameter changes.
 *
 * Built from setValueAtTime + linearRamp ONLY (never setTargetAtTime chained after other events):
 * setTarget-after-other-automation is evaluated inconsistently across Web Audio implementations and
 * blew up held synth notes (see docs/DAW-ENGINE.md). Ramps behave identically everywhere.
 */
export function smooth(context: BaseAudioContext, param: AudioParam, value: number, seconds = 0.02) {
  const now = context.currentTime;
  // At time 0 nothing has played yet, so there is nothing to click: set instantly. This matters for
  // offline rendering, where a 10ms ramp from the default would partly fade (or leak) the first notes.
  if (now === 0) {
    param.value = value;
    return;
  }
  const current = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  param.linearRampToValueAtTime(value, now + seconds);
}

export const dbToLinear = (db: number) => Math.pow(10, db / 20);

/**
 * Q for a maximally-flat (Butterworth) lowpass, in the dB units Web Audio uses for lowpass Q
 * (20*log10(1/sqrt(2))). The default (1 dB) has a resonant peak above unity gain at the cutoff,
 * which is audible as a bump on a "tone" knob and, inside a feedback loop, makes the loop gain
 * exceed 1 so the delay runs away at high feedback.
 */
export const BUTTERWORTH_Q_DB = -3.0103;
