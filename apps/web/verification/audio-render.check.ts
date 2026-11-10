import { describe, it, expect } from "vitest";
import { samples } from "./helpers";
// @ts-expect-error untyped
import { OfflineAudioContext } from "node-web-audio-api";
import { createDemoManifest } from "../src/daw/demoProject";
import { collectNoteEvents } from "../src/daw/engine/noteScheduling";
import { createInstrument } from "../src/daw/engine/instruments/registry";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SYNTH_PRESETS } from "../src/daw/engine/instruments/synth";

const SR = 44100;
const mk = (secs: number) => new OfflineAudioContext(2, Math.ceil(SR * secs), SR);
const asCtx = (c: unknown) => c as AudioContext;

async function renderNotes(pluginId: string, preset: Record<string, unknown>, notes: { pitch: number; t: number; dur: number; vel?: number }[], secs: number) {
  const ctx = mk(secs);
  const inst = createInstrument(asCtx(ctx), pluginId, preset)!;
  for (const n of notes) inst.trigger({ destination: ctx.destination, pitch: n.pitch, velocity: n.vel ?? 100, startTime: n.t, durationSec: n.dur });
  const buf = await ctx.startRendering();
  return samples(buf); // copy now: see helpers.ts
}

const peak = (d: Float32Array, a = 0, b = d.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(d[i])); return m; };
const rms = (d: Float32Array, a = 0, b = d.length) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const sec = (s: number) => Math.round(s * SR);
function goertzel(d: Float32Array, hz: number, a: number, b: number) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (b - a);
}
/** Fraction of energy above ~4 kHz, via first-difference (a crude highpass) */
function highRatio(d: Float32Array, a: number, b: number) {
  let hi = 0, tot = 0;
  for (let i = a + 1; i < b; i++) { const diff = d[i] - d[i - 1]; hi += diff * diff; tot += d[i] * d[i] * 4; }
  return hi / Math.max(tot, 1e-12);
}

describe("synth", () => {
  const sine = { wave1: "sine", wave2: "sine", osc2DetuneCents: 0, oscMix: 0.5, cutoffHz: 18000, filterEnvOctaves: 0, attack: 0.005, sustain: 1, release: 0.05, level: 0.5 };

  it("plays the requested pitch (A4 = 440 Hz, not a neighbour)", async () => {
    const d = await renderNotes("sonora.synth", sine, [{ pitch: 69, t: 0, dur: 0.8 }], 1);
    const a = sec(0.1), b = sec(0.7);
    const p440 = goertzel(d, 440, a, b);
    expect(p440).toBeGreaterThan(goertzel(d, 466.16, a, b) * 50); // A#4
    expect(p440).toBeGreaterThan(goertzel(d, 415.3, a, b) * 50); //  G#4
  });

  it("note-off releases: silent after duration + release, audible during", async () => {
    const d = await renderNotes("sonora.synth", sine, [{ pitch: 60, t: 0.1, dur: 0.3 }], 1.5);
    expect(rms(d, sec(0.2), sec(0.35))).toBeGreaterThan(0.05);
    expect(peak(d, sec(0.7), sec(1.5))).toBeLessThan(0.002);
  });

  it("louder velocity is louder, soft is not silent", async () => {
    const soft = peak(await renderNotes("sonora.synth", sine, [{ pitch: 60, t: 0, dur: 0.3, vel: 30 }], 0.6));
    const loud = peak(await renderNotes("sonora.synth", sine, [{ pitch: 60, t: 0, dur: 0.3, vel: 127 }], 0.6));
    expect(loud).toBeGreaterThan(soft * 3);
    expect(soft).toBeGreaterThan(0.005);
  });

  it("a note shorter than its attack still sounds and ends cleanly (envelope-ordering guard)", async () => {
    const d = await renderNotes("sonora.synth", { ...sine, attack: 0.3, release: 0.1 }, [{ pitch: 60, t: 0, dur: 0.05 }], 1.2);
    expect(peak(d, 0, sec(0.5))).toBeGreaterThan(0.01);
    expect(peak(d, sec(0.9), sec(1.2))).toBeLessThan(0.002);
  });

  it("garbage preset data from a forked project can't produce NaN/silence/explosions", async () => {
    const d = await renderNotes("sonora.synth", { wave1: "banana", cutoffHz: -5, resonance: 9999, attack: "x", level: 99 }, [{ pitch: 48, t: 0, dur: 0.3 }], 0.8);
    expect(d.every(Number.isFinite)).toBe(true);
    expect(peak(d)).toBeLessThan(2);
    expect(peak(d)).toBeGreaterThan(0);
  });
});

describe("synth presets: long held chords stay bounded (regression: envelope blow-up on notes held >1s)", () => {
  for (const key of ["lead", "bass", "pad", "pluck"]) {
    it(`${key}: 3-note chord held 3.9s`, async () => {
      const preset = SYNTH_PRESETS[key].preset as Record<string, unknown>;
      const d = await renderNotes("sonora.synth", preset, [57, 60, 64].map((pitch) => ({ pitch, t: 0, dur: 3.9 })), 6);
      expect(d.every(Number.isFinite)).toBe(true);
      expect(peak(d), "headroom").toBeLessThan(1);
      expect(peak(d, sec(0.5), sec(3.5)), "sustains audibly").toBeGreaterThan(key === "pluck" ? 0 : 0.02);
      expect(peak(d, sec(5.5), sec(6)), "ends silent").toBeLessThan(0.001);
    });
  }
});

