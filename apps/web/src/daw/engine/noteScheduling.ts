import type { MidiClip } from "@sonora/schema";

/**
 * Pure note-window logic (no Web Audio) so it can be unit-tested.
 *
 * The transport hands the engine consecutive half-open beat windows
 * [from, to). Every note occurrence must fire in exactly one window: never
 * twice, never skipped. That holds because each occurrence's absolute beat is
 * a deterministic function of (clip, note, repetition), and windows share
 * exact boundary values.
 */

export interface NoteEvent {
  noteId: string;
  pitch: number;
  velocity: number;
  /** Absolute position on the timeline, in beats */
  startBeat: number;
  /** Length in beats, already truncated to the clip / loop-repetition end */
  lengthBeats: number;
}

/** Length of the repeating pattern, or null if the clip doesn't loop. */
export function clipPatternLength(clip: MidiClip): number | null {
  const len = clip.loop?.lengthBeats;
  return clip.loop?.enabled && typeof len === "number" && Number.isFinite(len) && len > 0 ? len : null;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

export function collectNoteEvents(clip: MidiClip, from: number, to: number): NoteEvent[] {
  // Project JSON is untrusted (forks/remixes/corruption). Non-finite numbers must be skipped here:
  // NaN slips through every comparison below and would reach Web Audio, which throws on it.
  if (!finite(clip.startBeat, clip.lengthBeats, from, to) || clip.lengthBeats <= 0) return [];
  const clipEnd = clip.startBeat + clip.lengthBeats;
  if (clipEnd <= from || clip.startBeat >= to) return [];

  const pattern = clipPatternLength(clip);
  const events: NoteEvent[] = [];

  for (const note of clip.notes) {
    if (note.muted) continue;
    if (!finite(note.startBeat, note.lengthBeats, note.pitch, note.velocity) || note.lengthBeats <= 0 || note.startBeat < 0) continue;

    if (pattern === null) {
      const abs = clip.startBeat + note.startBeat;
      if (abs < from || abs >= to || abs >= clipEnd) continue;
      events.push({
        noteId: note.id,
        pitch: note.pitch,
        velocity: note.velocity,
        startBeat: abs,
        lengthBeats: Math.min(note.lengthBeats, clipEnd - abs),
      });
      continue;
    }

    if (note.startBeat >= pattern) continue; // note lies outside the loop body
    // Start one repetition early so float error in the division can never skip an occurrence.
    const firstRep = Math.max(0, Math.floor((from - clip.startBeat - note.startBeat) / pattern) - 1);
    for (let rep = firstRep; ; rep++) {
      const abs = clip.startBeat + rep * pattern + note.startBeat;
      if (abs >= to || abs >= clipEnd) break;
      if (abs < from) continue;
      const repEnd = clip.startBeat + (rep + 1) * pattern;
      events.push({
        noteId: note.id,
        pitch: note.pitch,
        velocity: note.velocity,
        startBeat: abs,
        lengthBeats: Math.min(note.lengthBeats, Math.min(clipEnd, repEnd) - abs),
      });
    }
  }
  return events;
}
