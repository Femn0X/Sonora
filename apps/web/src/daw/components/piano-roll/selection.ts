import type { MidiNote } from "@sonora/schema";

/**
 * Pure logic for editing a GROUP of notes (multi-select move / resize / copy / paste / duplicate / marquee).
 * Kept free of React and Web Audio so the fiddly edge cases are directly unit-tested.
 *
 * The central rule: a group move is clamped as a whole (the delta is limited), never note by note, so
 * relative spacing and chords are preserved no matter how close to the clip edge the group is dragged.
 */

export const LOWEST_NOTE = 24; // C1
export const HIGHEST_NOTE = 95; // B6
const MIN_LENGTH = 0.0625; // 1/64 note

export interface NoteMove {
  id: string;
  startBeat: number;
  pitch: number;
}
export interface NoteResize {
  id: string;
  lengthBeats: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Move every note by (dBeat, dPitch), limiting the delta so ALL notes stay inside the clip and pitch range. */
export function moveGroup(notes: MidiNote[], dBeat: number, dPitch: number, editLength: number, minStep = MIN_LENGTH): NoteMove[] {
  if (notes.length === 0) return [];
  const minStart = Math.min(...notes.map((n) => n.startBeat));
  const maxStart = Math.max(...notes.map((n) => n.startBeat));
  const minPitch = Math.min(...notes.map((n) => n.pitch));
  const maxPitch = Math.max(...notes.map((n) => n.pitch));
  // every start must stay in [0, editLength - minStep]
  const beatLo = -minStart;
  const beatHi = Math.max(beatLo, editLength - minStep - maxStart);
  const pitchLo = LOWEST_NOTE - minPitch;
  const pitchHi = HIGHEST_NOTE - maxPitch;
  const db = Number.isFinite(dBeat) ? clamp(dBeat, beatLo, beatHi) : 0;
  const dp = Number.isFinite(dPitch) ? clamp(Math.round(dPitch), pitchLo, pitchHi) : 0;
  return notes.map((n) => ({ id: n.id, startBeat: n.startBeat + db, pitch: n.pitch + dp }));
}

/** Change every note's length by dLen, each limited to [minLen, space left before the end of the clip]. */
export function resizeGroup(notes: MidiNote[], dLen: number, editLength: number, minLen = MIN_LENGTH): NoteResize[] {
  const d = Number.isFinite(dLen) ? dLen : 0;
  return notes.map((n) => ({ id: n.id, lengthBeats: clamp(n.lengthBeats + d, minLen, Math.max(minLen, editLength - n.startBeat)) }));
}

// --- clipboard -----------------------------------------------------------------------------------

export interface ClipboardNote {
  pitch: number;
  /** Start relative to the earliest copied note, so the group pastes with its internal timing intact */
  relStart: number;
  lengthBeats: number;
  velocity: number;
}

export function toClipboard(notes: MidiNote[]): ClipboardNote[] {
  if (notes.length === 0) return [];
  const origin = Math.min(...notes.map((n) => n.startBeat));
  return notes.map((n) => ({ pitch: n.pitch, relStart: n.startBeat - origin, lengthBeats: n.lengthBeats, velocity: n.velocity }));
}

/** Notes (without ids) to add when pasting at `atBeat`. Notes that would start past the clip end are dropped; lengths are trimmed to fit. */
export function pasteNotes(clipboard: ClipboardNote[], atBeat: number, editLength: number): Omit<MidiNote, "id">[] {
  const out: Omit<MidiNote, "id">[] = [];
  for (const c of clipboard) {
    const startBeat = Math.max(0, atBeat) + c.relStart;
    if (!Number.isFinite(startBeat) || startBeat >= editLength) continue;
    if (c.pitch < LOWEST_NOTE || c.pitch > HIGHEST_NOTE) continue;
    out.push({ pitch: c.pitch, startBeat, lengthBeats: Math.min(c.lengthBeats, editLength - startBeat), velocity: c.velocity });
  }
  return out;
}

/** How far to shift a duplicate so it starts right after the original group: its span, rounded UP to the grid. */
export function duplicateShift(notes: MidiNote[], grid: number): number {
  if (notes.length === 0) return 0;
  const start = Math.min(...notes.map((n) => n.startBeat));
  const end = Math.max(...notes.map((n) => n.startBeat + n.lengthBeats));
  const span = Math.max(end - start, MIN_LENGTH);
  if (!(grid > 0)) return span;
  return Math.max(grid, Math.ceil(span / grid - 1e-9) * grid);
}

// --- marquee ---------------------------------------------------------------------------------------

export interface MarqueeRect {
  beatA: number;
  beatB: number;
  pitchA: number;
  pitchB: number;
}

/** Notes whose time span overlaps the rectangle and whose pitch lies within it (corners can be given in any order). */
export function notesInRect(notes: MidiNote[], rect: MarqueeRect): MidiNote[] {
  const b0 = Math.min(rect.beatA, rect.beatB), b1 = Math.max(rect.beatA, rect.beatB);
  const p0 = Math.min(rect.pitchA, rect.pitchB), p1 = Math.max(rect.pitchA, rect.pitchB);
  return notes.filter((n) => n.pitch >= p0 && n.pitch <= p1 && n.startBeat < b1 && n.startBeat + n.lengthBeats > b0);
}
