import { describe, it, expect, beforeEach } from "vitest";
import { createBlankManifest, type MixerStrip } from "@sonora/schema";
import { applyCommand, invertCommand, MASTER_TARGET } from "../commands";
import { useProjectStore } from "../projectStore";
import { TRACK_TEMPLATES } from "../../engine/instruments/registry";
import { EFFECT_CATALOG, makeInsert } from "../../engine/effects/registry";
import { sanitizeParams, defaultParams, valueToNorm, normToValue } from "../../engine/plugins/params";
import { SYNTH_DESCRIPTOR, sanitizeSynthPreset, DEFAULT_SYNTH_PRESET } from "../../engine/instruments/synth";

const s = () => useProjectStore.getState();
const strip = (trackId: string) => s().manifest!.mixer.strips.find((x: MixerStrip) => x.trackId === trackId)!;
const tpl = (key: string) => TRACK_TEMPLATES.find((t) => t.key === key)!;

beforeEach(() => s().loadManifest(createBlankManifest({ projectId: "p", title: "t", authorId: "u" })));

describe("parameter descriptors", () => {
  it("sanitize clamps, rejects junk, fills defaults, drops unknown keys", () => {
    const out = sanitizeParams(SYNTH_DESCRIPTOR.params, { cutoffHz: 1e9, resonance: NaN, wave1: "banana", wave2: "square", evil: "<script>", level: -3 });
    expect(out.cutoffHz).toBe(18000);
    expect(out.resonance).toBe(DEFAULT_SYNTH_PRESET.resonance);
    expect(out.wave1).toBe(DEFAULT_SYNTH_PRESET.wave1);
    expect(out.wave2).toBe("square");
    expect(out.level).toBe(0);
    expect("evil" in out).toBe(false);
  });
  it("every effect's defaults are inside its own ranges and survive sanitizing unchanged", () => {
    for (const { descriptor } of EFFECT_CATALOG) {
      const d = defaultParams(descriptor.params);
      expect(sanitizeParams(descriptor.params, d)).toEqual(d);
    }
  });
  it("the synth's derived sanitizer matches the hand-written defaults (refactor guard)", () => {
    expect(sanitizeSynthPreset({})).toEqual(DEFAULT_SYNTH_PRESET);
  });
  it("log and linear slider mapping round-trips and hits both ends", () => {
    for (const { descriptor } of EFFECT_CATALOG) for (const p of descriptor.params) {
      if (p.kind === "enum" || p.kind === "string") continue;
      expect(valueToNorm(p, p.min)).toBeCloseTo(0, 6);
      expect(valueToNorm(p, p.max)).toBeCloseTo(1, 6);
      expect(normToValue(p, 0)).toBeCloseTo(p.min, 4);
      expect(normToValue(p, 1)).toBeCloseTo(p.max, 4);
      const mid = normToValue(p, 0.5);
      expect(valueToNorm(p, mid)).toBeCloseTo(0.5, p.step ? 1 : 3);
    }
  });
});

describe("log slider mapping gives musically sensible values", () => {
  const param = (pluginId: string, key: string) => {
    const p = EFFECT_CATALOG.find((e) => e.descriptor.pluginId === pluginId)!.descriptor.params.find((x) => x.key === key)!;
    if (p.kind === "enum" || p.kind === "string") throw new Error("not numeric");
    return p;
  };
  it("delay time: slider midpoint is the geometric mean of 1ms..2000ms (~45ms), not ~1000ms", () => {
    expect(normToValue(param("sonora.delay", "timeMs"), 0.5)).toBeCloseTo(Math.sqrt(2000), 0);
  });
  it("EQ mid frequency: 1 kHz sits at ln(5)/ln(40) ~ 0.436 along a 200Hz..8kHz log slider", () => {
    expect(valueToNorm(param("sonora.eq", "midFreq"), 1000)).toBeCloseTo(Math.log(5) / Math.log(40), 3);
  });
  it("linear params stay linear (EQ gain: midpoint is 0 dB)", () => {
    expect(normToValue(param("sonora.eq", "midGain"), 0.5)).toBeCloseTo(0, 6);
  });
});

