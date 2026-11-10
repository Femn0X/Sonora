import { describe, it, expect } from "vitest";
import { Transport } from "../transport";

function setup(bpm = 120) {
  const clock = { currentTime: 10 };
  const t = new Transport(clock);
  t.setBpm(bpm);
  const windows: { from: number; to: number; at: (b: number) => number }[] = [];
  const advance = (sec: number, step = 0.025) => {
    for (let i = 0; i < Math.round(sec / step); i++) {
      clock.currentTime += step;
      t.tick();
    }
  };
  return { clock, t, windows, advance, start: (from = 0) => t.play(from, (f, to, at) => windows.push({ from: f, to, at })) };
}

describe("Transport", () => {
  it("emits gap-free, overlap-free consecutive windows", () => {
    const s = setup();
    s.start();
    s.advance(2);
    for (let i = 1; i < s.windows.length; i++) expect(s.windows[i].from).toBe(s.windows[i - 1].to);
  });

  it("maps beats to audio time at the current tempo", () => {
    const s = setup(120); // 2 beats/sec
    s.start(0);
    const w = s.windows[0];
    expect(w.at(2) - w.at(0)).toBeCloseTo(1);
  });

  it("wraps at the loop end with correct, continuous audio time", () => {
    const s = setup(120);
    s.t.setLoop(true, 0, 4); // 2 sec per pass
    s.start(0);
    s.advance(5);
    const wrap = s.windows.findIndex((w, i) => i > 0 && w.from < s.windows[i - 1].to);
    expect(wrap).toBeGreaterThan(0);
    const before = s.windows[wrap - 1];
    const after = s.windows[wrap];
    expect(before.to).toBe(4);
    expect(after.from).toBe(0);
    // the first beat of the next pass sounds exactly when beat 4 would have
    expect(after.at(0)).toBeCloseTo(before.at(4), 9);
  });

  it("never emits a beat >= loop end after the first pass", () => {
    const s = setup(140);
    s.t.setLoop(true, 0, 4);
    s.start(0);
    s.advance(8);
    expect(Math.max(...s.windows.map((w) => w.to))).toBeLessThanOrEqual(4 + 1e-9);
  });

  it("playhead stays within the loop and tracks the audio clock", () => {
    const s = setup(120);
    s.t.setLoop(true, 0, 4);
    s.start(0);
    s.advance(3.5); // 1.75 passes minus lead
    const beat = s.t.getCurrentBeat();
    expect(beat).toBeGreaterThanOrEqual(0);
    expect(beat).toBeLessThan(4);
  });

  it("playhead stays inside the loop even if the scheduler stalls past the loop end", () => {
    const s = setup(120); // 2 beats/sec, 4-beat (2 sec) loop
    s.t.setLoop(true, 0, 4);
    s.start(0);
    // the audio clock runs on for 5s with NO scheduler ticks (a stalled main thread)
    s.clock.currentTime += 5;
    const beat = s.t.getCurrentBeat();
    expect(beat).toBeGreaterThanOrEqual(0);
    expect(beat).toBeLessThan(4);
    // 5s - 0.06s lead = 4.94s => 9.88 beats => 1.88 beats into the third pass
    expect(beat).toBeCloseTo(1.88, 2);
  });

  it("tempo change mid-playback keeps timing continuous", () => {
    const s = setup(120);
    s.start(0);
    s.advance(1);
    const cursorBeat = s.windows[s.windows.length - 1].to;
    const timeAtCursor = s.windows[s.windows.length - 1].at(cursorBeat);
    s.t.setBpm(60);
    s.advance(0.5);
    const next = s.windows.find((w) => w.from >= cursorBeat)!;
    expect(next.at(cursorBeat)).toBeCloseTo(timeAtCursor, 9);
    expect(next.at(cursorBeat + 1) - next.at(cursorBeat)).toBeCloseTo(1); // 60bpm: 1 beat/sec
  });

  it("pause remembers position; stop resets; play resumes from rest", () => {
    const s = setup(120);
    s.start(0);
    s.advance(1.06 + 0.5);
    s.t.pause();
    const rested = s.t.getCurrentBeat();
    expect(rested).toBeGreaterThan(1);
    expect(s.t.isPlaying).toBe(false);
    s.t.stop(0);
    expect(s.t.getCurrentBeat()).toBe(0);
  });

  it("a throwing window handler is skipped, not retried forever: the transport keeps advancing", () => {
    const clock = { currentTime: 10 };
    const t = new Transport(clock);
    t.setBpm(120);
    const seen: number[] = [];
    let first = true;
    const spy = console.error;
    console.error = () => {};
    t.play(0, (from) => {
      if (first) { first = false; throw new Error("boom"); }
      seen.push(from);
    });
    for (let i = 0; i < 20; i++) { clock.currentTime += 0.025; t.tick(); }
    console.error = spy;
    expect(seen.length).toBeGreaterThan(5); // scheduling carried on past the failed window
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it("clamps absurd or invalid tempos instead of dividing by zero or freezing on a huge loop catch-up", () => {
    for (const bad of [0, -50, NaN, Infinity, 1e9]) {
      const clock = { currentTime: 10 };
      const t = new Transport(clock);
      t.setBpm(bad);
      expect(t.getBpm()).toBeGreaterThanOrEqual(10);
      expect(t.getBpm()).toBeLessThanOrEqual(2000);
      t.setLoop(true, 0, 0.25); // a tiny loop is the worst case for runaway wrapping
      let windows = 0;
      t.play(0, () => { windows++; });
      const started = Date.now();
      clock.currentTime += 5;
      t.tick();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(windows).toBeLessThan(100000);
      t.stop();
    }
  });
});

