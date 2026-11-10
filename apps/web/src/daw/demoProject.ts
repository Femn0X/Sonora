import { createBlankManifest, type MidiClip, type MidiNote, type ProjectManifest } from "@sonora/schema";
import { TRACK_TEMPLATES, makeInstrumentRef } from "./engine/instruments/registry";
import { makeInsert } from "./engine/effects/registry";

/**
 * In-memory demo shown when a project can't be loaded from the API. It is a
 * short A-minor groove (drums + bass + pad) so the workspace makes sound the
 * moment it opens, and so every part of the new engine (drum roll, piano roll,
 * pattern looping, hi-hat choke) is immediately explorable.
 */

const AUTHOR = "demo-user";
const tpl = (key: string) => TRACK_TEMPLATES.find((t) => t.key === key)!;

let noteSeq = 0;
const note = (pitch: number, startBeat: number, lengthBeats: number, velocity = 100): MidiNote => ({
  id: `demo-n${++noteSeq}`,
  pitch,
  startBeat,
  lengthBeats,
  velocity,
});

function drumBar(): MidiNote[] {
  const KICK = 36, SNARE = 38, CLAP = 39, CHAT = 42, OHAT = 46;
  const notes: MidiNote[] = [];
  for (let beat = 0; beat < 4; beat++) notes.push(note(KICK, beat, 0.25, beat === 0 ? 120 : 105));
  notes.push(note(SNARE, 1, 0.25, 110), note(SNARE, 3, 0.25, 110), note(CLAP, 3.75, 0.25, 55));
  for (let beat = 0; beat < 4; beat++) {
    notes.push(note(CHAT, beat + 0.5, 0.25, 90));
    if (beat !== 3) notes.push(note(CHAT, beat, 0.25, 62));
  }
  notes.push(note(OHAT, 3.5, 0.25, 85)); // replaces the closed hat on the last 8th; the next bar's closed hat chokes it
  return notes;
}

function bassLine(): MidiNote[] {
  const roots = [45, 41, 48, 43]; // Am - F - C - G
  return roots.flatMap((r, bar) => {
    const o = bar * 4;
    return [note(r, o, 0.75, 110), note(r, o + 1, 0.5, 95), note(r + 12, o + 1.5, 0.5, 100), note(r, o + 2, 0.75, 105), note(r + 7, o + 3, 0.5, 95), note(r + 12, o + 3.5, 0.5, 90)];
  });
}

function padChords(): MidiNote[] {
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [50, 55, 59]];
  return chords.flatMap((chord, bar) => chord.map((p) => note(p, bar * 4, 3.9, 80)));
}

export function createDemoManifest(projectId: string): ProjectManifest {
  const demo = createBlankManifest({ projectId, title: "Summer Nights (Demo — not saved)", authorId: AUTHOR, bpm: 124 });
  demo.keySignature = "A minor";

  demo.instruments = [
    makeInstrumentRef("i1", tpl("drums")),
    makeInstrumentRef("i2", tpl("bass")),
    makeInstrumentRef("i3", tpl("pad")),
  ];
  demo.tracks = [
    { id: "t1", name: "Drums", type: "midi", color: "#e08a3e", orderIndex: 0, authorId: AUTHOR, instrumentId: "i1" },
    { id: "t2", name: "Bass", type: "midi", color: "#5b8def", orderIndex: 1, authorId: AUTHOR, instrumentId: "i2" },
    { id: "t3", name: "Keys", type: "midi", color: "#3ec7c7", orderIndex: 2, authorId: AUTHOR, instrumentId: "i3" },
    { id: "t4", name: "Vocal Sample", type: "audio", color: "#3ecf8e", orderIndex: 3, authorId: AUTHOR },
  ];
  demo.mixer.strips = demo.tracks.map((t) => ({
    trackId: t.id, volumeDb: 0, pan: 0, muted: false, soloed: false, inserts: [], sends: [],
  }));

  // Show the effects chain off: a lush reverb on the pad and a touch of saturation on the bass.
  const withSettings = (id: string, pluginId: string, settings: Record<string, unknown>) => {
    const insert = makeInsert(id, pluginId)!;
    return { ...insert, presetData: { ...insert.presetData, ...settings } };
  };
  const strip = (trackId: string) => demo.mixer.strips.find((x) => x.trackId === trackId)!;
  strip("t3").inserts = [withSettings("fx-reverb", "sonora.reverb", { decay: 2.8, mix: 0.3, preDelayMs: 25 })];
  strip("t2").inserts = [withSettings("fx-sat", "sonora.distortion", { drive: 2.5, mix: 0.3, tone: 3500 })];

  const base = { type: "midi" as const, authorId: AUTHOR, createdAt: new Date().toISOString() };
  const clips: MidiClip[] = [
    // One-bar pattern that repeats across 4 bars (stretch the clip to extend it)
    { ...base, id: "c1", trackId: "t1", instrumentId: "i1", startBeat: 0, lengthBeats: 16, loop: { enabled: true, lengthBeats: 4 }, notes: drumBar() },
    { ...base, id: "c2", trackId: "t2", instrumentId: "i2", startBeat: 0, lengthBeats: 16, notes: bassLine() },
    { ...base, id: "c3", trackId: "t3", instrumentId: "i3", startBeat: 0, lengthBeats: 16, notes: padChords() },
  ];
  demo.clips = clips;
  return demo;
}