describe("insert commands", () => {
  function withTrack() {
    return s().addTrackFromTemplate(tpl("bass"), "u");
  }
  it("add / remove / reorder inserts on a track, in order", () => {
    const t = withTrack();
    const a = s().addInsert(t, "sonora.eq")!, b = s().addInsert(t, "sonora.delay")!, c = s().addInsert(t, "sonora.reverb")!;
    expect(strip(t).inserts.map((i) => i.id)).toEqual([a, b, c]);
    s().moveInsert(t, c, -1);
    expect(strip(t).inserts.map((i) => i.id)).toEqual([a, c, b]);
    s().moveInsert(t, a, -5); // already first: no-op, no history entry
    s().removeInsert(t, c);
    expect(strip(t).inserts.map((i) => i.id)).toEqual([a, b]);
  });
  it("every insert operation is undoable and redoable", () => {
    const t = withTrack();
    const a = s().addInsert(t, "sonora.eq")!;
    s().addInsert(t, "sonora.delay");
    s().setInsertBypass(t, a, true);
    s().setInsertParam(t, a, "lowGain", 6);
    s().moveInsert(t, a, +1);
    s().removeInsert(t, a);
    for (let i = 0; i < 6; i++) s().undo();
    expect(strip(t).inserts).toHaveLength(0);
    for (let i = 0; i < 6; i++) s().redo();
    expect(strip(t).inserts.map((i) => i.pluginId)).toEqual(["sonora.delay"]);
    // and step back to the state just before the removal: bypassed, edited, moved
    s().undo();
    const eq = strip(t).inserts.find((i) => i.id === a)!;
    expect(eq.bypassed).toBe(true);
    expect(eq.presetData.lowGain).toBe(6);
    expect(strip(t).inserts[1].id).toBe(a);
  });
  it("a removed insert comes back at its original position with its settings", () => {
    const t = withTrack();
    const a = s().addInsert(t, "sonora.eq")!, b = s().addInsert(t, "sonora.delay")!, c = s().addInsert(t, "sonora.reverb")!;
    s().setInsertParam(t, b, "feedback", 0.8);
    s().removeInsert(t, b);
    s().undo();
    expect(strip(t).inserts.map((i) => i.id)).toEqual([a, b, c]);
    expect(strip(t).inserts[1].presetData.feedback).toBe(0.8);
  });
  it("master inserts work the same way and don't touch track strips", () => {
    const t = withTrack();
    const id = s().addInsert(MASTER_TARGET, "sonora.compressor")!;
    expect(s().manifest!.mixer.masterInserts.map((i) => i.id)).toEqual([id]);
    expect(strip(t).inserts).toHaveLength(0);
    s().undo();
    expect(s().manifest!.mixer.masterInserts).toHaveLength(0);
  });
  it("unknown plugin id, unknown track and duplicate ids are safe no-ops", () => {
    const t = withTrack();
    expect(s().addInsert(t, "vendor.mystery")).toBeNull();
    const before = s().manifest;
    s().dispatch({ type: "ADD_INSERT", target: "no-such-track", insert: makeInsert("x", "sonora.eq")! });
    expect(s().manifest!.mixer).toEqual(before!.mixer);
    const ins = makeInsert("dup", "sonora.eq")!;
    s().dispatch({ type: "ADD_INSERT", target: t, insert: ins });
    s().dispatch({ type: "ADD_INSERT", target: t, insert: ins });
    expect(strip(t).inserts).toHaveLength(1);
  });
  it("setInsertParam ignores unchanged values (a no-op drag adds no undo steps)", () => {
    const t = withTrack();
    const a = s().addInsert(t, "sonora.eq")!;
    s().setInsertParam(t, a, "lowGain", 0); // equals the default
    s().undo();
    expect(strip(t).inserts).toHaveLength(0); // the single undo removed the ADD, not a phantom param edit
  });
  it("a whole knob drag is ONE undo step", () => {
    const t = withTrack();
    const a = s().addInsert(t, "sonora.delay")!;
    s().beginGesture();
    for (let v = 100; v <= 800; v += 50) s().setInsertParam(t, a, "timeMs", v);
    s().endGesture();
    expect(strip(t).inserts[0].presetData.timeMs).toBe(800);
    s().undo();
    expect(strip(t).inserts[0].presetData.timeMs).toBe(350); // back to the default, in one step
    s().redo();
    expect(strip(t).inserts[0].presetData.timeMs).toBe(800);
  });
  it("unavailable-plugin inserts keep their settings through edits to others (preserved, not dropped)", () => {
    const t = withTrack();
    s().dispatch({ type: "ADD_INSERT", target: t, insert: { id: "vst", pluginId: "vendor.mystery", pluginType: "native-vst", isBuiltIn: false, presetData: { secret: 42 }, bypassed: false, displayName: "Mystery" } });
    const a = s().addInsert(t, "sonora.eq")!;
    s().setInsertParam(t, a, "lowGain", 3);
    expect(strip(t).inserts[0].presetData).toEqual({ secret: 42 });
  });
});

