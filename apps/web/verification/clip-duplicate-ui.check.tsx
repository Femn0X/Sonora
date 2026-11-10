import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBlankManifest, type MidiClip } from "@sonora/schema";
const SRC = "../src/daw";
const { useProjectStore } = await import(`${SRC}/state/projectStore`);
const { TRACK_TEMPLATES } = await import(`${SRC}/engine/instruments/registry`);
const { ArrangementView } = await import(`${SRC}/components/arrangement/ArrangementView`);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {}, set: () => true })) as any;
const s = () => useProjectStore.getState();
let root: Root, host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
beforeEach(() => { s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" })); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
const canvas = () => host.querySelector("canvas") as HTMLCanvasElement;
const clicks = (x: number, y: number) => act(() => { canvas().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 })); canvas().dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
const ctrlD = (init: KeyboardEventInit = { ctrlKey: true }) => act(() => { canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true, ...init })); });
const aX = (beat: number) => 160 + beat * 24, aY = 24 + 30;

describe("Ctrl+D duplicates the selected clip", () => {
  function setup() {
    const trackId = s().addTrackFromTemplate(TRACK_TEMPLATES.find((t: any) => t.key === "lead"), "u");
    const clipId = s().createClipOnTrack(trackId, 0)!; // 8 beats
    s().addNotes(clipId, [{ pitch: 60, startBeat: 0, lengthBeats: 1, velocity: 100 }]);
    act(() => root.render(<ArrangementView />));
    return { trackId, clipId };
  }
  it("copies it after itself, selects the copy, and pressing again keeps extending", () => {
    const { clipId } = setup();
    clicks(aX(2), aY);
    expect(s().selectedClipId).toBe(clipId);
    ctrlD();
    const clips = s().manifest!.clips as MidiClip[];
    expect(clips.map((c) => c.startBeat)).toEqual([0, 8]);
    expect(s().selectedClipId).toBe(clips[1].id);        // the COPY is selected now
    ctrlD();
    expect((s().manifest!.clips as MidiClip[]).map((c) => c.startBeat)).toEqual([0, 8, 16]);
    expect((s().manifest!.clips as MidiClip[])[2].notes).toHaveLength(1);
  });
  it("works with the Cmd key too, is one undo step per press, and does nothing with no selection", () => {
    const { clipId } = setup();
    ctrlD();                                             // nothing selected
    expect(s().manifest!.clips).toHaveLength(1);
    clicks(aX(2), aY);
    ctrlD({ metaKey: true });
    expect(s().manifest!.clips).toHaveLength(2);
    act(() => s().undo());
    expect(s().manifest!.clips.map((c: any) => c.id)).toEqual([clipId]);
  });
  it("a plain 'd' (no modifier) does nothing", () => {
    setup(); clicks(aX(2), aY);
    ctrlD({});
    expect(s().manifest!.clips).toHaveLength(1);
  });
});
