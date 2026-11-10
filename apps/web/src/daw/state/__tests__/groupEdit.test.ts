import { describe, it, expect, beforeEach } from "vitest";
import { createBlankManifest, type MidiClip } from "@sonora/schema";
import { useProjectStore } from "../projectStore";
import { TRACK_TEMPLATES } from "../../engine/instruments/registry";

const s = () => useProjectStore.getState();
const clipOf = (id: string) => s().manifest!.clips.find((c) => c.id === id) as MidiClip;
const tpl = (k: string) => TRACK_TEMPLATES.find((t) => t.key === k)!;

beforeEach(() => s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" })));

function setup() {
  const trackId = s().addTrackFromTemplate(tpl("lead"), "u");
  const clipId = s().createClipOnTrack(trackId, 0)!; // 2 bars = 8 beats
  return { trackId, clipId };
}
const seed = (clipId: string) => s().addNotes(clipId, [
  { pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 100 },
  { pitch: 64, startBeat: 1, lengthBeats: 1, velocity: 90 },
  { pitch: 67, startBeat: 2, lengthBeats: 2, velocity: 80 },
]);

describe("group note actions", () => {
  it("addNotes returns ids in order and is ONE undo step", () => {
    const { clipId } = setup();
    const ids = seed(clipId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(clipOf(clipId).notes.map((n) => n.id)).toEqual(ids);
    s().undo();
    expect(clipOf(clipId).notes).toHaveLength(0);
    s().redo();
    expect(clipOf(clipId).notes).toHaveLength(3);
  });

  it("deleteNotes removes several notes and one undo restores them all, in place", () => {
    const { clipId } = setup();
    const ids = seed(clipId);
    s().deleteNotes(clipId, [ids[0], ids[2]]);
    expect(clipOf(clipId).notes.map((n) => n.id)).toEqual([ids[1]]);
    s().undo();
    expect(clipOf(clipId).notes.map((n) => n.pitch).sort()).toEqual([60, 64, 67]);
  });

  it("moveNotes and resizeNotes apply to the whole group and undo as one step", () => {
    const { clipId } = setup();
    const ids = seed(clipId);
    s().moveNotes(clipId, ids.map((id, i) => ({ id, startBeat: i + 4, pitch: 70 + i })));
    expect(clipOf(clipId).notes.map((n) => [n.startBeat, n.pitch])).toEqual([[4, 70], [5, 71], [6, 72]]);
    s().resizeNotes(clipId, ids.map((id) => ({ id, lengthBeats: 0.5 })));
    expect(clipOf(clipId).notes.every((n) => n.lengthBeats === 0.5)).toBe(true);
    s().undo();
    expect(clipOf(clipId).notes.map((n) => n.lengthBeats)).toEqual([1, 1, 2]);
    s().undo();
    expect(clipOf(clipId).notes.map((n) => [n.startBeat, n.pitch])).toEqual([[0, 60], [1, 64], [2, 67]]);
  });

  it("empty inputs are no-ops that leave no phantom undo entry", () => {
    const { clipId } = setup();
    seed(clipId);
    s().addNotes(clipId, []); s().deleteNotes(clipId, []); s().moveNotes(clipId, []); s().resizeNotes(clipId, []);
    s().undo(); // must undo the seed, not a phantom step
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("a whole drag of a group (many moveNotes calls in a gesture) is a single undo step", () => {
    const { clipId } = setup();
    const ids = seed(clipId);
    s().beginGesture();
    for (let d = 1; d <= 20; d++) s().moveNotes(clipId, ids.map((id, i) => ({ id, startBeat: i + d * 0.1, pitch: 60 + i })));
    s().endGesture();
    s().undo();
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0, 1, 2]);
  });
});

describe("duplicateClip", () => {
  it("copies the clip right after itself with FRESH note ids, one undo step", () => {
    const { clipId } = setup();
    const ids = seed(clipId);
    const copyId = s().duplicateClip(clipId)!;
    const copy = clipOf(copyId);
    expect(copy.startBeat).toBe(8);
    expect(copy.lengthBeats).toBe(8);
    expect(copy.trackId).toBe(clipOf(clipId).trackId);
    expect(copy.notes.map((n) => [n.startBeat, n.pitch, n.velocity])).toEqual(clipOf(clipId).notes.map((n) => [n.startBeat, n.pitch, n.velocity]));
    expect(copy.notes.some((n) => ids.includes(n.id))).toBe(false); // ids must be unique project-wide
    // editing the copy doesn't touch the original
    s().updateNote(copyId, copy.notes[0].id, { pitch: 90 });
    expect(clipOf(clipId).notes[0].pitch).toBe(60);
    s().undo(); s().undo();
    expect(s().manifest!.clips).toHaveLength(1);
  });

  it("hops forward past occupied space instead of overlapping another clip on the track", () => {
    const { trackId, clipId } = setup();
    s().createClipOnTrack(trackId, 8); // occupies 8..16
    const copyId = s().duplicateClip(clipId)!;
    expect(clipOf(copyId).startBeat).toBe(16);
    const second = s().duplicateClip(clipId)!;
    expect(clipOf(second).startBeat).toBe(24);
  });

  it("preserves loop settings; returns null for unknown clips", () => {
    const trackId = s().addTrackFromTemplate(tpl("drums"), "u");
    const drumId = s().createClipOnTrack(trackId, 0)!;
    const copy = clipOf(s().duplicateClip(drumId)!);
    expect(copy.loop).toEqual({ enabled: true, lengthBeats: 4 });
    expect(s().duplicateClip("nope")).toBeNull();
  });
});
