import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBlankManifest } from "@sonora/schema";

const SRC = "../src/daw";
const { useProjectStore } = await import(`${SRC}/state/projectStore`);
const { TRACK_TEMPLATES } = await import(`${SRC}/engine/instruments/registry`);
const { MixerPanel } = await import(`${SRC}/components/mixer/MixerPanel`);
const { MASTER_TARGET } = await import(`${SRC}/state/commands`);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const s = () => useProjectStore.getState();
const tpl = (key: string) => TRACK_TEMPLATES.find((t: any) => t.key === key);
const strip = (id: string) => s().manifest!.mixer.strips.find((x: any) => x.trackId === id)!;

let root: Root, host: HTMLDivElement;
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<MixerPanel />));
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
beforeEach(() => s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" })));

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T;
const qa = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const byLabel = (label: string) => q<HTMLInputElement>(`[aria-label="${label}"]`);

function setValue(el: HTMLInputElement | HTMLSelectElement, v: string | number) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, String(v));
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const mouse = (el: Element | Window, type: string) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); });
const click = (el: Element) => act(() => (el as HTMLElement).click());

function addTrack(key = "bass") { return s().addTrackFromTemplate(tpl(key), "u"); }
/** Add an effect through the real "+ Add effect" dropdown of the nth strip */
function addEffectVia(stripIndex: number, pluginId: string) {
  setValue(qa('select[aria-label="Add effect"]')[stripIndex] as HTMLSelectElement, pluginId);
}

