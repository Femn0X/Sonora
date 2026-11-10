import type { ProjectManifest, Clip, MidiClip, MidiNote, Track, InstrumentRef, EffectInsert } from "@sonora/schema";

/** `target` for insert commands: a track id, or this reserved value for the master bus. */
export const MASTER_TARGET = "master";

/**
 * Editor Commands — the layer between "user did something in the UI" and
 * "manifest state changed."
 *
 * Why this exists (see PRODUCT SPEC §12 — collaboration architecture):
 * every mutation the DAW makes is expressed as one of these small, plain,
 * serializable objects instead of an arbitrary imperative function call.
 * That buys us three things without building collaboration itself yet:
 *
 *   1. Undo/redo — for free, by keeping inverse commands (see history.ts).
 *   2. A future WebSocket/CRDT layer can broadcast `EditorCommand` objects
 *      verbatim; the apply function becomes the CRDT operation handler.
 *      We are NOT building that now (per spec §24), but this is the seam
 *      where it plugs in later without touching UI call sites again.
 *   3. Every mutation is auditable/loggable in one place (`applyCommand`)
 *      instead of scattered across store methods — useful for autosave
 *      diffing and for future change-history/comment-on-change features.
 *
 * Rule: UI components never mutate `manifest` directly. They call
 * `dispatch(command)` on the store. The store's ONLY job is to run
 * `applyCommand` and persist the result.
 */

export type EditorCommand =
  | { type: "ADD_TRACK"; track: Track }
  | { type: "DELETE_TRACK"; trackId: string }
  | { type: "ADD_MIDI_CLIP"; clip: Clip }
  | { type: "MOVE_CLIP"; clipId: string; newStartBeat: number; newTrackId?: string }
  | { type: "RESIZE_CLIP"; clipId: string; newLengthBeats: number }
  | { type: "DELETE_CLIP"; clipId: string }
  | { type: "ADD_MIDI_NOTE"; clipId: string; note: MidiNote }
  | { type: "MOVE_MIDI_NOTE"; clipId: string; noteId: string; newStartBeat: number; newPitch: number }
  | { type: "RESIZE_MIDI_NOTE"; clipId: string; noteId: string; newLengthBeats: number }
  | { type: "DELETE_MIDI_NOTE"; clipId: string; noteId: string }
  | { type: "SET_NOTE_VELOCITY"; clipId: string; noteId: string; velocity: number }
  | { type: "CHANGE_TRACK_VOLUME"; trackId: string; volumeDb: number }
  | { type: "CHANGE_TRACK_PAN"; trackId: string; pan: number }
  | { type: "SET_TRACK_MUTE"; trackId: string; muted: boolean }
  | { type: "SET_TRACK_SOLO"; trackId: string; soloed: boolean }
  | { type: "CHANGE_TEMPO"; bpm: number }
  | { type: "ADD_INSTRUMENT"; instrument: InstrumentRef }
  | { type: "DELETE_INSTRUMENT"; instrumentId: string }
  | { type: "SET_CLIP_LOOP"; clipId: string; loop: MidiClip["loop"] }
  | { type: "CHANGE_MASTER_VOLUME"; volumeDb: number }
  /** Replaces an instrument's whole preset (so undo restores it exactly, including removed keys). */
  | { type: "SET_INSTRUMENT_PRESET"; instrumentId: string; presetData: Record<string, unknown> }
  | { type: "ADD_INSERT"; target: string; insert: EffectInsert; index?: number }
  | { type: "REMOVE_INSERT"; target: string; insertId: string }
  | { type: "MOVE_INSERT"; target: string; insertId: string; newIndex: number }
  | { type: "SET_INSERT_BYPASS"; target: string; insertId: string; bypassed: boolean }
  /** Replaces an effect's whole preset (same reasoning as SET_INSTRUMENT_PRESET) */
  | { type: "SET_INSERT_PRESET"; target: string; insertId: string; presetData: Record<string, unknown> }
  /** Several commands applied as ONE undo step (e.g. add instrument + track). */
  | { type: "BATCH"; commands: EditorCommand[] };

/**
 * Pure function: (state, command) -> new state. No side effects, no
 * network calls — this makes it trivially unit-testable (see
 * apps/web/src/daw/state/__tests__/commands.test.ts) and safe to eventually
 * run identically on a server-side CRDT peer or in a Web Worker.
 */
/** Read the insert list for a track strip or the master bus. */
function insertsOf(manifest: ProjectManifest, target: string): EffectInsert[] | undefined {
  if (target === MASTER_TARGET) return manifest.mixer.masterInserts;
  return manifest.mixer.strips.find((s) => s.trackId === target)?.inserts;
}

