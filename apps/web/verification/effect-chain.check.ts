import { describe, it, expect } from "vitest";
import { samples } from "./helpers";
// @ts-expect-error untyped
import { OfflineAudioContext } from "node-web-audio-api";
import type { EffectInsert } from "@sonora/schema";
import { EffectChain } from "../src/daw/engine/effects/effectChain";
import { makeInsert } from "../src/daw/engine/effects/registry";
import { createDemoManifest } from "../src/daw/demoProject";
import { collectNoteEvents } from "../src/daw/engine/noteScheduling";
import { createInstrument } from "../src/daw/engine/instruments/registry";

const SR = 44100;
const sec = (s: number) => Math.round(s * SR);
const peak = (d: Float32Array, a = 0, b = d.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(d[i])); return m; };
function goertzel(d: Float32Array, hz: number, a: number, b: number) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w); let s0 = 0, s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a) * 2;
}
const ins = (id: string, pluginId: string, presetData: Record<string, unknown> = {}, bypassed = false): EffectInsert => ({ ...makeInsert(id, pluginId)!, presetData: { ...makeInsert(id, pluginId)!.presetData, ...presetData }, bypassed });

async function through(inserts: EffectInsert[], hz = 100, amp = 0.3, secs = 1, after?: (c: EffectChain) => void) {
  const ctx = new OfflineAudioContext(2, sec(secs), SR);
  const input = ctx.createGain(), output = ctx.createGain();
  const chain = new EffectChain(ctx as unknown as AudioContext, input, output);
  chain.sync(inserts);
  after?.(chain);
  const o = ctx.createOscillator(); o.frequency.value = hz; const g = ctx.createGain(); g.gain.value = amp;
  o.connect(g); g.connect(input); output.connect(ctx.destination); o.start();
  return { data: samples(await ctx.startRendering()), chain };
}
const same = (a: Float32Array, b: Float32Array, from = sec(0.1)) => { let m = 0; for (let i = from; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

describe("EffectChain wiring on real audio", () => {
  it("an empty chain is transparent (input goes straight to output)", async () => {
    const dry = (await through([])).data;
    expect(peak(dry, sec(0.3), sec(0.9))).toBeGreaterThan(0.25);
  });

  it("order matters: EQ(boost bass)->Distortion differs from Distortion->EQ", async () => {
    const eq = ins("eq", "sonora.eq", { lowGain: 12, lowFreq: 300 });
    const dist = ins("d", "sonora.distortion", { drive: 12, tone: 20000 });
    const a = (await through([eq, dist])).data;
    const b = (await through([dist, eq])).data;
    const h3 = (d: Float32Array) => goertzel(d, 300, sec(0.3), sec(0.9));
    console.log(`3rd-harmonic  EQ->Dist: ${h3(a).toFixed(4)}   Dist->EQ: ${h3(b).toFixed(4)}`);
    expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
    expect(Math.abs(h3(a) - h3(b)) / Math.max(h3(a), h3(b))).toBeGreaterThan(0.2);
  });

  it("removing every insert returns to a transparent path; effects are disposed", async () => {
    const ctx = new OfflineAudioContext(2, sec(1), SR);
    const input = ctx.createGain(), output = ctx.createGain();
    const chain = new EffectChain(ctx as unknown as AudioContext, input, output);
    chain.sync([ins("d", "sonora.distortion", { drive: 30 }), ins("e", "sonora.eq")]);
    expect(chain.size).toBe(2);
    chain.sync([]);
    expect(chain.size).toBe(0);
    const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain(); g.gain.value = 0.3;
    o.connect(g); g.connect(input); output.connect(ctx.destination); o.start();
    const d = samples(await ctx.startRendering());
    expect(peak(d, sec(0.3), sec(0.9))).toBeCloseTo(0.3, 2); // untouched sine amplitude
  });

  it("param edits update the SAME effect instance (no rebuild); bypass is transparent", async () => {
    const e = ins("e", "sonora.eq", { lowGain: 12, lowFreq: 300 });
    const { chain } = await through([e]);
    const before = chain.get("e");
    chain.sync([{ ...e, presetData: { ...e.presetData, lowGain: -6 } }]);
    expect(chain.get("e")).toBe(before);
    const dry = (await through([])).data;
    const byp = (await through([{ ...e, bypassed: true }])).data;
    expect(same(dry, byp)).toBeLessThan(1e-3);
  });

  it("reordering rewires without recreating effects", async () => {
    const a = ins("a", "sonora.eq"), b = ins("b", "sonora.delay");
    const { chain } = await through([a, b]);
    const ea = chain.get("a"), eb = chain.get("b");
    chain.sync([b, a]);
    expect(chain.get("a")).toBe(ea);
    expect(chain.get("b")).toBe(eb);
  });

  it("an unavailable plugin is skipped: audio still passes, neighbours still work, nothing throws", async () => {
    const mystery: EffectInsert = { id: "m", pluginId: "vendor.mystery", pluginType: "native-vst", isBuiltIn: false, presetData: { x: 1 }, bypassed: false, displayName: "Mystery" };
    const eq = ins("eq", "sonora.eq", { lowGain: 12, lowFreq: 300 });
    const plain = (await through([eq])).data;
    const withMystery = (await through([mystery, eq, mystery])).data;
    expect(same(plain, withMystery)).toBeLessThan(1e-4);
    expect(peak(withMystery, sec(0.3), sec(0.9))).toBeGreaterThan(0.3 * 3); // the EQ still boosted 100 Hz ~+12 dB
  });

  it("changing an insert's plugin under the same id replaces the effect", async () => {
    const { chain } = await through([ins("x", "sonora.eq")]);
    const old = chain.get("x");
    chain.sync([ins("x", "sonora.reverb")]);
    expect(chain.get("x")).not.toBe(old);
    expect(chain.size).toBe(1);
  });

  it("dispose is safe and idempotent", async () => {
    const { chain } = await through([ins("a", "sonora.eq")]);
    chain.dispose();
    expect(() => chain.dispose()).not.toThrow();
  });
});

describe("demo song WITH its insert effects", () => {
  it("is finite and keeps headroom under 0 dBFS (effects must not push the demo into clipping)", async () => {
    const m = createDemoManifest("x"), spb = 60 / m.bpm;
    expect(m.mixer.strips.flatMap((s) => s.inserts).map((i) => i.pluginId).sort()).toEqual(["sonora.distortion", "sonora.reverb"]);
    let pk = 0, rmsSum = 0, n = 0;
    for (let bar = 0; bar < 4; bar++) {
      const from = bar * 4, to = from + 4;
      const ctx = new OfflineAudioContext(2, sec(4 * spb + 2.5), SR);
      const master = ctx.createGain(); master.connect(ctx.destination);
      const inputs = new Map<string, GainNode>();
      for (const track of m.tracks) {
        const input = ctx.createGain(), fader = ctx.createGain();
        const chain = new EffectChain(ctx as unknown as AudioContext, input, fader);
        chain.sync(m.mixer.strips.find((s) => s.trackId === track.id)!.inserts);
        fader.connect(master);
        inputs.set(track.id, input);
      }
      const insts = new Map(m.instruments.map((r) => [r.id, createInstrument(ctx as unknown as AudioContext, r.pluginId, r.presetData)!]));
      for (const clip of m.clips) {
        if (clip.type !== "midi") continue;
        const inst = insts.get(m.tracks.find((t) => t.id === clip.trackId)!.instrumentId!)!;
        for (const e of collectNoteEvents(clip, from, to)) {
          inst.trigger({ destination: inputs.get(clip.trackId)!, pitch: e.pitch, velocity: e.velocity, startTime: (e.startBeat - from) * spb, durationSec: e.lengthBeats * spb });
        }
      }
      const d = samples(await ctx.startRendering());
      expect(d.every(Number.isFinite)).toBe(true);
      pk = Math.max(pk, peak(d));
      for (const v of d) { rmsSum += v * v; n++; }
    }
    console.log(`demo with effects: peak ${pk.toFixed(3)}  rms ${Math.sqrt(rmsSum / n).toFixed(3)}`);
    expect(pk).toBeGreaterThan(0.2);
    expect(pk).toBeLessThan(1);
  });
});

