import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBlankManifest, type MidiClip } from "@sonora/schema";

const SRC = "../src/daw";
const { useProjectStore } = await import(`${SRC}/state/projectStore`);
const { TRACK_TEMPLATES } = await import(`${SRC}/engine/instruments/registry`);
const { DrumRollView } = await import(`${SRC}/components/drum-roll/DrumRollView`);
const { PianoRollView } = await import(`${SRC}/components/piano-roll/PianoRollView`);
const { ClipEditor } = await import(`${SRC}/components/ClipEditor`);
const { ArrangementView } = await import(`${SRC}/components/arrangement/ArrangementView`);
const { AddTrackMenu } = await import(`${SRC}/components/AddTrackMenu`);
const { setActiveEngine } = await import(`${SRC}/engine/playback`);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no canvas. A no-op 2D context lets every draw path actually execute (catches runtime errors in drawing code).
const noopCtx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 0 }) : () => {}), set: () => true });
HTMLCanvasElement.prototype.getContext = (() => noopCtx) as any;

const s = () => useProjectStore.getState();
const tpl = (key: string) => TRACK_TEMPLATES.find((t: any) => t.key === key);
const clipOf = (id: string) => s().manifest!.clips.find((c: any) => c.id === id) as MidiClip;

let root: Root, host: HTMLDivElement;
function mount(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(el));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });

function fire(target: Element, type: string, x = 0, y = 0, init: MouseEventInit = {}) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));
  });
}
const canvas = (i = 0) => host.querySelectorAll("canvas")[i] as HTMLCanvasElement;
const press = (c: Element, x: number, y: number, init?: MouseEventInit) => fire(c, "mousedown", x, y, init);
const move = (c: Element, x: number, y: number) => fire(c, "mousemove", x, y);
const release = (c: Element, x = 0, y = 0) => fire(c, "mouseup", x, y);

beforeEach(() => {
  s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" }));
});

function setupDrums() {
  const trackId = s().addTrackFromTemplate(tpl("drums"), "u");
  const clipId = s().createClipOnTrack(trackId, 0)!;
  return { trackId, clipId };
}
function setupSynth() {
  const trackId = s().addTrackFromTemplate(tpl("lead"), "u");
  const clipId = s().createClipOnTrack(trackId, 0)!;
  return { trackId, clipId };
}

// Drum roll geometry: label 110px, rows 30px, steps 30px. Rows: kick, snare, clap, chat, ohat, tom, rim, crash
const stepX = (step: number) => 110 + step * 30 + 5;
const rowY = (row: number) => row * 30 + 5;

describe("clip creation defaults", () => {
  it("drum clips are a 1-bar looping pattern; synth clips are 2 bars, no loop", () => {
    const d = setupDrums(), y = setupSynth();
    expect(clipOf(d.clipId)).toMatchObject({ lengthBeats: 4, loop: { enabled: true, lengthBeats: 4 } });
    expect(clipOf(y.clipId).lengthBeats).toBe(8);
    expect(clipOf(y.clipId).loop).toBeUndefined();
  });
});