/** Return a manifest with the insert list for `target` replaced. Unknown targets leave the manifest unchanged. */
function withInserts(manifest: ProjectManifest, target: string, inserts: EffectInsert[]): ProjectManifest {
  if (target === MASTER_TARGET) return { ...manifest, mixer: { ...manifest.mixer, masterInserts: inserts } };
  if (!manifest.mixer.strips.some((s) => s.trackId === target)) return manifest;
  return {
    ...manifest,
    mixer: { ...manifest.mixer, strips: manifest.mixer.strips.map((s) => (s.trackId === target ? { ...s, inserts } : s)) },
  };
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(length, Math.round(index)));

export function applyCommand(manifest: ProjectManifest, command: EditorCommand): ProjectManifest {
  switch (command.type) {
    case "ADD_TRACK": {
      const hasStrip = manifest.mixer.strips.some((s) => s.trackId === command.track.id);
      return {
        ...manifest,
        tracks: [...manifest.tracks, command.track],
        mixer: hasStrip
          ? manifest.mixer
          : {
              ...manifest.mixer,
              strips: [
                ...manifest.mixer.strips,
                { trackId: command.track.id, volumeDb: 0, pan: 0, muted: false, soloed: false, inserts: [], sends: [] },
              ],
            },
      };
    }

    case "ADD_INSTRUMENT":
      return { ...manifest, instruments: [...manifest.instruments, command.instrument] };

    case "DELETE_INSTRUMENT":
      return { ...manifest, instruments: manifest.instruments.filter((i) => i.id !== command.instrumentId) };

    case "SET_CLIP_LOOP":
      return {
        ...manifest,
        clips: manifest.clips.map((c) => (c.id === command.clipId && c.type === "midi" ? { ...c, loop: command.loop } : c)),
      };

    case "BATCH":
      return command.commands.reduce(applyCommand, manifest);
    case "CHANGE_MASTER_VOLUME":
      if (!Number.isFinite(command.volumeDb)) return manifest;
      return { ...manifest, mixer: { ...manifest.mixer, masterVolumeDb: Math.max(-80, Math.min(12, command.volumeDb)) } };

    case "SET_INSTRUMENT_PRESET":
      return {
        ...manifest,
        instruments: manifest.instruments.map((i) => (i.id === command.instrumentId ? { ...i, presetData: command.presetData } : i)),
      };

    case "ADD_INSERT": {
      const list = insertsOf(manifest, command.target);
      if (!list || list.some((i) => i.id === command.insert.id)) return manifest; // unknown target, or already there
      const at = clampIndex(command.index ?? list.length, list.length);
      return withInserts(manifest, command.target, [...list.slice(0, at), command.insert, ...list.slice(at)]);
    }

    case "REMOVE_INSERT": {
      const list = insertsOf(manifest, command.target);
      if (!list) return manifest;
      return withInserts(manifest, command.target, list.filter((i) => i.id !== command.insertId));
    }

    case "MOVE_INSERT": {
      const list = insertsOf(manifest, command.target);
      const from = list?.findIndex((i) => i.id === command.insertId) ?? -1;
      if (!list || from === -1) return manifest;
      const rest = list.filter((i) => i.id !== command.insertId);
      const to = clampIndex(command.newIndex, rest.length);
      return withInserts(manifest, command.target, [...rest.slice(0, to), list[from], ...rest.slice(to)]);
    }

    case "SET_INSERT_BYPASS": {
      const list = insertsOf(manifest, command.target);
      if (!list) return manifest;
      return withInserts(manifest, command.target, list.map((i) => (i.id === command.insertId ? { ...i, bypassed: command.bypassed } : i)));
    }

    case "SET_INSERT_PRESET": {
      const list = insertsOf(manifest, command.target);
      if (!list) return manifest;
      return withInserts(manifest, command.target, list.map((i) => (i.id === command.insertId ? { ...i, presetData: command.presetData } : i)));
    }


    case "DELETE_TRACK":
      return {
        ...manifest,
        tracks: manifest.tracks.filter((t) => t.id !== command.trackId),
        clips: manifest.clips.filter((c) => c.trackId !== command.trackId),
        mixer: { ...manifest.mixer, strips: manifest.mixer.strips.filter((s) => s.trackId !== command.trackId) },
      };

    case "ADD_MIDI_CLIP":
      return { ...manifest, clips: [...manifest.clips, command.clip] };

    case "MOVE_CLIP":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId
            ? { ...c, startBeat: command.newStartBeat, trackId: command.newTrackId ?? c.trackId }
            : c
        ),
      };

    case "RESIZE_CLIP":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId ? { ...c, lengthBeats: Math.max(0.25, command.newLengthBeats) } : c
        ),
      };

    case "DELETE_CLIP":
      return { ...manifest, clips: manifest.clips.filter((c) => c.id !== command.clipId) };

    case "ADD_MIDI_NOTE":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId && c.type === "midi" ? { ...c, notes: [...c.notes, command.note] } : c
        ),
      };

    case "MOVE_MIDI_NOTE":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId && c.type === "midi"
            ? {
                ...c,
                notes: c.notes.map((n) =>
                  n.id === command.noteId ? { ...n, startBeat: command.newStartBeat, pitch: command.newPitch } : n
                ),
              }
            : c
        ),
      };

    case "RESIZE_MIDI_NOTE":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId && c.type === "midi"
            ? {
                ...c,
                notes: c.notes.map((n) =>
                  n.id === command.noteId ? { ...n, lengthBeats: Math.max(0.0625, command.newLengthBeats) } : n
                ),
              }
            : c
        ),
      };

    case "DELETE_MIDI_NOTE":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId && c.type === "midi"
            ? { ...c, notes: c.notes.filter((n) => n.id !== command.noteId) }
            : c
        ),
      };

    case "SET_NOTE_VELOCITY":
      return {
        ...manifest,
        clips: manifest.clips.map((c) =>
          c.id === command.clipId && c.type === "midi"
            ? {
                ...c,
                notes: c.notes.map((n) =>
                  n.id === command.noteId ? { ...n, velocity: Math.max(1, Math.min(127, command.velocity)) } : n
                ),
              }
            : c
        ),
      };

    case "CHANGE_TRACK_VOLUME":
      return {
        ...manifest,
        mixer: {
          ...manifest.mixer,
          strips: manifest.mixer.strips.map((s) =>
            s.trackId === command.trackId ? { ...s, volumeDb: command.volumeDb } : s
          ),
        },
      };

    case "CHANGE_TRACK_PAN":
      return {
        ...manifest,
        mixer: {
          ...manifest.mixer,
          strips: manifest.mixer.strips.map((s) => (s.trackId === command.trackId ? { ...s, pan: command.pan } : s)),
        },
      };

    case "SET_TRACK_MUTE":
      return {
        ...manifest,
        mixer: {
          ...manifest.mixer,
          strips: manifest.mixer.strips.map((s) =>
            s.trackId === command.trackId ? { ...s, muted: command.muted } : s
          ),
        },
      };

    case "SET_TRACK_SOLO":
      return {
        ...manifest,
        mixer: {
          ...manifest.mixer,
          strips: manifest.mixer.strips.map((s) =>
            s.trackId === command.trackId ? { ...s, soloed: command.soloed } : s
          ),
        },
      };

    case "CHANGE_TEMPO":
      return { ...manifest, bpm: command.bpm };

    default: {
      const _exhaustive: never = command;
      return manifest;
    }
  }
}

