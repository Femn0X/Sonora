/**
 * Transport — sample-accurate playback scheduling.
 *
 * Why lookahead scheduling (ARCHITECTURE §15): setTimeout/rAF jitter by tens
 * of ms under main-thread load. So a cheap timer fires every 25ms and
 * schedules everything in the next ~100ms against the AudioContext's own
 * clock; the audio nodes then start sample-accurately regardless of JS jitter.
 *
 * Timeline model: playback is a list of *segments*
 *     { audioTime, beat, bpm }
 * meaning "at audioTime the timeline was at `beat`, advancing at `bpm`".
 * A tempo change or a loop wrap simply appends a segment. This one mechanism
 * keeps the scheduler, the playhead, and beat->time conversion consistent
 * across loops and live tempo edits, without drift.
 */

/** Tempo sanity limits (project data is untrusted): see Transport.setBpm */
export function clampBpm(requested: number): number {
  return Number.isFinite(requested) ? Math.max(10, Math.min(2000, requested)) : 120;
}

export type BeatToAudioTime = (beat: number) => number;
/** Called with consecutive half-open windows [fromBeat, toBeat). */
export type WindowCallback = (fromBeat: number, toBeat: number, toAudioTime: BeatToAudioTime) => void;

interface Segment {
  audioTime: number;
  beat: number;
  bpm: number;
}

import { createTickTimer, type TickTimer } from "./schedulerTimer";

/** Minimal slice of AudioContext the transport needs (lets tests fake it). */
export interface ClockSource {
  readonly currentTime: number;
}

export class Transport {
  private lookaheadMs = 25;
  private scheduleAheadSec = 0.1;
  /** Small head start so the first notes aren't already late when scheduled */
  private startLeadSec = 0.06;
  private timer: TickTimer | null = null;

  private bpm = 120;
  private playing = false;
  /** Position while stopped/paused */
  private restingBeat = 0;

  private segments: Segment[] = [];
  private cursor = 0; // next beat not yet handed to the callback
  private onWindow: WindowCallback | null = null;

  private loop = { enabled: false, start: 0, end: 0 };

  constructor(
    private clock: ClockSource,
    /** Where the 25ms heartbeat comes from. Defaults to a Web Worker (not throttled in background tabs). */
    private timerFactory: () => TickTimer = createTickTimer,
  ) {}

  get isPlaying() {
    return this.playing;
  }

  getBpm() {
    return this.bpm;
  }

  setBpm(requested: number) {
    // Untrusted project data: 0/NaN would divide by zero, and an absurd tempo makes each tick cover so many
    // beats that a short loop would wrap millions of times in one go (a frozen tab).
    const bpm = clampBpm(requested);
    if (bpm === this.bpm) return;
    if (this.playing) {
      // Re-anchor at the scheduling cursor so already-scheduled audio stays
      // valid and everything after it runs at the new tempo.
      const last = this.last();
      const cursorTime = this.segToTime(last, this.cursor);
      this.segments.push({ audioTime: cursorTime, beat: this.cursor, bpm });
    }
    this.bpm = bpm;
  }

  setLoop(enabled: boolean, startBeat = 0, endBeat = 0) {
    this.loop = { enabled: enabled && endBeat > startBeat, start: startBeat, end: endBeat };
  }

  private last(): Segment {
    return this.segments[this.segments.length - 1];
  }

  private segToTime(seg: Segment, beat: number) {
    return seg.audioTime + ((beat - seg.beat) * 60) / seg.bpm;
  }

  /** Current position in beats, derived from the audio clock (never drifts). */
  getCurrentBeat(): number {
    if (!this.playing) return this.restingBeat;
    const now = this.clock.currentTime;
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.audioTime <= now) seg = s;
      else break;
    }
    const elapsed = Math.max(0, now - seg.audioTime);
    const beat = seg.beat + (elapsed * seg.bpm) / 60;

    // If the scheduler is late (e.g. a throttled background tab ticking once a second), the audio
    // clock can pass the loop end before the wrap segment has been scheduled. The wrap is
    // deterministic, so show where the playhead *will* be instead of running past the loop end.
    // (This is display only: it must never be relied on to hide scheduling problems.)
    const { enabled, start, end } = this.loop;
    if (enabled && seg.beat < end && beat >= end) return start + ((beat - start) % (end - start));
    return beat;
  }

  /** Audio-context time at which `beat` will sound, per the newest segment. */
  beatToAudioTime(beat: number): number {
    if (!this.playing) return this.clock.currentTime;
    return this.segToTime(this.last(), beat);
  }

  play(fromBeat: number, onWindow: WindowCallback) {
    if (this.playing) return;
    this.playing = true;
    this.onWindow = onWindow;
    this.cursor = fromBeat;
    this.segments = [{ audioTime: this.clock.currentTime + this.startLeadSec, beat: fromBeat, bpm: this.bpm }];
    this.tick();
    this.timer ??= this.timerFactory();
    this.timer.start(() => this.tick(), this.lookaheadMs);
  }

  /** Stops scheduling and remembers where playback was (pause semantics). */
  pause() {
    if (!this.playing) return;
    this.restingBeat = this.getCurrentBeat();
    this.halt();
  }

  /** Stops scheduling and moves the playhead to `toBeat`. */
  stop(toBeat = 0) {
    this.halt();
    this.restingBeat = toBeat;
  }

  setPosition(beat: number) {
    if (!this.playing) this.restingBeat = beat;
  }

  private halt() {
    this.playing = false;
    this.timer?.stop();
    this.onWindow = null;
    this.segments = [];
  }

  /** Release the heartbeat (terminates the worker). Call when the engine is disposed. */
  dispose() {
    this.halt();
    this.timer?.dispose();
    this.timer = null;
  }

  /** One scheduler pass. Public so tests can drive it with a fake clock. */
  tick() {
    if (!this.playing || !this.onWindow) return;
    const until = this.clock.currentTime + this.scheduleAheadSec;

    // Drop segments the audio clock has already moved past (keep one for the playhead)
    while (this.segments.length > 1 && this.segments[1].audioTime <= this.clock.currentTime) this.segments.shift();

    let seg = this.last();
    let target = seg.beat + ((until - seg.audioTime) * seg.bpm) / 60;

    while (this.cursor < target) {
      const { enabled, start, end } = this.loop;
      // `<=`, not `<`: audio clocks are quantized, so a window can end EXACTLY on the loop end,
      // leaving the cursor sitting on it. With a strict `<` the wrap would never fire again and
      // playback would run on past the loop until Stop. (emit() skips the resulting empty window.)
      if (enabled && this.cursor <= end + 1e-9 && target > end) {
        this.emit(this.cursor, end, seg);
        const wrapTime = this.segToTime(seg, end);
        seg = { audioTime: wrapTime, beat: start, bpm: seg.bpm };
        this.segments.push(seg);
        this.cursor = start;
        target = start + ((until - wrapTime) * seg.bpm) / 60;
      } else {
        this.emit(this.cursor, target, seg);
        this.cursor = target;
      }
    }
  }

  private emit(from: number, to: number, seg: Segment) {
    if (to <= from) return;
    try {
      this.onWindow?.(from, to, (beat) => this.segToTime(seg, beat));
    } catch (error) {
      // The cursor advances after this returns, so a throwing handler would otherwise be retried on the
      // same window forever and stall playback. Skip the bad window, keep the transport alive.
      if (!this.reportedError) {
        this.reportedError = true;
        console.error("[transport] scheduling error (window skipped, playback continues):", error);
      }
    }
  }
  private reportedError = false;
}
