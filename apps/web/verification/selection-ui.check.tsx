import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBlankManifest, type MidiClip } from "@sonora/schema";

const SRC = "../src/daw";
const { useProjectStore } = await import(`${SRC}/state/projectStore`);
const { TRACK_TEMPLATES } = await import(`${SRC}/engine/instruments/registry`);
const { PianoRollView } = await import(`${SRC}/components/piano-roll/PianoRollView`);
const { setNoteClipboard } = await import(`${SRC}/components/piano-roll/noteClipboard`);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as any;

const s = () => useProjectStore.getState();
const clipOf = (id: string) => s().manifest!.clips.find((c: any) => c.id === id) as MidiClip;
const tpl = (k: string) => TRACK_TEMPLATES.find((t: any) => t.key === k);

let root: Root, host: HTMLDivElement;
function mount(clipId: string) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<PianoRollView clipId={clipId} />));
}
const unmount = () => { act(() => root.unmount()); host.remove(); };
afterEach(() => { try { act(() => root?.unmount()); } catch {} host?.remove(); });
beforeEach(() => { setNoteClipboard([]); s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" })); });

// geometry: keyboard 56px, row 14px, top pitch 95, zoom 60px/beat
const pX = (beat: number) => 56 + beat * 60 + 3;
const pY = (pitch: number) => (95 - pitch) * 14 + 5;
const grid = () => host.querySelectorAll("canvas")[0] as HTMLCanvasElement;
const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}) => act(() => { grid().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init })); });
const down = (x: number, y: number, init?: MouseEventInit) => mouse("mousedown", x, y, init);
const move = (x: number, y: number) => mouse("mousemove", x, y);
const up = () => mouse("mouseup", 0, 0);
const key = (k: string, init: KeyboardEventInit = {}) => act(() => { grid().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
const ctrl = (k: string, init: KeyboardEventInit = {}) => key(k, { ctrlKey: true, ...init });
const selectedText = () => (host.textContent?.match(/(\d+) selected/)?.[1]) ?? null;
const pitchesAndStarts = (id: string) => clipOf(id).notes.map((n) => [n.pitch, n.startBeat]);

/** A synth clip (8 beats) holding a C-major triad: C4@0, E4@1, G4@2, 1 beat each */
function setup() {
  const trackId = s().addTrackFromTemplate(tpl("lead"), "u");
  const clipId = s().createClipOnTrack(trackId, 0)!;
  const ids = s().addNotes(clipId, [
    { pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 100 },
    { pitch: 64, startBeat: 1, lengthBeats: 1, velocity: 90 },
    { pitch: 67, startBeat: 2, lengthBeats: 1, velocity: 80 },
  ]);
  return { trackId, clipId, ids };
}
const NOTE_A = () => [pX(0) + 10, pY(60)] as const; // C4 @ beat 0
const NOTE_B = () => [pX(1) + 10, pY(64)] as const; // E4 @ beat 1
const NOTE_C = () => [pX(2) + 10, pY(67)] as const; // G4 @ beat 2

describe("selecting", () => {
  it("click selects one note; shift-click adds and removes; counter follows", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up();
    expect(selectedText()).toBe("1");
    down(...NOTE_B(), { shiftKey: true }); up();
    expect(selectedText()).toBe("2");
    down(...NOTE_A(), { shiftKey: true }); up();
    expect(selectedText()).toBe("1");
    expect(clipOf(clipId).notes).toHaveLength(3); // shift-click never edits notes
  });

  it("ctrl+A selects everything; Escape clears", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a");
    expect(selectedText()).toBe("3");
    key("Escape");
    expect(selectedText()).toBeNull();
  });

  it("shift-drag draws a marquee that selects the notes it overlaps, then disappears", () => {
    const { clipId } = setup(); mount(clipId);
    down(pX(0) - 2, pY(70), { shiftKey: true });       // empty space above the notes
    move(pX(1.5), pY(58));                              // pitches 58..70 and beats 0..1.5: covers A (C4@0-1) and B (E4@1-2), not C (G4@2)
    expect(host.querySelector('[data-testid="marquee"]')).toBeTruthy();
    expect(selectedText()).toBe("2");
    up();
    expect(host.querySelector('[data-testid="marquee"]')).toBeNull();
    expect(selectedText()).toBe("2");
    expect(clipOf(clipId).notes).toHaveLength(3); // a marquee never creates a note
  });

  it("ctrl+shift-drag ADDS to the current selection instead of replacing it", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_C()); up();                           // select G4
    down(pX(0) - 2, pY(70), { shiftKey: true, ctrlKey: true });
    move(pX(1.5), pY(58)); up();
    expect(selectedText()).toBe("3");
  });

  it("the counter ignores ids of notes that no longer exist (e.g. after undo)", () => {
    const { clipId, ids } = setup(); mount(clipId);
    ctrl("a");
    expect(selectedText()).toBe("3");
    act(() => s().deleteNotes(clipId, ids));
    expect(selectedText()).toBeNull();
  });
});