/**
 * Produces the inverse of a command given the manifest state *before* it was
 * applied — used by history.ts to implement undo without keeping full
 * manifest snapshots per step (cheap for a long editing session).
 */
export function invertCommand(before: ProjectManifest, command: EditorCommand): EditorCommand | null {
  switch (command.type) {
    case "ADD_TRACK":
      return { type: "DELETE_TRACK", trackId: command.track.id };
    case "ADD_MIDI_CLIP":
      return { type: "DELETE_CLIP", clipId: command.clip.id };
    case "ADD_MIDI_NOTE":
      return { type: "DELETE_MIDI_NOTE", clipId: command.clipId, noteId: command.note.id };
    case "MOVE_CLIP": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      if (!clip) return null;
      return { type: "MOVE_CLIP", clipId: command.clipId, newStartBeat: clip.startBeat, newTrackId: clip.trackId };
    }
    case "RESIZE_CLIP": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      if (!clip) return null;
      return { type: "RESIZE_CLIP", clipId: command.clipId, newLengthBeats: clip.lengthBeats };
    }
    case "MOVE_MIDI_NOTE": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      if (!clip || clip.type !== "midi") return null;
      const note = clip.notes.find((n) => n.id === command.noteId);
      if (!note) return null;
      return {
        type: "MOVE_MIDI_NOTE",
        clipId: command.clipId,
        noteId: command.noteId,
        newStartBeat: note.startBeat,
        newPitch: note.pitch,
      };
    }
    case "CHANGE_TRACK_VOLUME": {
      const strip = before.mixer.strips.find((s) => s.trackId === command.trackId);
      if (!strip) return null;
      return { type: "CHANGE_TRACK_VOLUME", trackId: command.trackId, volumeDb: strip.volumeDb };
    }
    case "CHANGE_TRACK_PAN": {
      const strip = before.mixer.strips.find((s) => s.trackId === command.trackId);
      if (!strip) return null;
      return { type: "CHANGE_TRACK_PAN", trackId: command.trackId, pan: strip.pan };
    }
    case "CHANGE_TEMPO":
      return { type: "CHANGE_TEMPO", bpm: before.bpm };
    case "ADD_INSTRUMENT":
      return { type: "DELETE_INSTRUMENT", instrumentId: command.instrument.id };
    case "DELETE_CLIP": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      return clip ? { type: "ADD_MIDI_CLIP", clip } : null;
    }
    case "DELETE_MIDI_NOTE": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      const note = clip && clip.type === "midi" ? clip.notes.find((n) => n.id === command.noteId) : undefined;
      return note ? { type: "ADD_MIDI_NOTE", clipId: command.clipId, note } : null;
    }
    case "RESIZE_MIDI_NOTE": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      const note = clip && clip.type === "midi" ? clip.notes.find((n) => n.id === command.noteId) : undefined;
      return note ? { type: "RESIZE_MIDI_NOTE", clipId: command.clipId, noteId: command.noteId, newLengthBeats: note.lengthBeats } : null;
    }
    case "SET_NOTE_VELOCITY": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      const note = clip && clip.type === "midi" ? clip.notes.find((n) => n.id === command.noteId) : undefined;
      return note ? { type: "SET_NOTE_VELOCITY", clipId: command.clipId, noteId: command.noteId, velocity: note.velocity } : null;
    }
    case "SET_TRACK_MUTE": {
      const strip = before.mixer.strips.find((s) => s.trackId === command.trackId);
      return strip ? { type: "SET_TRACK_MUTE", trackId: command.trackId, muted: strip.muted } : null;
    }
    case "SET_TRACK_SOLO": {
      const strip = before.mixer.strips.find((s) => s.trackId === command.trackId);
      return strip ? { type: "SET_TRACK_SOLO", trackId: command.trackId, soloed: strip.soloed } : null;
    }
    case "SET_CLIP_LOOP": {
      const clip = before.clips.find((c) => c.id === command.clipId);
      return clip && clip.type === "midi" ? { type: "SET_CLIP_LOOP", clipId: command.clipId, loop: clip.loop } : null;
    }
    case "CHANGE_MASTER_VOLUME":
      return { type: "CHANGE_MASTER_VOLUME", volumeDb: before.mixer.masterVolumeDb };
    case "SET_INSTRUMENT_PRESET": {
      const inst = before.instruments.find((i) => i.id === command.instrumentId);
      return inst ? { type: "SET_INSTRUMENT_PRESET", instrumentId: command.instrumentId, presetData: inst.presetData } : null;
    }
    case "ADD_INSERT": {
      const list = insertsOf(before, command.target);
      if (!list || list.some((i) => i.id === command.insert.id)) return null; // apply was a no-op: nothing to undo
      return { type: "REMOVE_INSERT", target: command.target, insertId: command.insert.id };
    }
    case "REMOVE_INSERT": {
      const list = insertsOf(before, command.target);
      const index = list?.findIndex((i) => i.id === command.insertId) ?? -1;
      return list && index !== -1 ? { type: "ADD_INSERT", target: command.target, insert: list[index], index } : null;
    }
    case "MOVE_INSERT": {
      const list = insertsOf(before, command.target);
      const index = list?.findIndex((i) => i.id === command.insertId) ?? -1;
      return index !== -1 ? { type: "MOVE_INSERT", target: command.target, insertId: command.insertId, newIndex: index } : null;
    }
    case "SET_INSERT_BYPASS": {
      const insert = insertsOf(before, command.target)?.find((i) => i.id === command.insertId);
      return insert ? { type: "SET_INSERT_BYPASS", target: command.target, insertId: command.insertId, bypassed: insert.bypassed } : null;
    }
    case "SET_INSERT_PRESET": {
      const insert = insertsOf(before, command.target)?.find((i) => i.id === command.insertId);
      return insert ? { type: "SET_INSERT_PRESET", target: command.target, insertId: command.insertId, presetData: insert.presetData } : null;
    }
    case "BATCH": {
      // Invert each step against the state it was applied to, then reverse the order.
      // If ANY step can't be inverted, the whole batch is not undoable (a partial
      // undo would leave the project in a state the user never saw).
      const inverses: EditorCommand[] = [];
      let state = before;
      for (const c of command.commands) {
        const inv = invertCommand(state, c);
        if (!inv) return null;
        inverses.unshift(inv);
        state = applyCommand(state, c);
      }
      return { type: "BATCH", commands: inverses };
    }
    // Deletions and toggles: simple enough that we don't bother inverting
    // for MVP undo (would need to store the deleted object) — deferred,
    // not silently broken: dropping these from undo is a known, documented gap.
    default:
      return null;
  }
}
