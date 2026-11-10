import { describe, it, expect } from "vitest";
import { samples } from "./helpers";
// @ts-expect-error untyped
import { OfflineAudioContext } from "node-web-audio-api";
import { createEffect, EFFECT_CATALOG } from "../src/daw/engine/effects/registry";
import { buildImpulse, REVERB_DESCRIPTOR } from "../src/daw/engine/effects/reverb";
import { sanitizeParams } from "../src/daw/engine/plugins/params";

const SR = 44100;
const sec = (s: number) => Math.round(s * SR);
type Src = (ctx: any) => AudioNode;

const sine = (hz: number, amp = 0.5): Src => (ctx) => {
  const o = ctx.createOscillator(); o.frequency.value = hz;
  const g = ctx.createGain(); g.gain.value = amp; o.connect(g); o.start(); return g;
};
const impulseAt = (t: number): Src => (ctx) => {
  const b = ctx.createBuffer(1, sec(t) + 2, SR); b.getChannelData(0)[sec(t)] = 1;
  const s = ctx.createBufferSource(); s.buffer = b; s.start(); return s;
};
const noise = (amp = 0.5, seed = 1): Src => (ctx) => {
  const b = ctx.createBuffer(1, SR * 10, SR); const d = b.getChannelData(0); let a = seed;
  for (let i = 0; i < d.length; i++) { a = (a * 1664525 + 1013904223) >>> 0; d[i] = ((a / 4294967296) * 2 - 1) * amp; }
  const s = ctx.createBufferSource(); s.buffer = b; s.start(); return s;
};

async function run(source: Src, pluginId: string | null, data: Record<string, unknown>, secs: number, opts: { bypass?: boolean } = {}) {
  const ctx = new OfflineAudioContext(2, sec(secs), SR);
  const src = source(ctx);
  if (!pluginId) { src.connect(ctx.destination); }
  else {
    const fx = createEffect(ctx as unknown as AudioContext, pluginId, data)!;
    if (opts.bypass) fx.setBypassed(true);
    src.connect(fx.input); fx.output.connect(ctx.destination);
  }
  return samples(await ctx.startRendering()); // copy now: see helpers.ts
}
const rms = (d: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / (b - a)); };
const peak = (d: Float32Array, a = 0, b = d.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(d[i])); return m; };
const argmax = (d: Float32Array, a: number, b: number) => { let m = 0, at = a; for (let i = a; i < b; i++) if (Math.abs(d[i]) > m) { m = Math.abs(d[i]); at = i; } return at; };
function goertzel(d: Float32Array, hz: number, a: number, b: number) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w); let s0 = 0, s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (b - a) * 2;
}
const db = (x: number) => 20 * Math.log10(x);
/** steady-state gain (dB) of an effect for a sine at `hz` */
async function gainDb(pluginId: string, data: Record<string, unknown>, hz: number) {
  const out = await run(sine(hz), pluginId, data, 1);
  const ref = await run(sine(hz), null, {}, 1);
  return db(rms(out, sec(0.3), sec(0.9)) / rms(ref, sec(0.3), sec(0.9)));
}

describe("EQ", () => {
  it("is transparent with every gain at 0 dB", async () => {
    for (const hz of [60, 440, 1000, 5000, 12000]) expect(Math.abs(await gainDb("sonora.eq", {}, hz)), `${hz}Hz`).toBeLessThan(0.3);
  });
  it("low shelf +12 dB boosts bass (~+12 dB at 40Hz) and leaves highs alone", async () => {
    const g = await gainDb("sonora.eq", { lowGain: 12 }, 40);
    expect(g).toBeGreaterThan(10); expect(g).toBeLessThan(13);
    expect(Math.abs(await gainDb("sonora.eq", { lowGain: 12 }, 5000))).toBeLessThan(0.5);
  });
  it("mid cut -12 dB at 1 kHz notches 1 kHz, not 100 Hz or 10 kHz", async () => {
    expect(await gainDb("sonora.eq", { midGain: -12, midFreq: 1000 }, 1000)).toBeLessThan(-11);
    expect(Math.abs(await gainDb("sonora.eq", { midGain: -12, midFreq: 1000 }, 100))).toBeLessThan(1.5);
    expect(Math.abs(await gainDb("sonora.eq", { midGain: -12, midFreq: 1000 }, 10000))).toBeLessThan(1.5);
  });
  it("high shelf -12 dB darkens 12 kHz (~-12 dB) but not 200 Hz", async () => {
    const g = await gainDb("sonora.eq", { highGain: -12 }, 14000);
    expect(g).toBeLessThan(-10); expect(g).toBeGreaterThan(-13);
    expect(Math.abs(await gainDb("sonora.eq", { highGain: -12 }, 200))).toBeLessThan(0.5);
  });
});

