import { describe, it, expect } from "vitest";
import type { MidiClip, MidiNote } from "@sonora/schema";
import { collectNoteEvents } from "../noteScheduling";

const note = (id: string, startBeat: number, lengthBeats = 0.5, pitch = 60): MidiNote => ({
  id, pitch, startBeat, lengthBeats, velocity: 100,
});
const clip = (over: Partial<MidiClip>): MidiClip => ({
  id: "c", type: "midi", trackId: "t", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i",
  authorId: "a", createdAt: "", ...over,
});

/** Walk consecutive windows of arbitrary size and gather every event. */
function playThrough(c: MidiClip, end: number, step: number) {
  const out: { id: string; beat: number }[] = [];
  for (let from = 0; from < end; from += step) {
    for (const e of collectNoteEvents(c, from, Math.min(end, from + step))) out.push({ id: e.noteId, beat: e.startBeat });
  }
  return out;
}

describe("collectNoteEvents", () => {
  it("fires a note only in the window containing it (half-open)", () => {
    const c = clip({ startBeat: 4, notes: [note("a", 1)] }); // absolute beat 5
    expect(collectNoteEvents(c, 4, 5)).toHaveLength(0);
    expect(collectNoteEvents(c, 5, 6)).toHaveLength(1);
    expect(collectNoteEvents(c, 4.5, 5)).toHaveLength(0);
  });

  it("fires every note exactly once regardless of window size", () => {
    const notes = Array.from({ length: 16 }, (_, i) => note(`n${i}`, i * 0.25));
    for (const step of [0.013, 0.0833, 0.25, 0.7, 1, 3.3]) {
      const fired = playThrough(clip({ notes }), 8, step);
      expect(fired).toHaveLength(16);
      expect(new Set(fired.map((f) => f.id)).size).toBe(16);
    }
  });

  it("does not fire notes at/after the clip end and truncates length to it", () => {
    const c = clip({ lengthBeats: 2, notes: [note("in", 1.75, 1), note("out", 2)] });
    const ev = collectNoteEvents(c, 0, 10);
    expect(ev.map((e) => e.noteId)).toEqual(["in"]);
    expect(ev[0].lengthBeats).toBeCloseTo(0.25);
  });

  it("skips muted notes", () => {
    const c = clip({ notes: [{ ...note("m", 0), muted: true }] });
    expect(collectNoteEvents(c, 0, 4)).toHaveLength(0);
  });

  it("repeats a looped pattern across the clip length", () => {
    const c = clip({ lengthBeats: 8, loop: { enabled: true, lengthBeats: 2 }, notes: [note("k", 0), note("s", 1)] });
    const fired = playThrough(c, 8, 0.37);
    expect(fired.filter((f) => f.id === "k").map((f) => f.beat)).toEqual([0, 2, 4, 6]);
    expect(fired.filter((f) => f.id === "s").map((f) => f.beat)).toEqual([1, 3, 5, 7]);
  });

  it("ignores notes outside the loop body and truncates at repetition end", () => {
    const c = clip({ lengthBeats: 4, loop: { enabled: true, lengthBeats: 2 }, notes: [note("long", 1.5, 3), note("far", 2.5)] });
    const ev = collectNoteEvents(c, 0, 4);
    expect(ev.map((e) => e.noteId)).toEqual(["long", "long"]);
    expect(ev.every((e) => Math.abs(e.lengthBeats - 0.5) < 1e-9)).toBe(true);
  });

  it("works when playback starts mid-loop", () => {
    const c = clip({ lengthBeats: 8, loop: { enabled: true, lengthBeats: 2 }, notes: [note("k", 0)] });
    expect(collectNoteEvents(c, 3, 8).map((e) => e.startBeat)).toEqual([4, 6]);
  });

  it("ignores non-finite or nonsensical data from corrupt/hostile projects instead of passing NaN to the audio engine", () => {
    const bad = [
      note("nan-start", NaN), note("inf-len", 0, Infinity), note("nan-pitch", 0, 0.5, NaN),
      { ...note("nan-vel", 0), velocity: NaN }, note("neg-start", -1), note("zero-len", 0, 0), note("neg-len", 0, -2),
    ];
    const c = clip({ notes: [...bad, note("good", 1)] });
    expect(collectNoteEvents(c, 0, 4).map((e) => e.noteId)).toEqual(["good"]);
    expect(collectNoteEvents(clip({ startBeat: NaN, notes: [note("a", 0)] }), 0, 4)).toEqual([]);
    expect(collectNoteEvents(clip({ lengthBeats: NaN, notes: [note("a", 0)] }), 0, 4)).toEqual([]);
    expect(collectNoteEvents(clip({ lengthBeats: 0, notes: [note("a", 0)] }), 0, 4)).toEqual([]);
    // a nonsense loop length is treated as "no loop", not as a division by zero / infinite repeat
    const loopy = clip({ loop: { enabled: true, lengthBeats: NaN }, notes: [note("k", 1)] });
    expect(collectNoteEvents(loopy, 0, 4).map((e) => e.startBeat)).toEqual([1]);
    expect(collectNoteEvents(clip({ loop: { enabled: true, lengthBeats: 0 }, notes: [note("k", 1)] }), 0, 4)).toHaveLength(1);
  });
});

