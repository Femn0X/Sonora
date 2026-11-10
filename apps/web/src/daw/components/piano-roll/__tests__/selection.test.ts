import { describe, it, expect } from "vitest";
import type { MidiNote } from "@sonora/schema";
import { moveGroup, resizeGroup, toClipboard, pasteNotes, duplicateShift, notesInRect, LOWEST_NOTE, HIGHEST_NOTE } from "../selection";

const n = (id: string, startBeat: number, pitch: number, lengthBeats = 1, velocity = 100): MidiNote => ({ id, startBeat, pitch, lengthBeats, velocity });

describe("moveGroup", () => {
  const chord = [n("a", 2, 60), n("b", 2.5, 64), n("c", 3, 67)];

  it("moves every note by the same amount", () => {
    expect(moveGroup(chord, 1, 2, 16)).toEqual([
      { id: "a", startBeat: 3, pitch: 62 }, { id: "b", startBeat: 3.5, pitch: 66 }, { id: "c", startBeat: 4, pitch: 69 },
    ]);
  });

  it("clamps the WHOLE group at the start of the clip, preserving relative spacing", () => {
    expect(moveGroup(chord, -50, 0, 16).map((m) => m.startBeat)).toEqual([0, 0.5, 1]);
  });

  it("clamps the whole group at the end of the clip: the LAST note's start stays inside", () => {
    const moved = moveGroup(chord, 99, 0, 8);
    expect(Math.max(...moved.map((m) => m.startBeat))).toBeCloseTo(8 - 0.0625, 6);
    expect(moved[1].startBeat - moved[0].startBeat).toBeCloseTo(0.5, 9);
    expect(moved[2].startBeat - moved[0].startBeat).toBeCloseTo(1, 9);
  });

  it("clamps pitch as a group so a chord keeps its intervals at the keyboard edges", () => {
    const up = moveGroup(chord, 0, 999, 16);
    expect(up.map((m) => m.pitch)).toEqual([HIGHEST_NOTE - 7, HIGHEST_NOTE - 3, HIGHEST_NOTE]);
    const down = moveGroup(chord, 0, -999, 16);
    expect(Math.min(...down.map((m) => m.pitch))).toBe(LOWEST_NOTE);
    expect(down[2].pitch - down[0].pitch).toBe(7);
  });

  it("rounds fractional semitone deltas, ignores NaN, and handles an empty selection", () => {
    expect(moveGroup(chord, 0, 1.6, 16)[0].pitch).toBe(62);
    expect(moveGroup(chord, NaN, NaN, 16).map((m) => [m.startBeat, m.pitch])).toEqual([[2, 60], [2.5, 64], [3, 67]]);
    expect(moveGroup([], 1, 1, 16)).toEqual([]);
  });

  it("a note already at the edge can't be pushed past it and never produces NaN", () => {
    const moved = moveGroup([n("x", 7.99, 60)], 5, 0, 8);
    expect(Number.isFinite(moved[0].startBeat)).toBe(true);
    expect(moved[0].startBeat).toBeLessThan(8);
  });
});

describe("resizeGroup", () => {
  it("grows/shrinks each note, never below the minimum or past the clip end", () => {
    const notes = [n("a", 0, 60, 1), n("b", 6, 62, 1)];
    expect(resizeGroup(notes, 2, 8).map((r) => r.lengthBeats)).toEqual([3, 2]); // b is limited to the 2 beats left
    expect(resizeGroup(notes, -5, 8).map((r) => r.lengthBeats)).toEqual([0.0625, 0.0625]);
    expect(resizeGroup(notes, NaN, 8).map((r) => r.lengthBeats)).toEqual([1, 1]);
  });
});

describe("clipboard: copy + paste", () => {
  const notes = [n("a", 4, 60, 1, 90), n("b", 5.5, 64, 0.5, 70)];

  it("round-trips relative timing, pitch, length and velocity", () => {
    const clip = toClipboard(notes);
    expect(clip.map((c) => c.relStart)).toEqual([0, 1.5]);
    expect(pasteNotes(clip, 8, 32)).toEqual([
      { pitch: 60, startBeat: 8, lengthBeats: 1, velocity: 90 },
      { pitch: 64, startBeat: 9.5, lengthBeats: 0.5, velocity: 70 },
    ]);
  });

  it("drops notes that would start past the clip end and trims lengths that would overrun it", () => {
    const clip = toClipboard([n("a", 0, 60, 4), n("b", 3, 62, 1)]);
    expect(pasteNotes(clip, 6, 8)).toEqual([{ pitch: 60, startBeat: 6, lengthBeats: 2, velocity: 100 }]); // 'b' would start at 9 >= 8
  });

  it("skips pitches outside the editable range; handles an empty clipboard and a negative paste position", () => {
    expect(pasteNotes([{ pitch: 5, relStart: 0, lengthBeats: 1, velocity: 100 }], 0, 8)).toEqual([]);
    expect(pasteNotes([], 0, 8)).toEqual([]);
    expect(toClipboard([])).toEqual([]);
    expect(pasteNotes(toClipboard(notes), -3, 8)[0].startBeat).toBe(0);
  });
});

describe("duplicateShift", () => {
  it("shifts by the selection's span rounded UP to the grid, so the copy starts right after the original", () => {
    expect(duplicateShift([n("a", 1, 60, 1), n("b", 2, 62, 0.5)], 0.25)).toBe(1.5);
    expect(duplicateShift([n("a", 0, 60, 0.3)], 0.25)).toBe(0.5);
    expect(duplicateShift([n("a", 0, 60, 2)], 0)).toBe(2);
    expect(duplicateShift([], 0.25)).toBe(0);
  });
  it("never shifts by zero (a zero-length selection would stack copies on the original)", () => {
    expect(duplicateShift([n("a", 3, 60, 0)], 0.25)).toBeGreaterThan(0);
  });
});

describe("notesInRect (marquee)", () => {
  const notes = [n("in", 1, 60, 1), n("pitchOut", 1, 80, 1), n("before", 0, 60, 0.5), n("overlapsStart", 0.5, 62, 1), n("after", 4, 60, 1)];
  const ids = (r: Parameters<typeof notesInRect>[1]) => notesInRect(notes, r).map((x) => x.id);

  it("selects notes overlapping in time and inside the pitch range; corners in any order", () => {
    expect(ids({ beatA: 1, beatB: 3, pitchA: 58, pitchB: 64 })).toEqual(["in", "overlapsStart"]);
    expect(ids({ beatA: 3, beatB: 1, pitchA: 64, pitchB: 58 })).toEqual(["in", "overlapsStart"]);
  });
  it("a note that only touches the rectangle's edge isn't selected; a rectangle over nothing selects nothing", () => {
    // pitch row 60 only, beats 0.5..1: 'before' ends exactly at 0.5 and 'in' starts exactly at 1 -> both just touch
    expect(ids({ beatA: 0.5, beatB: 1, pitchA: 60, pitchB: 60 })).toEqual([]);
    expect(ids({ beatA: 10, beatB: 11, pitchA: 0, pitchB: 127 })).toEqual([]);
  });
});