describe("DrumRollView (step sequencer)", () => {
  it("click toggles a step on and off", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    press(canvas(), stepX(4), rowY(0)); release(canvas());
    expect(clipOf(clipId).notes).toHaveLength(1);
    expect(clipOf(clipId).notes[0]).toMatchObject({ pitch: 36, startBeat: 1, lengthBeats: 0.25, velocity: 100 });
    press(canvas(), stepX(4), rowY(0)); release(canvas());
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("each row maps to its own pad pitch", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    const expected = [36, 38, 39, 42, 46, 45, 37, 49];
    expected.forEach((_, row) => { press(canvas(), stepX(0), rowY(row)); release(canvas()); });
    expect(clipOf(clipId).notes.map((n) => n.pitch).sort()).toEqual([...expected].sort());
  });

  it("drag paints a run of steps, and the whole drag is ONE undo step", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    const c = canvas();
    press(c, stepX(0), rowY(3));
    move(c, stepX(1), rowY(3)); move(c, stepX(2), rowY(3)); move(c, stepX(3), rowY(3));
    release(c);
    expect(clipOf(clipId).notes).toHaveLength(4);
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(0);
    act(() => s().redo());
    expect(clipOf(clipId).notes).toHaveLength(4);
  });

  it("dragging back over a step doesn't toggle it twice; dragging from an active step erases", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    const c = canvas();
    for (const st of [0, 1, 2]) { press(c, stepX(st), rowY(1)); release(c); }
    press(c, stepX(0), rowY(1)); // starts on an active step => erase mode
    move(c, stepX(1), rowY(1)); move(c, stepX(0), rowY(1)); move(c, stepX(2), rowY(1));
    release(c);
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("shift+click cycles accent: 100 -> 127 -> 60 -> 100", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    const c = canvas();
    press(c, stepX(2), rowY(0)); release(c);
    const vel = () => clipOf(clipId).notes[0].velocity;
    expect(vel()).toBe(100);
    press(c, stepX(2), rowY(0), { shiftKey: true }); release(c); expect(vel()).toBe(127);
    press(c, stepX(2), rowY(0), { shiftKey: true }); release(c); expect(vel()).toBe(60);
    press(c, stepX(2), rowY(0), { shiftKey: true }); release(c); expect(vel()).toBe(100);
    expect(clipOf(clipId).notes).toHaveLength(1);
  });

  it("clicking a pad label auditions but never edits; clicks past the last step are ignored", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    press(canvas(), 40, rowY(2)); release(canvas());
    press(canvas(), stepX(16), rowY(0)); release(canvas()); // 1 bar = 16 steps (0..15)
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("Clear removes all pad hits in one undoable step; notes outside the kit are flagged and preserved", () => {
    const { clipId } = setupDrums();
    mount(<DrumRollView clipId={clipId} />);
    const c = canvas();
    for (const st of [0, 4, 8]) { press(c, stepX(st), rowY(0)); release(c); }
    act(() => s().addNoteToClip(clipId, { pitch: 61, startBeat: 0, lengthBeats: 1, velocity: 90 })); // not a pad
    expect(host.textContent).toContain("1 note outside the kit");
    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    act(() => clear.click());
    expect(clipOf(clipId).notes.map((n) => n.pitch)).toEqual([61]);
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(4);
  });

  it("shows only the looped pattern length for editing (a 2-bar pattern has 32 steps)", () => {
    const { clipId } = setupDrums();
    act(() => s().dispatch({ type: "BATCH", commands: [{ type: "SET_CLIP_LOOP", clipId, loop: { enabled: true, lengthBeats: 8 } }, { type: "RESIZE_CLIP", clipId, newLengthBeats: 8 }] }));
    mount(<DrumRollView clipId={clipId} />);
    expect(canvas().width).toBe(110 + 32 * 30);
  });
});

// Piano roll geometry: keyboard 56px, row 14px, HIGHEST 95, zoom 60 px/beat, snap 1/16
const pX = (beat: number) => 56 + beat * 60 + 3;
const pY = (pitch: number) => (95 - pitch) * 14 + 5;

