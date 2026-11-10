import { describe, it, expect, beforeEach } from "vitest";
import { createBlankManifest, type ProjectManifest, type MidiClip } from "@sonora/schema";
import { applyCommand, invertCommand } from "../commands";
import { useProjectStore } from "../projectStore";
import { TRACK_TEMPLATES } from "../../engine/instruments/registry";

function emptyManifest(): ProjectManifest {
  return createBlankManifest({ projectId: "p", title: "t", authorId: "u" });
}

describe("batch + track creation", () => {
  it("ADD_TRACK also creates a mixer strip", () => {
    const m = applyCommand(emptyManifest(), {
      type: "ADD_TRACK",
      track: { id: "t1", name: "x", type: "midi", color: "#fff", orderIndex: 0, authorId: "a" },
    });
    expect(m.mixer.strips.map((s) => s.trackId)).toEqual(["t1"]);
  });

  it("BATCH inverts to a single command that fully restores state", () => {
    const before = emptyManifest();
    const cmd = {
      type: "BATCH" as const,
      commands: [
        { type: "ADD_INSTRUMENT" as const, instrument: { id: "i", pluginId: "sonora.synth", pluginType: "builtin" as const, version: "1", isBuiltIn: true, presetData: {}, displayName: "s" } },
        { type: "ADD_TRACK" as const, track: { id: "t1", name: "x", type: "midi" as const, color: "#fff", orderIndex: 0, authorId: "a", instrumentId: "i" } },
      ],
    };
    const after = applyCommand(before, cmd);
    expect(after.tracks).toHaveLength(1);
    const undone = applyCommand(after, invertCommand(before, cmd)!);
    expect(undone.tracks).toHaveLength(0);
    expect(undone.instruments).toHaveLength(0);
    expect(undone.mixer.strips).toHaveLength(0);
  });

  it("BATCH is not undoable if any step isn't (no partial undo)", () => {
    const cmd = { type: "BATCH" as const, commands: [{ type: "CHANGE_TEMPO" as const, bpm: 100 }, { type: "DELETE_MIDI_NOTE" as const, clipId: "nope", noteId: "x" }] };
    expect(invertCommand(emptyManifest(), cmd)).toBeNull();
  });
});

describe("store undo/redo + gestures", () => {
  beforeEach(() => useProjectStore.getState().loadManifest(emptyManifest()));
  const s = () => useProjectStore.getState();

  function addDrumClip() {
    const trackId = s().addTrackFromTemplate(TRACK_TEMPLATES[0], "u");
    return { trackId, clipId: s().addMidiClip(trackId, 0, 4, "u") };
  }
  const clipOf = (id: string) => s().manifest!.clips.find((c) => c.id === id) as MidiClip;

  it("adding a track is one undo step", () => {
    s().addTrackFromTemplate(TRACK_TEMPLATES[2], "u");
    expect(s().manifest!.tracks).toHaveLength(1);
    s().undo();
    expect(s().manifest!.tracks).toHaveLength(0);
    expect(s().manifest!.instruments).toHaveLength(0);
  });

  it("a whole drag gesture undoes in one step", () => {
    const { clipId } = addDrumClip();
    s().addNoteToClip(clipId, { pitch: 60, startBeat: 1, lengthBeats: 1, velocity: 100 });
    const noteId = clipOf(clipId).notes[0].id;
    s().beginGesture();
    for (let i = 1; i <= 10; i++) s().updateNote(clipId, noteId, { startBeat: 1 + i * 0.1, pitch: 60 + i });
    s().endGesture();
    expect(clipOf(clipId).notes[0].pitch).toBe(70);
    s().undo();
    expect(clipOf(clipId).notes[0]).toMatchObject({ startBeat: 1, pitch: 60 });
    s().redo();
    expect(clipOf(clipId).notes[0].pitch).toBe(70);
  });

  it("redo can be applied more than once in a row", () => {
    const { clipId } = addDrumClip();
    s().addNoteToClip(clipId, { pitch: 36, startBeat: 0, lengthBeats: 0.25, velocity: 100 });
    s().addNoteToClip(clipId, { pitch: 38, startBeat: 1, lengthBeats: 0.25, velocity: 100 });
    s().undo();
    s().undo();
    expect(clipOf(clipId).notes).toHaveLength(0);
    s().redo();
    s().redo();
    expect(clipOf(clipId).notes).toHaveLength(2);
  });

  it("deleting a note and a clip are undoable", () => {
    const { clipId } = addDrumClip();
    s().addNoteToClip(clipId, { pitch: 36, startBeat: 0, lengthBeats: 0.25, velocity: 90 });
    const id = clipOf(clipId).notes[0].id;
    s().deleteNote(clipId, id);
    s().undo();
    expect(clipOf(clipId).notes[0].velocity).toBe(90);
    s().deleteClip(clipId);
    expect(s().manifest!.clips).toHaveLength(0);
    s().undo();
    expect(clipOf(clipId).notes).toHaveLength(1);
  });

  it("quantize snaps notes to the grid as one undo step", () => {
    const { clipId } = addDrumClip();
    for (const b of [0.07, 0.31, 1.9]) s().addNoteToClip(clipId, { pitch: 36, startBeat: b, lengthBeats: 0.25, velocity: 100 });
    s().quantizeClip(clipId, 0.25);
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0, 0.25, 2]);
    s().undo();
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0.07, 0.31, 1.9]);
  });
});