describe("moving and resizing a group", () => {
  it("dragging a selected note moves the WHOLE selection together; one undo restores all", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a");
    down(...NOTE_B());
    for (let i = 1; i <= 4; i++) move(NOTE_B()[0] + i * 15, NOTE_B()[1] - i * 7); // +1 beat, +2 semitones, in small steps
    up();
    expect(pitchesAndStarts(clipId)).toEqual([[62, 1], [66, 2], [69, 3]]);
    act(() => s().undo());
    expect(pitchesAndStarts(clipId)).toEqual([[60, 0], [64, 1], [67, 2]]);
    act(() => s().redo());
    expect(pitchesAndStarts(clipId)).toEqual([[62, 1], [66, 2], [69, 3]]);
  });

  it("dragging an UNselected note selects just that one and leaves the others alone", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up();                           // A selected
    down(...NOTE_C());                                 // drag C, which is not selected
    move(NOTE_C()[0], NOTE_C()[1] - 14); up();         // +1 semitone
    expect(pitchesAndStarts(clipId)).toEqual([[60, 0], [64, 1], [68, 2]]);
    expect(selectedText()).toBe("1");
  });

  it("a group pushed past the clip start stops as a unit: relative spacing is preserved", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a");
    down(...NOTE_B());
    move(NOTE_B()[0] - 600, NOTE_B()[1]); up();        // 10 beats left
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0, 1, 2]);
  });

  it("resizing from the edge of a selected note resizes the whole selection", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a");
    const edgeX = 56 + 2 * 60 - 2; // right edge of B (1..2)
    down(edgeX, pY(64));
    move(edgeX + 30, pY(64)); up();                    // +0.5 beat
    expect(clipOf(clipId).notes.map((n) => n.lengthBeats)).toEqual([1.5, 1.5, 1.5]);
    act(() => s().undo());
    expect(clipOf(clipId).notes.map((n) => n.lengthBeats)).toEqual([1, 1, 1]);
  });
});

describe("keyboard: delete, copy / cut / paste, duplicate, nudge", () => {
  it("Delete removes every selected note in one undo step", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up(); down(...NOTE_B(), { shiftKey: true }); up();
    key("Delete");
    expect(pitchesAndStarts(clipId)).toEqual([[67, 2]]);
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(3);
  });

  it("copy then paste puts the group at the MOUSE position with its internal timing, and selects the copies", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up(); down(...NOTE_B(), { shiftKey: true }); up();   // C4@0, E4@1
    ctrl("c");
    move(pX(4), pY(50));                                                    // hover over empty space at beat 4
    ctrl("v");
    expect(pitchesAndStarts(clipId).slice(3)).toEqual([[60, 4], [64, 5]]);
    expect(selectedText()).toBe("2");                                       // the pasted notes are selected
    expect(clipOf(clipId).notes).toHaveLength(5);                           // and no stray note was created
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(3);                           // paste = one undo step
  });

  it("paste trims to the clip: notes starting past the end are dropped", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a"); ctrl("c");                                                   // C4@0, E4@1, G4@2 (span 2 beats)
    move(pX(7), pY(50));                                                    // clip is 8 beats: only the first fits
    ctrl("v");
    expect(pitchesAndStarts(clipId).slice(3)).toEqual([[60, 7]]);
  });

  it("cut removes the notes (one undo step) and they can be pasted elsewhere", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_C()); up();
    ctrl("x");
    expect(clipOf(clipId).notes).toHaveLength(2);
    move(pX(5), pY(50)); ctrl("v");
    expect(pitchesAndStarts(clipId)).toEqual([[60, 0], [64, 1], [67, 5]]);
  });

  it("the clipboard works ACROSS clips (copy in one, paste in another)", () => {
    const { clipId, trackId } = setup();
    const other = s().createClipOnTrack(trackId, 8)!;
    mount(clipId);
    down(...NOTE_A()); up(); ctrl("c");
    unmount();
    mount(other);
    move(pX(1), pY(50)); ctrl("v");
    expect(pitchesAndStarts(other)).toEqual([[60, 1]]);
    expect(clipOf(clipId).notes).toHaveLength(3); // source untouched
  });

  it("ctrl+D duplicates the selection right after itself and selects the copies; one undo step", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up(); down(...NOTE_B(), { shiftKey: true }); up();   // span = 2 beats (0..2)
    ctrl("d");
    expect(pitchesAndStarts(clipId).slice(3)).toEqual([[60, 2], [64, 3]]);
    expect(selectedText()).toBe("2");
    ctrl("d");                                                              // duplicating the copies continues the pattern
    expect(pitchesAndStarts(clipId).slice(5)).toEqual([[60, 4], [64, 5]]);
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(5);
  });

  it("arrow keys nudge the selection: time by the grid step, pitch by a semitone, shift = octave; each press is one undo step", () => {
    const { clipId } = setup(); mount(clipId);
    ctrl("a");
    key("ArrowRight");                                  // default snap 1/16 = 0.25 beat
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0.25, 1.25, 2.25]);
    key("ArrowUp");
    expect(clipOf(clipId).notes.map((n) => n.pitch)).toEqual([61, 65, 68]);
    key("ArrowDown", { shiftKey: true });
    expect(clipOf(clipId).notes.map((n) => n.pitch)).toEqual([49, 53, 56]);
    key("ArrowLeft");
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0, 1, 2]);
    act(() => s().undo());
    expect(clipOf(clipId).notes.map((n) => n.startBeat)).toEqual([0.25, 1.25, 2.25]); // exactly one press undone
  });

  it("nudging against the edge does nothing and leaves NO phantom undo step", () => {
    const { clipId } = setup(); mount(clipId);
    down(...NOTE_A()); up();
    key("ArrowLeft");                                   // A is already at beat 0
    expect(clipOf(clipId).notes[0].startBeat).toBe(0);
    act(() => s().undo());                              // must undo the SEED (notes added), not a phantom nudge
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("shortcuts with nothing selected / empty clipboard are harmless no-ops", () => {
    const { clipId } = setup(); mount(clipId);
    key("Delete"); ctrl("c"); ctrl("x"); ctrl("v"); ctrl("d"); key("ArrowUp");
    expect(clipOf(clipId).notes).toHaveLength(3);
  });
});