describe("Compressor", () => {
  it("narrows the loud/quiet ratio versus the dry signal", async () => {
    const stepped: Src = (ctx) => {
      const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, 0); g.gain.setValueAtTime(0.09, 1.5); o.connect(g); o.start(); return g;
    };
    const ratioOf = (d: Float32Array) => rms(d, sec(1.0), sec(1.4)) / rms(d, sec(2.2), sec(2.9));
    const dry = ratioOf(await run(stepped, null, {}, 3));
    const comp = ratioOf(await run(stepped, "sonora.compressor", { threshold: -30, ratio: 8, attackMs: 1, releaseMs: 50, knee: 6 }, 3));
    console.log(`compressor dynamic ratio  dry: ${dry.toFixed(2)}  compressed: ${comp.toFixed(2)}`);
    expect(dry).toBeGreaterThan(9);
    expect(comp).toBeLessThan(dry * 0.7);
    expect(comp).toBeGreaterThan(1); // still louder when loud; it compresses, not flattens
  });
  it("ratio 1:1 leaves dynamics essentially intact", async () => {
    const stepped: Src = (ctx) => {
      const o = ctx.createOscillator(); o.frequency.value = 440; const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, 0); g.gain.setValueAtTime(0.09, 1.5); o.connect(g); o.start(); return g;
    };
    const d = await run(stepped, "sonora.compressor", { ratio: 1, threshold: -30 }, 3);
    expect(rms(d, sec(1.0), sec(1.4)) / rms(d, sec(2.2), sec(2.9))).toBeGreaterThan(8);
  });
});

describe("Delay", () => {
  const p = { timeMs: 250, feedback: 0.5, mix: 0.5, tone: 16000 };
  it("echo lands at the set time, and each repeat's ENERGY falls by ~feedback^2", async () => {
    const d = await run(impulseAt(0.1), "sonora.delay", p, 1.4);
    const e1 = argmax(d, sec(0.3), sec(0.4)), e2 = argmax(d, sec(0.55), sec(0.65)), e3 = argmax(d, sec(0.8), sec(0.9));
    expect(Math.abs(e1 / SR - 0.35)).toBeLessThan(0.004);
    expect(Math.abs(e2 / SR - 0.6)).toBeLessThan(0.004);
    expect(Math.abs(e3 / SR - 0.85)).toBeLessThan(0.004);
    // Peak amplitude isn't conserved through the loop's lowpass, but energy is a principled measure.
    const energy = (c: number) => { let s = 0; for (let i = c - sec(0.015); i < c + sec(0.015); i++) s += d[i] * d[i]; return s; };
    const r21 = energy(e2) / energy(e1), r32 = energy(e3) / energy(e2);
    console.log(`delay echo energy ratios: ${r21.toFixed(3)} ${r32.toFixed(3)} (feedback^2 = 0.25)`);
    expect(r21).toBeGreaterThan(0.18); expect(r21).toBeLessThan(0.32);
    expect(r32).toBeGreaterThan(0.18); expect(r32).toBeLessThan(0.32);
  });
  it("feedback 0 gives exactly one echo; mix 0 gives none", async () => {
    const one = await run(impulseAt(0.1), "sonora.delay", { ...p, feedback: 0 }, 1.2);
    expect(peak(one, sec(0.55), sec(0.7))).toBeLessThan(peak(one, sec(0.3), sec(0.4)) * 0.05);
    const none = await run(impulseAt(0.1), "sonora.delay", { ...p, mix: 0 }, 1.2);
    expect(peak(none, sec(0.3), sec(1.2))).toBeLessThan(1e-4);
  });
  it("max feedback stays stable (finite, decaying) even with a long noise burst", async () => {
    const burst: Src = (ctx) => { const n = noise(0.5)(ctx); return n; };
    const d = await run(burst, "sonora.delay", { timeMs: 30, feedback: 5 /* clamped to 0.9 */, mix: 1, tone: 20000 }, 6);
    expect(d.every(Number.isFinite)).toBe(true);
    expect(peak(d)).toBeLessThan(10);
  });
});

