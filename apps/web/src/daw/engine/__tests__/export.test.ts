import { describe, it, expect } from "vitest";
import { createBlankManifest, type ProjectManifest } from "@sonora/schema";
import { encodeWav, estimateTailSeconds, projectEndBeat, exportFileName, bounceProject, ExportError, MAX_EXPORT_SECONDS } from "../export";
import { makeInsert } from "../effects/registry";

const blank = (): ProjectManifest => createBlankManifest({ projectId: "p", title: "t", authorId: "u" });
const clip = (start: number, len: number) => ({ id: `c${start}`, type: "midi" as const, trackId: "t", startBeat: start, lengthBeats: len, notes: [], instrumentId: "i", authorId: "a", createdAt: "" });
const pcm = (channels: Float32Array[], sampleRate = 44100) => ({ numberOfChannels: channels.length, length: channels[0].length, sampleRate, getChannelData: (c: number) => channels[c] });
const bytesOf = async (blob: Blob) => new DataView(await blob.arrayBuffer());
const text = (v: DataView, o: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));

describe("encodeWav", () => {
  it("writes a spec-correct 16-bit stereo PCM header", async () => {
    const v = await bytesOf(encodeWav(pcm([new Float32Array(100), new Float32Array(100)], 48000)));
    expect(text(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 100 * 2 * 2);
    expect(text(v, 8, 8)).toBe("WAVEfmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // channels
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 4); // byte rate
    expect(v.getUint16(32, true)).toBe(4); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(v, 36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(400);
    expect(v.byteLength).toBe(44 + 400);
  });

  it("interleaves channels and round-trips samples within one LSB", async () => {
    const L = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
    const R = Float32Array.from([0.1, -0.1, 0.9, -0.9, 0, 0.75]);
    const v = await bytesOf(encodeWav(pcm([L, R])));
    for (let i = 0; i < L.length; i++) {
      expect(Math.abs(v.getInt16(44 + i * 4, true) / 32767 - L[i])).toBeLessThanOrEqual(1 / 32767);
      expect(Math.abs(v.getInt16(46 + i * 4, true) / 32767 - R[i])).toBeLessThanOrEqual(1 / 32767);
    }
  });

  it("clamps out-of-range samples (no wrap-around distortion) and zeroes NaN/Infinity", async () => {
    const v = await bytesOf(encodeWav(pcm([Float32Array.from([5, -5, NaN, Infinity, -Infinity]), new Float32Array(5)])));
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32767);
    expect(v.getInt16(52, true)).toBe(0);
    expect(v.getInt16(56, true)).toBe(0);
    expect(v.getInt16(60, true)).toBe(0);
  });

  it("24-bit: correct header, sign handling and precision", async () => {
    const v = await bytesOf(encodeWav(pcm([Float32Array.from([0.5, -0.5, 1, -1])]), 24));
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint16(32, true)).toBe(3);
    expect(v.getUint32(40, true)).toBe(12);
    const s24 = (i: number) => { const o = 44 + i * 3; let x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16); if (x & 0x800000) x -= 0x1000000; return x; };
    expect(Math.abs(s24(0) - 0.5 * 8388607)).toBeLessThanOrEqual(1); // within 1 LSB
    expect(Math.abs(s24(1) + 0.5 * 8388607)).toBeLessThanOrEqual(1);
    expect(s24(2)).toBe(8388607);
    expect(s24(3)).toBe(-8388607);
  });

  it("handles mono and empty buffers", async () => {
    expect((await bytesOf(encodeWav(pcm([new Float32Array(10)])))).getUint16(22, true)).toBe(1);
    expect((await bytesOf(encodeWav(pcm([new Float32Array(0)])))).byteLength).toBe(44);
  });
});

describe("projectEndBeat / estimateTailSeconds", () => {
  it("end is the last clip end; corrupt clips are ignored", () => {
    const m = blank();
    m.clips = [clip(0, 4), clip(8, 8), clip(NaN, 4), clip(2, Infinity), clip(0, -3)] as never;
    expect(projectEndBeat(m)).toBe(16);
    expect(projectEndBeat(blank())).toBe(0);
  });

  it("tail grows with reverb decay and delay feedback, ignores bypassed effects, and is capped", () => {
    const m = blank();
    const base = estimateTailSeconds(m);
    expect(base).toBeGreaterThanOrEqual(0.5);
    const verb = { ...makeInsert("r", "sonora.reverb")!, presetData: { decay: 5, preDelayMs: 100 } };
    m.mixer.masterInserts = [verb];
    expect(estimateTailSeconds(m)).toBeCloseTo(5.1, 5);
    m.mixer.masterInserts = [{ ...verb, bypassed: true }];
    expect(estimateTailSeconds(m)).toBe(base);
    const dly = { ...makeInsert("d", "sonora.delay")!, presetData: { timeMs: 500, feedback: 0.5 } };
    m.mixer.masterInserts = [dly];
    expect(estimateTailSeconds(m)).toBeGreaterThan(5); // ~10 repeats * 0.5s
    m.mixer.masterInserts = [{ ...dly, presetData: { timeMs: 2000, feedback: 0.9 } }];
    expect(estimateTailSeconds(m)).toBe(12); // capped
    m.mixer.masterInserts = [{ ...dly, presetData: { timeMs: NaN, feedback: "x" } }];
    expect(Number.isFinite(estimateTailSeconds(m))).toBe(true);
  });
});

describe("exportFileName", () => {
  it("makes safe, readable filenames", () => {
    expect(exportFileName("Summer Nights (Demo — not saved)")).toBe("summer-nights-demo-not-saved.wav");
    expect(exportFileName("../../etc/passwd")).toBe("etcpasswd.wav");
    expect(exportFileName("  Café Müller!!  ")).toBe("cafe-muller.wav");
    expect(exportFileName("")).toBe("sonora-project.wav");
    expect(exportFileName("日本語")).toBe("sonora-project.wav");
    expect(exportFileName("a".repeat(500)).length).toBeLessThanOrEqual(64);
    expect(exportFileName('con<>:"/\\|?*.exe')).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe("bounceProject refusals (no audio needed)", () => {
  const Never = class { constructor() { throw new Error("should not be constructed"); } } as never;

  it("an empty project gives a friendly error, before touching the audio system", async () => {
    await expect(bounceProject(blank(), {}, Never)).rejects.toThrow(ExportError);
    await expect(bounceProject(blank(), {}, Never)).rejects.toThrow(/add a clip/i);
  });

  it("a project that would be absurdly long is refused instead of allocating gigabytes", async () => {
    const m = blank();
    m.clips = [clip(0, 1e12)] as never;
    await expect(bounceProject(m, {}, Never)).rejects.toThrow(/limited to 30 minutes/);
    m.bpm = 1e-9; // tiny tempo is clamped, so it's still bounded by the same limit
    await expect(bounceProject(m, {}, Never)).rejects.toThrow(ExportError);
    expect(MAX_EXPORT_SECONDS).toBe(1800);
  });

  it("a missing OfflineAudioContext gives a clear error", async () => {
    const m = blank();
    m.clips = [clip(0, 4)] as never;
    await expect(bounceProject(m, {}, undefined as never)).rejects.toThrow(/offline/i);
  });
});
