import { describe, it, expect } from "vitest";
import { applyCommand, invertCommand } from "../commands";
import { createBlankManifest } from "@sonora/schema";

/**
 * Tests for the command layer -- the piece Stage 1 introduced. These cover
 * the "MIDI Tests" and part of "Project Tests" checklist from the spec
 * (create note, move note, delete note, serialize/recreate).
 */

function blankManifestWithTrack() {
  const manifest = createBlankManifest({ projectId: "p1", title: "Test", authorId: "u1" });
  manifest.tracks.push({
    id: "t1",
    name: "Synth",
    type: "midi",
    color: "#fff",
    orderIndex: 0,
    authorId: "u1",
    instrumentId: "i1",
  });
  manifest.mixer.strips.push({
    trackId: "t1",
    volumeDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    inserts: [],
    sends: [],
  });
  return manifest;
}

describe("applyCommand", () => {
  it("adds a MIDI clip", () => {
    const manifest = blankManifestWithTrack();
    const after = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: {
        id: "c1",
        type: "midi",
        trackId: "t1",
        startBeat: 0,
        lengthBeats: 4,
        notes: [],
        instrumentId: "i1",
        authorId: "u1",
        createdAt: new Date().toISOString(),
      },
    });
    expect(after.clips).toHaveLength(1);
    expect(after.clips[0].id).toBe("c1");
    // original manifest must be untouched (pure function, no mutation)
    expect(manifest.clips).toHaveLength(0);
  });

  it("adds, moves, and deletes a MIDI note", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });

    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_NOTE",
      clipId: "c1",
      note: { id: "n1", startBeat: 0, lengthBeats: 1, pitch: 60, velocity: 100 },
    });
    expect((manifest.clips[0] as any).notes).toHaveLength(1);

    manifest = applyCommand(manifest, {
      type: "MOVE_MIDI_NOTE",
      clipId: "c1",
      noteId: "n1",
      newStartBeat: 2,
      newPitch: 64,
    });
    const movedNote = (manifest.clips[0] as any).notes[0];
    expect(movedNote.startBeat).toBe(2);
    expect(movedNote.pitch).toBe(64);

    manifest = applyCommand(manifest, { type: "DELETE_MIDI_NOTE", clipId: "c1", noteId: "n1" });
    expect((manifest.clips[0] as any).notes).toHaveLength(0);
  });

  it("serializes and recreates notes from a saved project (round-trip)", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_NOTE",
      clipId: "c1",
      note: { id: "n1", startBeat: 0, lengthBeats: 1, pitch: 60, velocity: 100 },
    });

    const json = JSON.stringify(manifest);
    const restored = JSON.parse(json);
    expect(restored.clips[0].notes[0]).toEqual({ id: "n1", startBeat: 0, lengthBeats: 1, pitch: 60, velocity: 100 });
  });

  it("moving a clip does not affect other clips", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c2", type: "midi", trackId: "t1", startBeat: 4, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    manifest = applyCommand(manifest, { type: "MOVE_CLIP", clipId: "c1", newStartBeat: 8 });
    expect(manifest.clips.find((c) => c.id === "c1")!.startBeat).toBe(8);
    expect(manifest.clips.find((c) => c.id === "c2")!.startBeat).toBe(4);
  });

  it("changes track volume via mixer strip", () => {
    const manifest = blankManifestWithTrack();
    const after = applyCommand(manifest, { type: "CHANGE_TRACK_VOLUME", trackId: "t1", volumeDb: -6 });
    expect(after.mixer.strips[0].volumeDb).toBe(-6);
  });

  it("resizes a MIDI note (piano roll drag-resize)", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_NOTE",
      clipId: "c1",
      note: { id: "n1", startBeat: 0, lengthBeats: 1, pitch: 60, velocity: 100 },
    });
    manifest = applyCommand(manifest, { type: "RESIZE_MIDI_NOTE", clipId: "c1", noteId: "n1", newLengthBeats: 2.5 });
    expect((manifest.clips[0] as any).notes[0].lengthBeats).toBe(2.5);
  });

  it("sets note velocity clamped to the 1-127 MIDI range (velocity lane drag)", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 0, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_NOTE",
      clipId: "c1",
      note: { id: "n1", startBeat: 0, lengthBeats: 1, pitch: 60, velocity: 100 },
    });
    manifest = applyCommand(manifest, { type: "SET_NOTE_VELOCITY", clipId: "c1", noteId: "n1", velocity: 500 });
    expect((manifest.clips[0] as any).notes[0].velocity).toBe(127); // clamped
  });
});

describe("invertCommand", () => {
  it("produces a MOVE_CLIP inverse that restores original position", () => {
    let manifest = blankManifestWithTrack();
    manifest = applyCommand(manifest, {
      type: "ADD_MIDI_CLIP",
      clip: { id: "c1", type: "midi", trackId: "t1", startBeat: 2, lengthBeats: 4, notes: [], instrumentId: "i1", authorId: "u1", createdAt: new Date().toISOString() },
    });
    const moveCmd = { type: "MOVE_CLIP" as const, clipId: "c1", newStartBeat: 10 };
    const inverse = invertCommand(manifest, moveCmd);
    const after = applyCommand(manifest, moveCmd);
    const undone = applyCommand(after, inverse!);
    expect(undone.clips[0].startBeat).toBe(2);
  });
});