describe("Reverb", () => {
  it("makes a decaying tail from an impulse; longer decay rings longer", async () => {
    const short = await run(impulseAt(0.05), "sonora.reverb", { decay: 0.3, mix: 1, preDelayMs: 0 }, 2.5);
    const long = await run(impulseAt(0.05), "sonora.reverb", { decay: 4, mix: 1, preDelayMs: 0 }, 2.5);
    const tail = (d: Float32Array) => rms(d, sec(1.0), sec(1.4));
    console.log(`reverb tail @1s  short(0.3s): ${tail(short).toExponential(2)}  long(4s): ${tail(long).toExponential(2)}`);
    expect(tail(long)).toBeGreaterThan(tail(short) * 10);
    expect(rms(long, sec(0.1), sec(0.3))).toBeGreaterThan(rms(long, sec(1.8), sec(2.2)) * 2); // decays
    expect(rms(long, sec(0.1), sec(0.3))).toBeGreaterThan(1e-3); // audible
  });
  it("pre-delay holds the wet signal back; mix 0 is dry only", async () => {
    const pd = await run(impulseAt(0.02), "sonora.reverb", { decay: 1.5, mix: 1, preDelayMs: 100 }, 1.5);
    expect(peak(pd, sec(0.03), sec(0.11))).toBeLessThan(peak(pd, sec(0.12), sec(0.4)) * 0.05);
    const dry = await run(impulseAt(0.02), "sonora.reverb", { decay: 1.5, mix: 0 }, 1.5);
    expect(peak(dry, sec(0.1), sec(1.5))).toBeLessThan(1e-4);
  });
  it("is deterministic: identical output on every render, and the impulse is seeded", async () => {
    const a = await run(impulseAt(0.05), "sonora.reverb", { decay: 2 }, 2);
    const b = await run(impulseAt(0.05), "sonora.reverb", { decay: 2 }, 2);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const ctx = new OfflineAudioContext(2, 100, SR);
    expect(Buffer.from(samples(buildImpulse(ctx, 1), 0).buffer).equals(Buffer.from(samples(buildImpulse(ctx, 1), 0).buffer))).toBe(true);
  });
  it("hostile decay values are clamped by the descriptor, so a corrupt project can't request a giant impulse response", () => {
    const decay = (v: unknown) => sanitizeParams(REVERB_DESCRIPTOR.params, { decay: v }).decay;
    expect(decay(1e12)).toBe(8);
    expect(decay(-5)).toBe(0.2);
    expect(decay(NaN)).toBe(2);
    expect(decay("long")).toBe(2);
    expect(decay(Infinity)).toBe(2);
  });
  it("impulse reaches about -60 dB at the decay time and left/right are decorrelated", () => {
    const ctx = new OfflineAudioContext(2, 100, SR);
    const ir = buildImpulse(ctx, 2);
    const L = samples(ir, 0), R = samples(ir, 1);
    const early = rms(L, sec(0.01), sec(0.06)), late = rms(L, sec(1.9), sec(1.99));
    expect(db(late / early)).toBeLessThan(-50);
    let same = 0; for (let i = 0; i < 5000; i++) if (L[i] === R[i]) same++;
    expect(same).toBeLessThan(50);
  });
});