describe("PianoRollView", () => {
  it("click creates a note at the clicked pitch/time with the default length", () => {
    const { clipId } = setupSynth();
    mount(<PianoRollView clipId={clipId} />);
    press(canvas(0), pX(1), pY(60)); release(canvas(0));
    expect(clipOf(clipId).notes).toHaveLength(1);
    expect(clipOf(clipId).notes[0]).toMatchObject({ pitch: 60, startBeat: 1, lengthBeats: 0.25, velocity: 100 });
  });

  it("click-and-drag right sets the new note's length; create+drag is ONE undo step", () => {
    const { clipId } = setupSynth();
    mount(<PianoRollView clipId={clipId} />);
    const c = canvas(0);
    press(c, pX(0), pY(64)); move(c, pX(1), pY(64)); move(c, pX(2), pY(64)); release(c);
    expect(clipOf(clipId).notes[0].lengthBeats).toBeCloseTo(2.05, 0); // ~2 beats after snapping
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("the next note reuses the last length the user set", () => {
    const { clipId } = setupSynth();
    mount(<PianoRollView clipId={clipId} />);
    const c = canvas(0);
    press(c, pX(0), pY(60)); move(c, pX(1), pY(60)); release(c);
    const len = clipOf(clipId).notes[0].lengthBeats;
    press(c, pX(4), pY(62)); release(c);
    expect(clipOf(clipId).notes[1].lengthBeats).toBe(len);
  });

  it("dragging a note moves it in time and pitch; one drag = one undo step", () => {
    const { clipId } = setupSynth();
    act(() => s().addNoteToClip(clipId, { pitch: 60, startBeat: 1, lengthBeats: 1, velocity: 100 }));
    mount(<PianoRollView clipId={clipId} />);
    const c = canvas(0);
    press(c, pX(1) + 10, pY(60));
    for (let i = 1; i <= 6; i++) move(c, pX(1) + 10 + i * 15, pY(60) - i * 14);
    release(c);
    const n = clipOf(clipId).notes[0];
    expect(n.pitch).toBe(66);
    expect(n.startBeat).toBeGreaterThan(1);
    expect(n.lengthBeats).toBe(1); // moved, not resized
    act(() => s().undo());
    expect(clipOf(clipId).notes[0]).toMatchObject({ pitch: 60, startBeat: 1 });
  });

  it("dragging a note's right edge resizes it, never past the clip end", () => {
    const { clipId } = setupSynth(); // 2 bars = 8 beats
    act(() => s().addNoteToClip(clipId, { pitch: 60, startBeat: 6, lengthBeats: 1, velocity: 100 }));
    mount(<PianoRollView clipId={clipId} />);
    const c = canvas(0);
    press(c, 56 + 7 * 60 - 2, pY(60)); move(c, 56 + 20 * 60, pY(60)); release(c);
    expect(clipOf(clipId).notes[0].lengthBeats).toBe(2); // clamped: 6 + 2 = 8 = clip end
  });

  it("notes can't be created in the dimmed area past the clip end, or on the keyboard", () => {
    const { clipId } = setupSynth();
    mount(<PianoRollView clipId={clipId} />);
    press(canvas(0), pX(8) + 5, pY(60)); release(canvas(0)); // beat 8 == clip end
    press(canvas(0), 20, pY(60)); release(canvas(0));        // keyboard column
    expect(clipOf(clipId).notes).toHaveLength(0);
  });

  it("right-click deletes a note (undoable); Delete key deletes the selected note", () => {
    const { clipId } = setupSynth();
    act(() => { s().addNoteToClip(clipId, { pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 100 }); s().addNoteToClip(clipId, { pitch: 62, startBeat: 2, lengthBeats: 1, velocity: 100 }); });
    mount(<PianoRollView clipId={clipId} />);
    fire(canvas(0), "contextmenu", pX(0) + 5, pY(60));
    expect(clipOf(clipId).notes.map((n) => n.pitch)).toEqual([62]);
    act(() => s().undo());
    expect(clipOf(clipId).notes).toHaveLength(2);
    press(canvas(0), pX(2) + 5, pY(62)); release(canvas(0)); // select
    act(() => { canvas(0).dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    expect(clipOf(clipId).notes.map((n) => n.pitch)).toEqual([60]);
  });

  it("velocity lane drag changes velocity (one undo step) and quantize snaps notes", () => {
    const { clipId } = setupSynth();
    act(() => s().addNoteToClip(clipId, { pitch: 60, startBeat: 0.07, lengthBeats: 1, velocity: 100 }));
    mount(<PianoRollView clipId={clipId} />);
    const v = canvas(1);
    press(v, 56 + 0.07 * 60 + 2, 80); move(v, 56 + 0.07 * 60 + 2, 40); move(v, 56 + 0.07 * 60 + 2, 20); release(v);
    expect(clipOf(clipId).notes[0].velocity).toBeGreaterThan(100);
    act(() => s().undo());
    expect(clipOf(clipId).notes[0].velocity).toBe(100);
    const q = [...host.querySelectorAll("button")].find((b) => b.textContent === "Quantize")!;
    act(() => q.click());
    expect(clipOf(clipId).notes[0].startBeat).toBe(0);
  });

  it("looped drum clip opened in the piano roll edits only the pattern body", () => {
    const { clipId } = setupDrums(); // 1-bar pattern
    mount(<PianoRollView clipId={clipId} />);
    press(canvas(0), pX(5), pY(36)); release(canvas(0)); // beat 5 is outside the 4-beat pattern
    expect(clipOf(clipId).notes).toHaveLength(0);
    press(canvas(0), pX(2), pY(36)); release(canvas(0));
    expect(clipOf(clipId).notes).toHaveLength(1);
  });
});

describe("ClipEditor", () => {
  const btn = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

  it("drum clips open in the step sequencer and can flip to the piano roll; synth clips have no tabs", () => {
    const d = setupDrums();
    mount(<ClipEditor clipId={d.clipId} />);
    expect(btn("Step sequencer")).toBeTruthy();
    expect(canvas().width).toBe(110 + 16 * 30); // drum roll geometry
    act(() => btn("Piano roll")!.click());
    expect(host.querySelectorAll("canvas")).toHaveLength(2); // grid + velocity lane
    act(() => root.unmount());
    host.remove();
    const y = setupSynth();
    mount(<ClipEditor clipId={y.clipId} />);
    expect(btn("Step sequencer")).toBeUndefined();
    expect(host.querySelectorAll("canvas")).toHaveLength(2);
  });

  it("Repeat toggles looping; a longer pattern also grows the clip so nothing is cut off", () => {
    const { clipId } = setupDrums(); // 4-beat clip, loop 4
    mount(<ClipEditor clipId={clipId} />);
    const select = host.querySelector("select") as HTMLSelectElement;
    act(() => { select.value = "2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(clipOf(clipId)).toMatchObject({ lengthBeats: 8, loop: { enabled: true, lengthBeats: 8 } });
    act(() => s().undo()); // atomic
    expect(clipOf(clipId)).toMatchObject({ lengthBeats: 4, loop: { enabled: true, lengthBeats: 4 } });
    const repeat = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => repeat.click());
    expect(clipOf(clipId).loop?.enabled).toBe(false);
  });

  it("non-looped length select resizes the clip", () => {
    const { clipId } = setupSynth();
    mount(<ClipEditor clipId={clipId} />);
    const select = host.querySelector("select") as HTMLSelectElement;
    act(() => { select.value = "4"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(clipOf(clipId).lengthBeats).toBe(16);
  });

  it("shows a friendly message if the clip was deleted", () => {
    const { clipId } = setupSynth();
    mount(<ClipEditor clipId={clipId} />);
    act(() => s().deleteClip(clipId));
    expect(host.textContent).toContain("Clip not found");
  });
});

// Arrangement geometry: header 160, ruler 24, track 64, default zoom 24 px/beat
const aX = (beat: number) => 160 + beat * 24;
const aY = (lane: number) => 24 + lane * 64 + 30;

describe("ArrangementView", () => {
  it("double-click on an empty lane creates a bar-aligned clip and opens its editor", () => {
    const trackId = s().addTrackFromTemplate(tpl("drums"), "u");
    mount(<ArrangementView />);
    fire(canvas(), "dblclick", aX(9.3), aY(0));
    const clips = s().manifest!.clips;
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ trackId, startBeat: 8, lengthBeats: 4 });
    expect(s().activePianoRollClipId).toBe(clips[0].id);
  });

  it("won't create a clip on top of an existing one, nor on an audio-less lane with no track", () => {
    setupDrums();
    mount(<ArrangementView />);
    fire(canvas(), "dblclick", aX(40), aY(3)); // lane 3 has no track
    expect(s().manifest!.clips).toHaveLength(1);
    fire(canvas(), "dblclick", aX(2), aY(0)); // on the existing clip: opens editor, doesn't add
    expect(s().manifest!.clips).toHaveLength(1);
  });

  it("dragging a clip moves it (snapped); the whole drag is one undo step", () => {
    const { clipId } = setupSynth();
    mount(<ArrangementView />);
    const c = canvas();
    press(c, aX(2), aY(0));
    for (let i = 1; i <= 8; i++) move(c, aX(2) + i * 12, aY(0));
    release(c);
    expect(clipOf(clipId).startBeat).toBeGreaterThan(0);
    expect(clipOf(clipId).startBeat % 0.25).toBe(0);
    act(() => s().undo());
    expect(clipOf(clipId).startBeat).toBe(0);
  });

  it("dragging a clip down onto another MIDI track moves it there", () => {
    const a = setupSynth();
    const t2 = s().addTrackFromTemplate(tpl("bass"), "u");
    mount(<ArrangementView />);
    const c = canvas();
    press(c, aX(2), aY(0)); move(c, aX(2), aY(1)); release(c);
    expect(clipOf(a.clipId).trackId).toBe(t2);
  });

  it("stretching a looped clip snaps to whole pattern repeats; plain clips snap to 1/16", () => {
    const d = setupDrums(); // 4 beats, pattern 4
    mount(<ArrangementView />);
    const c = canvas();
    press(c, aX(4) - 3, aY(0)); move(c, aX(4) + 150, aY(0)); release(c); // drag the right edge ~6 beats
    expect(clipOf(d.clipId).lengthBeats % 4).toBe(0);
    expect(clipOf(d.clipId).lengthBeats).toBeGreaterThanOrEqual(8);
    act(() => root.unmount()); host.remove();

    s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" }));
    const y = setupSynth(); // 8 beats
    mount(<ArrangementView />);
    press(canvas(), aX(8) - 3, aY(0)); move(canvas(), aX(8) + 30, aY(0)); release(canvas());
    expect(clipOf(y.clipId).lengthBeats).toBeGreaterThan(8);
    expect(clipOf(y.clipId).lengthBeats % 0.25).toBe(0);
  });

  it("clips never get a negative start or zero length", () => {
    const { clipId } = setupSynth();
    mount(<ArrangementView />);
    press(canvas(), aX(2), aY(0)); move(canvas(), -500, aY(0)); release(canvas());
    expect(clipOf(clipId).startBeat).toBe(0);
    press(canvas(), aX(8) - 3, aY(0)); move(canvas(), aX(0), aY(0)); release(canvas());
    expect(clipOf(clipId).lengthBeats).toBeGreaterThan(0);
  });

  it("Delete removes the selected clip (and closes its editor); undo brings it back", () => {
    const { clipId } = setupSynth();
    s().openPianoRoll(clipId);
    mount(<ArrangementView />);
    press(canvas(), aX(2), aY(0)); release(canvas());
    act(() => { canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    expect(s().manifest!.clips).toHaveLength(0);
    expect(s().activePianoRollClipId).toBeNull();
    act(() => s().undo());
    expect(s().manifest!.clips).toHaveLength(1);
  });

  it("mute / solo buttons in the track header toggle the mixer strip", () => {
    const { trackId } = setupSynth();
    mount(<ArrangementView />);
    const strip = () => s().manifest!.mixer.strips.find((x: any) => x.trackId === trackId)!;
    press(canvas(), 160 - 40, 24 + 48); release(canvas());
    expect(strip().muted).toBe(true);
    press(canvas(), 160 - 16, 24 + 48); release(canvas());
    expect(strip().soloed).toBe(true);
  });

  it("clicking/dragging the ruler seeks the engine (snapped to 1/16) and moves the playhead", () => {
    setupSynth();
    const fake = { seek: vi.fn(), stop: vi.fn(), transport: { getCurrentBeat: () => 0 }, isPlaying: false };
    setActiveEngine(fake as any);
    mount(<ArrangementView />);
    const c = canvas();
    press(c, aX(6), 10);
    expect(fake.seek).toHaveBeenLastCalledWith(6);
    expect(s().playheadBeat).toBe(6);
    move(c, aX(9.1), 10); // dragging scrubs
    expect(fake.seek).toHaveBeenLastCalledWith(9);
    release(c);
    move(c, aX(12), 10); // after release, moving must NOT seek
    expect(fake.seek).toHaveBeenLastCalledWith(9);
    setActiveEngine(null);
  });

  it("clicks on the ruler never start a clip drag or change selection", () => {
    const { clipId } = setupSynth();
    mount(<ArrangementView />);
    press(canvas(), aX(2), 10); release(canvas());
    expect(clipOf(clipId).startBeat).toBe(0);
  });
});

describe("AddTrackMenu", () => {
  it("creates instrument + track + strip from a template in one undo step", () => {
    mount(<AddTrackMenu />);
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    const item = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Synth Bass"))!;
    act(() => item.click());
    const m = s().manifest!;
    expect(m.tracks).toHaveLength(1);
    expect(m.instruments).toHaveLength(1);
    expect(m.instruments[0].pluginId).toBe("sonora.synth");
    expect(m.tracks[0].instrumentId).toBe(m.instruments[0].id);
    expect(m.mixer.strips).toHaveLength(1);
    act(() => s().undo());
    expect(s().manifest!.tracks).toHaveLength(0);
    expect(s().manifest!.instruments).toHaveLength(0);
    expect(s().manifest!.mixer.strips).toHaveLength(0);
  });
});
