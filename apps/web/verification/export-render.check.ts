import { describe, it, expect } from "vitest";
import { samples } from "./helpers";
// @ts-expect-error untyped
import * as NodeAudio from "node-web-audio-api";
import type { ProjectManifest } from "@sonora/schema";
import { bounceProject, encodeWav, estimateTailSeconds, projectEndBeat } from "../src/daw/engine/export";
import { createDemoManifest } from "../src/daw/demoProject";

const Offline = NodeAudio.OfflineAudioContext;
const bounce = (m: ProjectManifest, o = {}) => bounceProject(m, o, Offline);
// Always a COPY (see helpers.ts): the rendered buffer is often dropped right after, e.g. ch(await bounce(...))
const ch = (b: AudioBuffer, c = 0) => samples(b, c);
const peak = (d: Float32Array, a: number, b: number) => { let m = 0; for (let i = Math.max(0, a); i < Math.min(d.length, b); i++) m = Math.max(m, Math.abs(d[i])); return m; };
const rms = (d: Float32Array, a: number, b: number) => { let s = 0, n = 0; for (let i = Math.max(0, a); i < Math.min(d.length, b); i++) { s += d[i] * d[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
const mutate = (m: ProjectManifest, f: (s: ProjectManifest["mixer"]["strips"][number]) => Partial<ProjectManifest["mixer"]["strips"][number]>, ids: string[]) => ({
  ...m, mixer: { ...m.mixer, strips: m.mixer.strips.map((s) => (ids.includes(s.trackId) ? { ...s, ...f(s) } : s)) },
});

const demo = () => createDemoManifest("x");
const SPB = 60 / demo().bpm;

describe("bounceProject: the demo song, through the real engine", () => {
  it("has the right length, is stereo, finite, non-silent in every bar, and under 0 dBFS", async () => {
    const m = demo();
    const buf = await bounce(m);
    const songSec = projectEndBeat(m) * SPB;
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.sampleRate).toBe(44100);
    expect(buf.length).toBe(Math.ceil((songSec + estimateTailSeconds(m)) * 44100));
    const L = ch(buf), R = ch(buf, 1);
    expect(L.every(Number.isFinite) && R.every(Number.isFinite)).toBe(true);
    for (let bar = 0; bar < 4; bar++) expect(rms(L, Math.round(bar * 4 * SPB * 44100), Math.round((bar + 1) * 4 * SPB * 44100))).toBeGreaterThan(0.02);
    const pk = Math.max(peak(L, 0, L.length), peak(R, 0, R.length));
    console.log(`bounced demo: ${(buf.length / 44100).toFixed(2)}s, peak ${pk.toFixed(3)}`);
    expect(pk).toBeLessThan(1);
    expect(pk).toBeGreaterThan(0.3);
  });

  it("is BIT-IDENTICAL across renders (everything audible is seeded)", async () => {
    const a = await bounce(demo()), b = await bounce(demo());
    expect(Buffer.from(ch(a).buffer).equals(Buffer.from(ch(b).buffer))).toBe(true);
    expect(Buffer.from(ch(a, 1).buffer).equals(Buffer.from(ch(b, 1).buffer))).toBe(true);
  });

  it("solo is honoured: drums only, with a kick landing exactly on every beat of all 4 bars", async () => {
    const buf = await bounce(mutate(demo(), () => ({ soloed: true }), ["t1"]));
    const d = ch(buf);
    for (let beat = 0; beat < 16; beat++) {
      const t = Math.round(beat * SPB * 44100);
      expect(peak(d, t, t + 2205), `kick at beat ${beat}`).toBeGreaterThan(0.15);
      // ...and not EARLY: the 20ms before the kick (after the previous hit has died away) is quiet
      if (beat % 4 === 0 && beat > 0) expect(peak(d, t - 1500, t - 44)).toBeLessThan(peak(d, t, t + 2205) * 0.6);
    }
  });

  it("the very first note isn't faded: kick on beat 1 is as loud as the same kick on bar 2", async () => {
    const d = ch(await bounce(mutate(demo(), () => ({ soloed: true }), ["t1"])));
    const first = peak(d, 0, 2205), bar2 = peak(d, Math.round(4 * SPB * 44100), Math.round(4 * SPB * 44100) + 2205);
    console.log(`first kick ${first.toFixed(3)}  bar-2 kick ${bar2.toFixed(3)}`);
    expect(first / bar2).toBeGreaterThan(0.9);
    expect(first / bar2).toBeLessThan(1.1);
  });

  it("mute is honoured from sample 0: muting every track renders pure silence (no 10ms leak at the start)", async () => {
    const buf = await bounce(mutate(demo(), () => ({ muted: true }), ["t1", "t2", "t3", "t4"]));
    expect(peak(ch(buf), 0, ch(buf).length)).toBeLessThan(1e-6);
  });

  it("a muted track really is absent: muting drums removes the kick transient but keeps the bass", async () => {
    const full = ch(await bounce(demo())), noDrums = ch(await bounce(mutate(demo(), () => ({ muted: true }), ["t1"])));
    const t = Math.round(1 * SPB * 44100); // beat 2: kick + snare in drums, a bass note
    expect(peak(noDrums, t, t + 2205)).toBeLessThan(peak(full, t, t + 2205) * 0.7);
    expect(rms(noDrums, 0, 44100)).toBeGreaterThan(0.01);
  });

  it("effect tails ring out past the last clip instead of being chopped, then decay to silence", async () => {
    const m = demo();
    const d = ch(await bounce(m));
    const end = Math.round(projectEndBeat(m) * SPB * 44100);
    expect(rms(d, end + 4410, end + 44100)).toBeGreaterThan(0.001); // reverb + pad release still audible
    expect(rms(d, d.length - 2205, d.length)).toBeLessThan(rms(d, end + 4410, end + 44100)); // and fading
  });

  it("tailSeconds: 0 ends exactly at the last clip", async () => {
    const m = demo();
    const buf = await bounce(m, { tailSeconds: 0 });
    expect(buf.length).toBe(Math.ceil(projectEndBeat(m) * SPB * 44100));
  });

  it("honours the sample rate and keeps the timing right", async () => {
    const buf = await bounce(mutate(demo(), () => ({ soloed: true }), ["t1"]), { sampleRate: 48000 });
    expect(buf.sampleRate).toBe(48000);
    const d = ch(buf);
    const t = Math.round(2 * SPB * 48000);
    expect(peak(d, t, t + 2400)).toBeGreaterThan(0.15);
  });

  it("encodes to a WAV whose size matches and whose samples match the render", async () => {
    const buf = await bounce(demo(), { tailSeconds: 0.5 });
    const wav = encodeWav(buf);
    expect(wav.size).toBe(44 + buf.length * 2 * 2);
    const v = new DataView(await wav.arrayBuffer());
    const i = Math.round(1.5 * 44100);
    expect(Math.abs(v.getInt16(44 + i * 4, true) / 32767 - ch(buf)[i])).toBeLessThan(2 / 32767);
    expect(Math.abs(v.getInt16(46 + i * 4, true) / 32767 - ch(buf, 1)[i])).toBeLessThan(2 / 32767);
  });

  it("export of hostile project data still succeeds, finite and bounded", async () => {
    const m = demo();
    const bass = m.clips.find((c) => c.id === "c2") as any;
    const hostile: ProjectManifest = {
      ...m, bpm: 1e9, timeSignature: [0, 4] as any,
      mixer: { ...m.mixer, masterVolumeDb: 1e9, strips: m.mixer.strips.map((s) => ({ ...s, volumeDb: 1e9, pan: 1e9 })) },
      clips: m.clips.map((c) => (c.id === "c2" ? { ...bass, notes: [{ id: "x", pitch: NaN, startBeat: NaN, lengthBeats: 1, velocity: 100 }, ...bass.notes] } : c)),
    };
    const buf = await bounce(hostile);
    expect(ch(buf).every(Number.isFinite)).toBe(true);
    expect(peak(ch(buf), 0, buf.length)).toBeLessThan(2);
  });

  it("every drum hit of a dense 4-bar groove survives when the whole song is scheduled at once (voice cap fix)", async () => {
    // 84 drum events > the 48-voice cap. Counting not-yet-sounding voices used to kill the early ones.
    const d = ch(await bounce(mutate(demo(), () => ({ soloed: true }), ["t1"])));
    let hits = 0;
    for (let beat = 0; beat < 16; beat++) if (peak(d, Math.round(beat * SPB * 44100), Math.round(beat * SPB * 44100) + 2205) > 0.15) hits++;
    expect(hits).toBe(16);
  });
});