describe("MixerPanel", () => {
  it("shows a strip per track plus Master, and a helpful empty state", () => {
    mount();
    expect(host.textContent).toContain("No tracks yet");
    expect(host.textContent).toContain("Master");
    act(() => { addTrack("bass"); addTrack("drums"); });
    expect(host.textContent).toContain("Bass");
    expect(host.textContent).toContain("Drums");
    expect(qa('[role="meter"]')).toHaveLength(3);
  });

  it("adding an effect from the dropdown inserts it and opens its editor with real sliders", () => {
    const t = addTrack();
    mount();
    addEffectVia(0, "sonora.delay");
    expect(strip(t).inserts.map((i: any) => i.pluginId)).toEqual(["sonora.delay"]);
    expect(host.textContent).toContain("Bass › Delay");
    for (const label of ["Time", "Feedback", "Tone", "Mix"]) expect(byLabel(label), label).toBeTruthy();
  });

  it("a slider moves the setting (with log scaling); a whole drag is ONE undo step", () => {
    const t = addTrack();
    mount();
    addEffectVia(0, "sonora.delay");
    const time = byLabel("Time");
    mouse(time, "mousedown");
    for (const v of [100, 300, 400, 500]) setValue(time, v);
    mouse(window, "mouseup"); // released OUTSIDE the slider, as happens in real drags
    const ms = strip(t).inserts[0].presetData.timeMs as number;
    // Log scale over 1ms..2000ms: the slider midpoint is ~45ms (a linear slider would give ~1000ms)
    expect(ms).toBeGreaterThan(30);
    expect(ms).toBeLessThan(70);
    act(() => s().undo());
    expect(strip(t).inserts[0].presetData.timeMs).toBe(350);
    act(() => s().undo());
    expect(strip(t).inserts).toHaveLength(0);
  });

  it("keyboard-style changes (no drag) are individual undo steps; double-click resets to default", () => {
    const t = addTrack();
    mount();
    addEffectVia(0, "sonora.eq");
    const low = byLabel("Low");
    setValue(low, 700); setValue(low, 800);
    expect(strip(t).inserts[0].presetData.lowGain).toBeGreaterThan(0);
    act(() => s().undo());
    const afterOne = strip(t).inserts[0].presetData.lowGain as number;
    expect(afterOne).toBeGreaterThan(0); // only the last change was undone
    act(() => { byLabel("Low").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(strip(t).inserts[0].presetData.lowGain).toBe(0);
  });

  it("bypass toggles; reorder buttons respect the ends; remove works and closes the editor", () => {
    const t = addTrack();
    mount();
    addEffectVia(0, "sonora.eq"); addEffectVia(0, "sonora.reverb");
    const [eq, rev] = strip(t).inserts.map((i: any) => i.id);
    click(q('[aria-label="Bypass EQ"]'));
    expect(strip(t).inserts[0].bypassed).toBe(true);
    expect((q('[aria-label="Move EQ up"]') as HTMLButtonElement).disabled).toBe(true);
    expect((q('[aria-label="Move Reverb down"]') as HTMLButtonElement).disabled).toBe(true);
    click(q('[aria-label="Move Reverb up"]'));
    expect(strip(t).inserts.map((i: any) => i.id)).toEqual([rev, eq]);
    expect(host.textContent).toContain("Bass › Reverb"); // editor still open on the reverb
    click(q('[aria-label="Remove Reverb"]'));
    expect(strip(t).inserts.map((i: any) => i.id)).toEqual([eq]);
    expect(host.textContent).not.toContain("Bass › Reverb"); // its editor closed itself
  });

  it("undoing the add of an open effect closes its editor instead of leaving a dead panel", () => {
    addTrack();
    mount();
    addEffectVia(0, "sonora.distortion");
    expect(host.textContent).toContain("Distortion");
    act(() => s().undo());
    expect(byLabel("Drive")).toBeNull();
  });

  it("instrument button opens the synth editor; enum + slider edits reach presetData", () => {
    addTrack("bass");
    mount();
    click(qa("button").find((b) => b.textContent?.includes("Synth Bass"))!);
    expect(host.textContent).toContain("Bass › Synth Bass");
    setValue(byLabel("Osc 1") as unknown as HTMLSelectElement, "square");
    expect(s().manifest!.instruments[0].presetData.wave1).toBe("square");
    setValue(byLabel("Cutoff"), 1000);
    expect(s().manifest!.instruments[0].presetData.cutoffHz).toBe(18000);
    act(() => { s().undo(); s().undo(); });
    expect(s().manifest!.instruments[0].presetData.wave1).toBe("sawtooth");
  });

  it("drum instrument shows its own parameters", () => {
    addTrack("drums");
    mount();
    click(qa("button").find((b) => b.textContent?.includes("Drum Kit"))!);
    expect(byLabel("Kick pitch")).toBeTruthy();
    expect(byLabel("Cutoff")).toBeNull();
  });

  it("faders, pan and M/S write to the right strip; double-click resets", () => {
    const a = addTrack("bass"), b = addTrack("lead");
    mount();
    setValue(byLabel("Bass volume"), -12);
    setValue(byLabel("Lead pan"), 0.5);
    click(q('[aria-label="Mute Bass"]'));
    click(q('[aria-label="Solo Lead"]'));
    expect(strip(a).volumeDb).toBe(-12);
    expect(strip(b).pan).toBe(0.5);
    expect(strip(a).muted).toBe(true);
    expect(strip(b).soloed).toBe(true);
    expect(q('[aria-label="Mute Bass"]').getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("R50");
    expect(host.textContent).toContain("-12.0 dB");
    act(() => { byLabel("Bass volume").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(strip(a).volumeDb).toBe(0);
  });

  it("master strip: volume and its own insert chain, separate from tracks", () => {
    const t = addTrack();
    mount();
    setValue(byLabel("Master volume"), -6);
    expect(s().manifest!.mixer.masterVolumeDb).toBe(-6);
    addEffectVia(1, "sonora.compressor"); // strip 0 = Bass, strip 1 = Master
    expect(s().manifest!.mixer.masterInserts.map((i: any) => i.pluginId)).toEqual(["sonora.compressor"]);
    expect(strip(t).inserts).toHaveLength(0);
    expect(host.textContent).toContain("Master › Compressor");
    expect(qa('[aria-label^="Mute"]')).toHaveLength(1); // master has no mute/solo/pan
  });

  it("an unavailable plugin is shown honestly, can be removed/bypassed, can't open an editor, and keeps its data", () => {
    const t = addTrack();
    act(() => s().dispatch({ type: "ADD_INSERT", target: t, insert: { id: "vst", pluginId: "vendor.mystery", pluginType: "native-vst", isBuiltIn: false, presetData: { secret: 1 }, bypassed: false, displayName: "Mystery VST" } }));
    mount();
    expect(host.textContent).toContain("Mystery VST (unavailable)");
    click(qa("button").find((b) => b.textContent?.includes("Mystery VST"))!);
    expect(host.textContent).not.toContain("Bass › Mystery");
    click(q('[aria-label="Bypass Mystery VST"]'));
    expect(strip(t).inserts[0].bypassed).toBe(true);
    expect(strip(t).inserts[0].presetData).toEqual({ secret: 1 });
    click(q('[aria-label="Remove Mystery VST"]'));
    expect(strip(t).inserts).toHaveLength(0);
  });

  it("meters read from the engine without crashing when there is no engine", () => {
    addTrack();
    mount();
    expect(qa('[role="meter"]').length).toBeGreaterThan(0);
  });

  it("a gesture left open by an unmounting slider is closed (no stuck undo grouping)", () => {
    const t = addTrack();
    mount();
    addEffectVia(0, "sonora.delay");
    mouse(byLabel("Time"), "mousedown");
    setValue(byLabel("Time"), 800);
    click(q('[aria-label="Remove Delay"]')); // editor + slider unmount mid-drag
    // the next edit must create its own undo entry rather than being swallowed by a dangling gesture
    click(q('[aria-label="Mute Bass"]'));
    act(() => s().undo());
    expect(strip(t).muted).toBe(false);
  });
});