describe("instrument + master settings", () => {
  it("instrument params update the preset and undo restores it exactly", () => {
    const t = s().addTrackFromTemplate(tpl("lead"), "u");
    const inst = s().manifest!.instruments.find((i) => i.id === s().manifest!.tracks.find((x) => x.id === t)!.instrumentId)!;
    const before = structuredClone(inst.presetData);
    s().setInstrumentParam(inst.id, "cutoffHz", 900);
    s().setInstrumentParam(inst.id, "wave1", "square");
    expect(s().manifest!.instruments[0].presetData).toMatchObject({ cutoffHz: 900, wave1: "square" });
    s().undo(); s().undo();
    expect(s().manifest!.instruments[0].presetData).toEqual(before);
  });
  it("master volume is clamped, ignores NaN, and is undoable", () => {
    s().setMasterVolume(-6);
    expect(s().manifest!.mixer.masterVolumeDb).toBe(-6);
    s().setMasterVolume(999);
    expect(s().manifest!.mixer.masterVolumeDb).toBe(12);
    s().setMasterVolume(NaN);
    expect(s().manifest!.mixer.masterVolumeDb).toBe(12);
    s().undo(); s().undo();
    expect(s().manifest!.mixer.masterVolumeDb).toBe(0);
  });
  it("inverse of every new command round-trips the manifest exactly", () => {
    const t = s().addTrackFromTemplate(tpl("pad"), "u");
    const eq = makeInsert("i1", "sonora.eq")!;
    s().dispatch({ type: "ADD_INSERT", target: t, insert: eq });
    s().dispatch({ type: "ADD_INSERT", target: t, insert: makeInsert("i2", "sonora.delay")! });
    const m0 = s().manifest!;
    const cmds = [
      { type: "MOVE_INSERT", target: t, insertId: "i1", newIndex: 1 },
      { type: "SET_INSERT_BYPASS", target: t, insertId: "i2", bypassed: true },
      { type: "SET_INSERT_PRESET", target: t, insertId: "i1", presetData: { lowGain: 9 } },
      { type: "REMOVE_INSERT", target: t, insertId: "i2" },
      { type: "CHANGE_MASTER_VOLUME", volumeDb: -9 },
      { type: "SET_INSTRUMENT_PRESET", instrumentId: m0.instruments[0].id, presetData: { level: 0.1 } },
    ] as const;
    for (const c of cmds) {
      const after = applyCommand(m0, c as any);
      const inv = invertCommand(m0, c as any)!;
      expect(inv, c.type).not.toBeNull();
      expect(applyCommand(after, inv)).toEqual(m0);
    }
  });
});