describe("Distortion", () => {
  const harm = (d: Float32Array) => goertzel(d, 1320, sec(0.3), sec(0.9)) / goertzel(d, 440, sec(0.3), sec(0.9));
  it("adds odd harmonics that grow with drive, and stays bounded", async () => {
    const lo = harm(await run(sine(440, 0.5), "sonora.distortion", { drive: 1, tone: 20000 }, 1));
    const hi = harm(await run(sine(440, 0.5), "sonora.distortion", { drive: 20, tone: 20000 }, 1));
    console.log(`3rd/fundamental  drive 1: ${lo.toFixed(4)}  drive 20: ${hi.toFixed(4)}`);
    expect(hi).toBeGreaterThan(lo * 5);
    expect(hi).toBeGreaterThan(0.05);
    const out = await run(sine(440, 1), "sonora.distortion", { drive: 40, level: 6 }, 1);
    expect(peak(out)).toBeLessThan(2);
  });
  it("tone lowpass tames the added harmonics; mix 0 is transparent", async () => {
    const bright = harm(await run(sine(440, 0.5), "sonora.distortion", { drive: 20, tone: 20000 }, 1));
    const dark = harm(await run(sine(440, 0.5), "sonora.distortion", { drive: 20, tone: 500 }, 1));
    expect(dark).toBeLessThan(bright * 0.5);
    expect(Math.abs(await gainDb("sonora.distortion", { mix: 0, drive: 30 }, 440))).toBeLessThan(0.3);
  });
});

describe("every effect", () => {
  const aggressive: Record<string, Record<string, unknown>> = {
    "sonora.eq": { lowGain: 18, midGain: 18, highGain: 18 },
    "sonora.compressor": { threshold: -60, ratio: 20, makeup: 24 },
    "sonora.delay": { feedback: 0.9, mix: 1 },
    "sonora.reverb": { decay: 8, mix: 1 },
    "sonora.distortion": { drive: 40, level: 6 },
  };
  for (const { descriptor } of EFFECT_CATALOG) {
    const id = descriptor.pluginId;
    it(`${descriptor.displayName}: bypass is bit-transparent even with extreme settings`, async () => {
      const dry = await run(noise(0.3), null, {}, 1.5);
      const byp = await run(noise(0.3), id, aggressive[id], 1.5, { bypass: true });
      let maxDiff = 0; for (let i = sec(0.1); i < dry.length; i++) maxDiff = Math.max(maxDiff, Math.abs(dry[i] - byp[i]));
      expect(maxDiff).toBeLessThan(1e-3);
    });
    it(`${descriptor.displayName}: garbage params can't produce NaN, silence-by-NaN, or runaway levels`, async () => {
      const junk: Record<string, unknown> = {};
      for (const p of descriptor.params) junk[p.key] = [NaN, 1e12, -1e12, "x", null, Infinity][descriptor.params.indexOf(p) % 6];
      const d = await run(noise(0.5), id, junk, 3);
      expect(d.every(Number.isFinite)).toBe(true);
      expect(peak(d)).toBeLessThan(20);
    });
    it(`${descriptor.displayName}: extreme-but-valid settings stay finite and bounded`, async () => {
      const d = await run(noise(0.5), id, aggressive[id], 4);
      expect(d.every(Number.isFinite)).toBe(true);
      expect(peak(d)).toBeLessThan(30);
    });
    it(`${descriptor.displayName}: dispose is idempotent`, () => {
      const ctx = new OfflineAudioContext(2, 100, SR);
      const fx = createEffect(ctx as unknown as AudioContext, id, {})!;
      fx.dispose(); expect(() => fx.dispose()).not.toThrow();
    });
  }
  it("unknown plugin ids return null instead of throwing", () => {
    const ctx = new OfflineAudioContext(2, 100, SR);
    expect(createEffect(ctx as unknown as AudioContext, "vendor.mystery", {})).toBeNull();
  });
});
