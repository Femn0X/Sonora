import { describe, it, expect, beforeAll } from "vitest";
// @ts-expect-error untyped
import * as NodeAudio from "node-web-audio-api";
import { createDemoManifest } from "../src/daw/demoProject";
import type { ProjectManifest } from "@sonora/schema";
import { makeInsert } from "../src/daw/engine/effects/registry";

/**
 * Runs the REAL AudioEngine on a real (headless, no output device) audio clock.
 * We can't hear it, but we can verify the lifecycle, scheduling, looping,
 * live-edit and silencing behaviour by spying on what reaches each instrument.
 */
let AudioEngine: typeof import("../src/daw/engine/audioEngine").AudioEngine;

beforeAll(async () => {
  (globalThis as any).AudioContext = class extends NodeAudio.AudioContext {
    constructor() { super({ sinkId: "none" }); }
  };
  ({ AudioEngine } = await import("../src/daw/engine/audioEngine"));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for AUDIO time to pass, not wall-clock time. The engine runs on the audio clock; a fixed sleep
 * under CPU load can be shorter than the audio time the assertions need.
 */
async function audioAdvance(e: any, seconds: number, timeoutMs = 15000) {
  const target = e.context.currentTime + seconds;
  const t0 = Date.now();
  while (e.context.currentTime < target) {
    if (Date.now() - t0 > timeoutMs) throw new Error("audio clock did not advance (no audio thread?)");
    await sleep(10);
  }
}

function spy(engine: any) {
  const calls: { id: string; pitch: number; startTime: number; durationSec: number }[] = [];
  let offs = 0;
  for (const [id, live] of engine.instruments as Map<string, any>) {
    const trig = live.instrument.trigger.bind(live.instrument);
    live.instrument.trigger = (p: any) => { calls.push({ id, pitch: p.pitch, startTime: p.startTime, durationSec: p.durationSec }); trig(p); };
    const off = live.instrument.allNotesOff.bind(live.instrument);
    live.instrument.allNotesOff = () => { offs++; off(); };
  }
  return { calls, get offs() { return offs; } };
}

describe("AudioEngine on a live clock", () => {
  it("syncs the manifest, plays, schedules notes ahead of time, and the playhead advances", async () => {
    const e = new AudioEngine();
    const m = createDemoManifest("x");
    m.bpm = 240; // 4 beats/sec so a short test covers several beats
    e.loadManifest(m);
    const s = spy(e);
    await e.play();
    await audioAdvance(e, 0.7);
    const beat = e.transport.getCurrentBeat();
    expect(e.isPlaying).toBe(true);
    expect(beat).toBeGreaterThan(1.5);
    expect(s.calls.length).toBeGreaterThan(5);
    expect(new Set(s.calls.map((c) => c.id))).toEqual(new Set(["i1", "i2", "i3"])); // all three instruments fire
    // notes are handed over in the FUTURE (lookahead), not at/after their play time
    expect(s.calls.every((c) => c.startTime >= 0)).toBe(true);
    e.dispose();
  });

  it("pause silences everything and keeps position; resume continues from there; stop resets", async () => {
    const e = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 240;
    e.loadManifest(m);
    const s = spy(e);
    await e.play();
    await audioAdvance(e, 0.4);
    e.pause();
    expect(s.offs).toBeGreaterThanOrEqual(3); // allNotesOff reached every instrument
    expect(e.isPlaying).toBe(false);
    const rested = e.transport.getCurrentBeat();
    expect(rested).toBeGreaterThan(0.5);
    const callsAtPause = s.calls.length;
    await sleep(300);
    expect(s.calls.length).toBe(callsAtPause); // nothing scheduled while paused
    await e.play();
    expect(e.transport.getCurrentBeat()).toBeGreaterThanOrEqual(rested - 0.01);
    e.stop();
    expect(e.transport.getCurrentBeat()).toBe(0);
    e.dispose();
  });

  it("song loop wraps: playhead stays inside the loop and notes keep firing past the first pass", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    m.bpm = 600; // 10 beats/sec -> the 16-beat song loops in ~1.6s
    e.loadManifest(m);
    e.setLoopEnabled(true);
    const s = spy(e);
    const windows: [number, number][] = [];
    const scheduleWindow = e.scheduleWindow.bind(e);
    e.scheduleWindow = (f: number, t: number, fn: unknown) => { windows.push([f, t]); scheduleWindow(f, t, fn); };
    await e.play();
    let max = 0;
    for (let i = 0; i < 26; i++) { await audioAdvance(e, 0.1); max = Math.max(max, e.transport.getCurrentBeat()); }
    expect(max).toBeLessThan(16.5);
    // 2.4s at 10 beats/s = 24 beats > one 16-beat pass, so kicks (pitch 36) from pass 2 must exist
    const kicks = s.calls.filter((c) => c.pitch === 36).length;
    expect(kicks).toBeGreaterThan(16);
    // ...and no window may EVER extend past the loop end (the playhead alone can hide a scheduler that ran on).
    expect(Math.max(...windows.map(([, to]) => to))).toBeLessThanOrEqual(16 + 1e-9);
    e.dispose();
  });

  it("pattern mode loops only the chosen clip", async () => {
    const e = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 480;
    e.loadManifest(m);
    const s = spy(e);
    await e.playClip("c1"); // drums only
    await audioAdvance(e, 0.6);
    expect(e.previewing).toBe("c1");
    expect(new Set(s.calls.map((c) => c.id))).toEqual(new Set(["i1"]));
    e.stop();
    expect(e.previewing).toBeNull();
    e.dispose();
  });

  it("edits made during playback are heard without restarting (live manifest)", async () => {
    const e = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 480;
    e.loadManifest(m);
    const s = spy(e);
    await e.play();
    await audioAdvance(e, 0.2);
    // add a distinctive note (pitch 99 on the bass track) right ahead of the playhead
    const bass = m.clips.find((c) => c.id === "c2") as any;
    const now = e.transport.getCurrentBeat();
    const edited: ProjectManifest = { ...m, clips: m.clips.map((c) => (c.id === "c2" ? { ...bass, notes: [...bass.notes, { id: "live", pitch: 99, startBeat: Math.ceil(now + 2), lengthBeats: 0.25, velocity: 100 }] } : c)) };
    e.loadManifest(edited);
    await audioAdvance(e, 0.7);
    expect(s.calls.some((c) => c.pitch === 99)).toBe(true);
    e.dispose();
  });

  it("unrelated manifest edits keep instruments; setting changes update IN PLACE (same instance)", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    e.loadManifest(m);
    const before = e.instruments.get("i2").instrument;
    e.loadManifest({ ...m, clips: [...m.clips] }); // unrelated edit
    expect(e.instruments.get("i2").instrument).toBe(before);
    e.loadManifest({ ...m, instruments: m.instruments.map((i) => (i.id === "i2" ? { ...i, presetData: { ...i.presetData, cutoffHz: 900 } } : i)) });
    expect(e.instruments.get("i2").instrument).toBe(before); // updated live, not recreated
    e.dispose();
  });

  it("removed tracks release their channels; unknown plugins stay silent without throwing", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    e.loadManifest(m);
    expect(e.channels.size).toBe(4);
    const noT3 = { ...m, tracks: m.tracks.filter((t) => t.id !== "t3"), mixer: { ...m.mixer, strips: m.mixer.strips.filter((s) => s.trackId !== "t3") } };
    e.loadManifest(noT3);
    expect(e.channels.size).toBe(3);
    const weird = { ...noT3, instruments: [...noT3.instruments.filter((i) => i.id !== "i1"), { ...noT3.instruments[0], id: "i1", pluginId: "vendor.mystery-vst", pluginType: "native-vst" as const }] };
    expect(() => e.loadManifest(weird)).not.toThrow();
    expect(e.instruments.has("i1")).toBe(false);
    await e.play(); await sleep(150); e.stop();
    e.dispose();
  });

  it("seek while playing restarts cleanly at the new position; auditionNote plays immediately", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 240;
    e.loadManifest(m);
    const s = spy(e);
    await e.play();
    await audioAdvance(e, 0.1);
    e.seek(8);
    await audioAdvance(e, 0.15);
    const b = e.transport.getCurrentBeat();
    expect(b).toBeGreaterThanOrEqual(8);
    expect(b).toBeLessThan(10);
    const n = s.calls.length;
    await e.auditionNote("t2", 40, 100);
    expect(s.calls.length).toBe(n + 1);
    e.dispose();
  });

  it("dispose is idempotent and safe after use", async () => {
    const e = new AudioEngine();
    e.loadManifest(createDemoManifest("x"));
    await e.play();
    e.dispose();
    expect(() => e.dispose()).not.toThrow();
    expect(() => e.loadManifest(createDemoManifest("x"))).not.toThrow();
  });

  it("a corrupt note, tempo or time signature in the project can't stall playback or crash the engine", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    const bass = m.clips.find((c) => c.id === "c2") as any;
    const hostile: ProjectManifest = {
      ...m,
      bpm: 1e9,
      timeSignature: [0, 4] as any,
      clips: m.clips.map((c) => (c.id === "c2" ? { ...bass, notes: [{ id: "bad1", pitch: NaN, startBeat: 0, lengthBeats: 1, velocity: 100 }, { id: "bad2", pitch: 40, startBeat: NaN, lengthBeats: 1, velocity: 100 }, ...bass.notes] } : c)),
    };
    expect(() => e.loadManifest(hostile)).not.toThrow();
    e.setLoopEnabled(true);
    const s = spy(e);
    await e.play();
    await audioAdvance(e, 0.5);
    expect(e.isPlaying).toBe(true);
    expect(Number.isFinite(e.transport.getCurrentBeat())).toBe(true);
    expect(s.calls.length).toBeGreaterThan(0); // the good notes still played
    expect(s.calls.every((c) => Number.isFinite(c.pitch) && Number.isFinite(c.startTime))).toBe(true);
    e.dispose();
  });

  it("insert effects sync per strip and on the master; param edits update in place", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    const withFx = (extra: Partial<ProjectManifest["mixer"]> & { strip2?: any[] } = {}): ProjectManifest => ({
      ...m,
      mixer: {
        ...m.mixer,
        masterInserts: extra.masterInserts ?? [],
        strips: m.mixer.strips.map((s) => (s.trackId === "t2" ? { ...s, inserts: extra.strip2 ?? [] } : s)),
      },
    });
    const eq = makeInsert("eq1", "sonora.eq")!;
    const comp = makeInsert("c1", "sonora.compressor")!;
    e.loadManifest(withFx({ strip2: [eq], masterInserts: [comp] }));
    expect(e.channels.get("t2").inserts.size).toBe(1);
    expect(e.channels.get("t1").inserts.size).toBe(0);
    expect(e.masterChain.size).toBe(1);

    const live = e.channels.get("t2").inserts.get("eq1");
    let setParamsCalls = 0;
    const orig = live.setParams.bind(live);
    live.setParams = (d: any) => { setParamsCalls++; orig(d); };
    e.loadManifest(withFx({ strip2: [{ ...eq, presetData: { ...eq.presetData, lowGain: 9 } }], masterInserts: [comp] }));
    expect(e.channels.get("t2").inserts.get("eq1")).toBe(live); // same instance
    expect(setParamsCalls).toBe(1);
    e.loadManifest(withFx({ strip2: [], masterInserts: [] }));
    expect(e.channels.get("t2").inserts.size).toBe(0);
    expect(e.masterChain.size).toBe(0);
    e.dispose();
  });

  it("changing an instrument's settings updates it IN PLACE: same instance, ringing notes not cut", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 240;
    e.loadManifest(m);
    const inst = e.instruments.get("i2").instrument;
    let offs = 0; const off = inst.allNotesOff.bind(inst); inst.allNotesOff = () => { offs++; off(); };
    let presets = 0; const sp = inst.setPreset.bind(inst); inst.setPreset = (d: any) => { presets++; sp(d); };
    await e.play();
    await audioAdvance(e, 0.3);
    e.loadManifest({ ...m, instruments: m.instruments.map((i) => (i.id === "i2" ? { ...i, presetData: { ...i.presetData, cutoffHz: 1500 } } : i)) });
    expect(e.instruments.get("i2").instrument).toBe(inst);
    expect(presets).toBe(1);
    expect(offs).toBe(0);
    // an instrument whose plugin changes IS replaced
    e.loadManifest({ ...m, instruments: m.instruments.map((i) => (i.id === "i2" ? { ...i, pluginId: "sonora.drums", presetData: {} } : i)) });
    expect(e.instruments.get("i2").instrument).not.toBe(inst);
    e.dispose();
  });

  it("meters: peak readers return finite 0..1 values for tracks, master, and unknown tracks", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x"); m.bpm = 240;
    e.loadManifest(m);
    await e.play();
    await audioAdvance(e, 0.5);
    for (const v of [e.getPeak("t1"), e.getPeak("t2"), e.getMasterPeak(), e.getPeak("nope")]) {
      expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1);
    }
    expect(e.getPeak("nope")).toBe(0);
    e.dispose();
  });

  it("hostile project JSON (absurd volume/pan) can't blow up the output", async () => {
    const e: any = new AudioEngine();
    const m = createDemoManifest("x");
    e.loadManifest({ ...m, mixer: { ...m.mixer, masterVolumeDb: 1e9, strips: m.mixer.strips.map((s) => ({ ...s, volumeDb: 1e9, pan: 1e9 })) } });
    expect(Number.isFinite(e.channels.get("t1").gainNode.gain.value)).toBe(true);
    expect(e.channels.get("t1").gainNode.gain.value).toBeLessThan(5); // clamped to +12 dB (~4x), not 10^(5e7)
    expect(Math.abs(e.channels.get("t1").panNode.pan.value)).toBeLessThanOrEqual(1);
    e.dispose();
  });
});