describe("drum kit", () => {
  const hit = (pitch: number, secs = 1) => renderNotes("sonora.drums", {}, [{ pitch, t: 0.01, dur: 0.1 }], secs);

  it("every pad makes sound and stays finite", async () => {
    for (const pitch of [36, 37, 38, 39, 42, 45, 46, 49]) {
      const d = await hit(pitch, 2.2);
      expect(d.every(Number.isFinite), `pitch ${pitch}`).toBe(true);
      expect(peak(d), `pitch ${pitch} audible`).toBeGreaterThan(0.05);
      expect(peak(d), `pitch ${pitch} no clip`).toBeLessThan(1.5);
    }
  });

  it("kick is low-frequency, hat is high-frequency", async () => {
    const kick = await hit(36);
    const hat = await hit(42);
    const k = highRatio(kick, sec(0.02), sec(0.4)), h = highRatio(hat, sec(0.01), sec(0.1));
    console.log("high-frequency ratio  kick:", k.toFixed(3), " hat:", h.toFixed(3));
    expect(k).toBeLessThan(0.05);
    expect(h).toBeGreaterThan(0.25);
    expect(h).toBeGreaterThan(k * 10);
  });

  it("closed hat is shorter than open hat; crash rings longest", async () => {
    const tail = (d: Float32Array) => rms(d, sec(0.25), sec(0.45));
    const c = tail(await hit(42)), o = tail(await hit(46)), cr = rms(await hit(49, 2), sec(1.0), sec(1.4));
    expect(o).toBeGreaterThan(c * 5);
    expect(cr).toBeGreaterThan(0.001);
  });

  it("closed hat chokes a ringing open hat", async () => {
    const withoutChoke = await renderNotes("sonora.drums", {}, [{ pitch: 46, t: 0.01, dur: 0.1 }], 1);
    const withChoke = await renderNotes("sonora.drums", {}, [{ pitch: 46, t: 0.01, dur: 0.1 }, { pitch: 42, t: 0.12, dur: 0.05, vel: 1 }], 1);
    const a = sec(0.25), b = sec(0.5);
    expect(rms(withChoke, a, b)).toBeLessThan(rms(withoutChoke, a, b) * 0.2);
  });

  it("ignores pitches that aren't drum pads (like an empty rack slot)", async () => {
    expect(peak(await hit(61))).toBe(0);
  });
});

describe("demo song, rendered through the same scheduling code the engine uses", () => {
  it("renders 4 bars: audible, finite, within headroom, and the looped drum pattern lands on the beat", async () => {
    const m = createDemoManifest("x");
    const bpm = m.bpm, spb = 60 / bpm, beats = 16;
    const total = beats * spb + 2;

    // Like the real engine, schedule one window at a time (a bar here) rather than the whole
    // song at once: the engine only ever has ~100ms of notes queued, so rendering per-bar is
    // the faithful simulation (and avoids tripping the per-instrument voice cap artificially).
    async function stem(trackFilter?: string) {
      const out = new Float32Array(Math.ceil(total * SR));
      for (let bar = 0; bar < 4; bar++) {
        const from = bar * 4, to = from + 4;
        const ctx = mk(4 * spb + 2);
        const insts = new Map(m.instruments.map((r) => [r.id, createInstrument(asCtx(ctx), r.pluginId, r.presetData)!]));
        for (const clip of m.clips) {
          if (clip.type !== "midi" || (trackFilter && clip.trackId !== trackFilter)) continue;
          const inst = insts.get(m.tracks.find((t) => t.id === clip.trackId)!.instrumentId!)!;
          for (const e of collectNoteEvents(clip, from, to)) {
            inst.trigger({ destination: ctx.destination, pitch: e.pitch, velocity: e.velocity, startTime: (e.startBeat - from) * spb, durationSec: e.lengthBeats * spb });
          }
        }
        const part = samples(await ctx.startRendering());
        const offset = sec(from * spb);
        for (let i = 0; i < part.length && offset + i < out.length; i++) out[offset + i] += part[i];
      }
      return out;
    }

    const mix = await stem();
    expect(mix.every(Number.isFinite)).toBe(true);
    const pk = peak(mix);
    console.log("full mix peak:", pk.toFixed(3), "rms:", rms(mix).toFixed(3));
    expect(pk).toBeGreaterThan(0.2);
    expect(pk, "pre-limiter headroom (must stay under 0 dBFS)").toBeLessThan(1);
    // every bar has sound
    for (let bar = 0; bar < 4; bar++) expect(rms(mix, sec(bar * 4 * spb), sec((bar + 1) * 4 * spb))).toBeGreaterThan(0.02);

    // drums only: a kick transient at the start of every beat, in all 4 repeated bars
    const drums = await stem("t1");
    for (let beat = 0; beat < 16; beat++) {
      const t0 = beat * spb;
      expect(peak(drums, sec(t0), sec(t0 + 0.05)), `kick at beat ${beat}`).toBeGreaterThan(0.15);
    }
    // ...and silence just before beat 0 of bar 2 doesn't contain a spurious early hit
    writeFileSync(join(tmpdir(), "sonora-demo.wav"), toWav(mix, SR));
  });
});

function toWav(d: Float32Array, sr: number) {
  const buf = Buffer.alloc(44 + d.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + d.length * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(d.length * 2, 40);
  for (let i = 0; i < d.length; i++) buf.writeInt16LE(Math.max(-1, Math.min(1, d[i])) * 32767, 44 + i * 2);
  return buf;
}
