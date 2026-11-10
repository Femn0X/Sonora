import { create } from "zustand";
import type { ProjectManifest, MidiNote, MidiClip } from "@sonora/schema";
import { randomUUID } from "../../lib/uuid";
import { applyCommand, invertCommand, MASTER_TARGET, type EditorCommand } from "./commands";
import { CommandHistory } from "./history";
import { makeInstrumentRef, isDrumInstrument, type TrackTemplate } from "../engine/instruments/registry";
import { makeInsert } from "../engine/effects/registry";
import type { NoteMove, NoteResize } from "../components/piano-roll/selection";

/**
 * Single source of truth for the currently-open project's editable state.
 *
 * REFACTOR NOTE (see commands.ts for full rationale): every mutation now
 * goes through `dispatch(command)` -> `applyCommand`, instead of being
 * hand-written inline per method as in the previous version of this file.
 * The public method names below (addMidiClip, moveClip, etc.) are kept
 * IDENTICAL so existing callers (ArrangementView, RemixButton, the DAW page)
 * did not need to change -- they are now thin wrappers that build a command
 * and dispatch it. This is a pure internal refactor, not a behavior change.
 *
 * Phase-2 note: this store's shape mirrors what will become a Yjs Y.Doc.
 * When collaboration is added, `dispatch` is the exact seam where a command
 * additionally gets broadcast over the wire and applied by remote peers.
 */

const history = new CommandHistory();
/** While non-null, dispatched commands accumulate here and become ONE undo step (see beginGesture). */
let gestureInverses: (EditorCommand | null)[] | null = null;

interface ProjectStoreState {
  manifest: ProjectManifest | null;
  selectedClipId: string | null;
  activePianoRollClipId: string | null;
  playheadBeat: number;
  isPlaying: boolean;
  /** Clip currently looping in pattern mode, if any */
  previewClipId: string | null;
  zoomPxPerBeat: number;
  isDirty: boolean;

  loadManifest: (manifest: ProjectManifest) => void;
  setPlaying: (playing: boolean) => void;
  setPreviewClipId: (clipId: string | null) => void;
  setPlayheadBeat: (beat: number) => void;
  selectClip: (clipId: string | null) => void;
  setZoom: (pxPerBeat: number) => void;
  openPianoRoll: (clipId: string) => void;
  closePianoRoll: () => void;

  /** The one true mutation entry point. All other mutation helpers below call this. */
  dispatch: (command: EditorCommand) => void;
  undo: () => void;
  redo: () => void;
  /** Group everything dispatched until endGesture() into a single undo step (e.g. one note drag). */
  beginGesture: () => void;
  endGesture: () => void;

  // Convenience wrappers (kept for call-site compatibility with existing UI code)
  addMidiClip: (trackId: string, startBeat: number, lengthBeats: number, authorId: string) => string;
  moveClip: (clipId: string, newStartBeat: number, newTrackId?: string) => void;
  resizeClip: (clipId: string, newLengthBeats: number) => void;
  addNoteToClip: (clipId: string, note: Omit<MidiNote, "id">) => void;
  updateNote: (clipId: string, noteId: string, patch: Partial<MidiNote>) => void;
  deleteNote: (clipId: string, noteId: string) => void;
  setTrackVolume: (trackId: string, volumeDb: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  setTrackMute: (trackId: string, muted: boolean) => void;
  setTrackSolo: (trackId: string, soloed: boolean) => void;
  setTempo: (bpm: number) => void;

  /** Creates instrument + track + mixer strip as one undoable step. Returns the new track id. */
  addTrackFromTemplate: (template: TrackTemplate, authorId: string) => string;
  /** Creates a clip with instrument-appropriate defaults (1-bar looping pattern for drums, 2 bars otherwise). */
  createClipOnTrack: (trackId: string, startBeat: number) => string | null;
  deleteClip: (clipId: string) => void;
  /** Copy a clip (with fresh note ids) to the first free slot after it on the same track. Returns the new clip id. */
  duplicateClip: (clipId: string) => string | null;

  // --- group note editing (each call is ONE undo step; inside a gesture they join it) -------------------
  /** Add several notes at once. Returns the new ids in the same order. */
  addNotes: (clipId: string, notes: Omit<MidiNote, "id">[]) => string[];
  deleteNotes: (clipId: string, noteIds: string[]) => void;
  moveNotes: (clipId: string, moves: NoteMove[]) => void;
  resizeNotes: (clipId: string, resizes: NoteResize[]) => void;

  // --- mixer / effects / instrument settings --------------------------------------------------
  /** `target` is a track id, or "master". Returns the new insert's id (null if the plugin id is unknown). */
  addInsert: (target: string, pluginId: string) => string | null;
  removeInsert: (target: string, insertId: string) => void;
  /** Move an insert up (-1) or down (+1) the chain */
  moveInsert: (target: string, insertId: string, delta: number) => void;
  setInsertBypass: (target: string, insertId: string, bypassed: boolean) => void;
  setInsertParam: (target: string, insertId: string, key: string, value: number | string) => void;
  setInstrumentParam: (instrumentId: string, key: string, value: number | string) => void;
  setMasterVolume: (volumeDb: number) => void;
  setClipLoop: (clipId: string, loop: MidiClip["loop"]) => void;
  /** Snaps every note start in a clip to the grid (one undo step). */
  quantizeClip: (clipId: string, gridBeats: number) => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  manifest: null,
  selectedClipId: null,
  activePianoRollClipId: null,
  playheadBeat: 0,
  isPlaying: false,
  previewClipId: null,
  zoomPxPerBeat: 24,
  isDirty: false,

  loadManifest: (manifest) => set({ manifest, isDirty: false }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPreviewClipId: (clipId) => set({ previewClipId: clipId }),
  setPlayheadBeat: (beat) => set({ playheadBeat: beat }),
  selectClip: (clipId) => set({ selectedClipId: clipId }),
  setZoom: (pxPerBeat) => set({ zoomPxPerBeat: Math.max(4, Math.min(200, pxPerBeat)) }),
  openPianoRoll: (clipId) => set({ activePianoRollClipId: clipId, selectedClipId: clipId }),
  closePianoRoll: () => set({ activePianoRollClipId: null }),

  dispatch: (command) => {
    const before = get().manifest;
    if (!before) return;
    const after = applyCommand(before, command);
    // applyCommand returns the SAME manifest object when a command changes nothing (invalid value,
    // unknown target, duplicate id…). Recording that would leave a phantom undo step that does nothing.
    if (after === before) return;
    const inverse = invertCommand(before, command);
    if (gestureInverses) gestureInverses.push(inverse);
    else history.push(inverse);
    set({ manifest: { ...after, updatedAt: new Date().toISOString() }, isDirty: true });
  },

  undo: () => {
    const command = history.popUndo();
    const before = get().manifest;
    if (!command || !before) return;
    const redoInverse = invertCommand(before, command);
    set({ manifest: applyCommand(before, command), isDirty: true });
    history.pushRedo(redoInverse);
  },

  redo: () => {
    const command = history.popRedo();
    const before = get().manifest;
    if (!command || !before) return;
    const undoInverse = invertCommand(before, command);
    set({ manifest: applyCommand(before, command), isDirty: true });
    history.pushUndoKeepRedo(undoInverse);
  },

  beginGesture: () => {
    if (!gestureInverses) gestureInverses = [];
  },

  endGesture: () => {
    const collected = gestureInverses;
    gestureInverses = null;
    if (!collected) return;
    const inverses = collected.filter((c): c is EditorCommand => c !== null);
    if (inverses.length === 0) return;
    // Undo must apply the newest inverse first, so reverse the order.
    history.push(inverses.length === 1 ? inverses[0] : { type: "BATCH", commands: inverses.reverse() });
  },

  addMidiClip: (trackId, startBeat, lengthBeats, authorId) => {
    const id = randomUUID();
    const manifest = get().manifest;
    const instrumentId = manifest?.tracks.find((t) => t.id === trackId)?.instrumentId ?? "";
    get().dispatch({
      type: "ADD_MIDI_CLIP",
      clip: {
        id,
        type: "midi",
        trackId,
        startBeat,
        lengthBeats,
        notes: [],
        instrumentId,
        authorId,
        createdAt: new Date().toISOString(),
      },
    });
    return id;
  },

  moveClip: (clipId, newStartBeat, newTrackId) =>
    get().dispatch({ type: "MOVE_CLIP", clipId, newStartBeat, newTrackId }),

  resizeClip: (clipId, newLengthBeats) => get().dispatch({ type: "RESIZE_CLIP", clipId, newLengthBeats }),

  addNoteToClip: (clipId, note) =>
    get().dispatch({ type: "ADD_MIDI_NOTE", clipId, note: { ...note, id: randomUUID() } }),

  updateNote: (clipId, noteId, patch) => {
    if (patch.startBeat !== undefined || patch.pitch !== undefined) {
      const manifest = get().manifest;
      const clip = manifest?.clips.find((c) => c.id === clipId);
      const note = clip && clip.type === "midi" ? clip.notes.find((n) => n.id === noteId) : undefined;
      if (note) {
        get().dispatch({
          type: "MOVE_MIDI_NOTE",
          clipId,
          noteId,
          newStartBeat: patch.startBeat ?? note.startBeat,
          newPitch: patch.pitch ?? note.pitch,
        });
      }
    }
    if (patch.lengthBeats !== undefined) {
      get().dispatch({ type: "RESIZE_MIDI_NOTE", clipId, noteId, newLengthBeats: patch.lengthBeats });
    }
    if (patch.velocity !== undefined) {
      get().dispatch({ type: "SET_NOTE_VELOCITY", clipId, noteId, velocity: patch.velocity });
    }
  },

  deleteNote: (clipId, noteId) => get().dispatch({ type: "DELETE_MIDI_NOTE", clipId, noteId }),

  setTrackVolume: (trackId, volumeDb) => get().dispatch({ type: "CHANGE_TRACK_VOLUME", trackId, volumeDb }),
  setTrackPan: (trackId, pan) => get().dispatch({ type: "CHANGE_TRACK_PAN", trackId, pan }),
  setTrackMute: (trackId, muted) => get().dispatch({ type: "SET_TRACK_MUTE", trackId, muted }),
  setTrackSolo: (trackId, soloed) => get().dispatch({ type: "SET_TRACK_SOLO", trackId, soloed }),
  setTempo: (bpm) => get().dispatch({ type: "CHANGE_TEMPO", bpm }),

  addTrackFromTemplate: (template, authorId) => {
    const manifest = get().manifest;
    const trackId = randomUUID();
    const instrumentId = randomUUID();
    get().dispatch({
      type: "BATCH",
      commands: [
        { type: "ADD_INSTRUMENT", instrument: makeInstrumentRef(instrumentId, template) },
        {
          type: "ADD_TRACK",
          track: {
            id: trackId,
            name: template.trackName,
            type: "midi",
            color: template.color,
            orderIndex: manifest?.tracks.length ?? 0,
            authorId,
            instrumentId,
          },
        },
      ],
    });
    return trackId;
  },

  createClipOnTrack: (trackId, startBeat) => {
    const manifest = get().manifest;
    const track = manifest?.tracks.find((t) => t.id === trackId);
    if (!manifest || !track || track.type === "audio") return null;
    const bar = manifest.timeSignature[0] ?? 4;
    const drums = isDrumInstrument(manifest.instruments.find((i) => i.id === track.instrumentId));
    const lengthBeats = drums ? bar : bar * 2;
    const id = randomUUID();
    get().dispatch({
      type: "ADD_MIDI_CLIP",
      clip: {
        id,
        type: "midi",
        trackId,
        startBeat,
        lengthBeats,
        notes: [],
        instrumentId: track.instrumentId ?? "",
        // Drum patterns repeat when the clip is stretched, like FL Studio patterns.
        loop: drums ? { enabled: true, lengthBeats } : undefined,
        authorId: track.authorId,
        createdAt: new Date().toISOString(),
      },
    });
    return id;
  },

  addInsert: (target, pluginId) => {
    const insert = makeInsert(randomUUID(), pluginId);
    if (!insert) return null;
    get().dispatch({ type: "ADD_INSERT", target, insert });
    return insert.id;
  },

  removeInsert: (target, insertId) => get().dispatch({ type: "REMOVE_INSERT", target, insertId }),

  moveInsert: (target, insertId, delta) => {
    const list = target === MASTER_TARGET ? get().manifest?.mixer.masterInserts : get().manifest?.mixer.strips.find((s) => s.trackId === target)?.inserts;
    const index = list?.findIndex((i) => i.id === insertId) ?? -1;
    if (!list || index === -1) return;
    const newIndex = Math.max(0, Math.min(list.length - 1, index + delta));
    if (newIndex !== index) get().dispatch({ type: "MOVE_INSERT", target, insertId, newIndex });
  },

  setInsertBypass: (target, insertId, bypassed) => get().dispatch({ type: "SET_INSERT_BYPASS", target, insertId, bypassed }),

  setInsertParam: (target, insertId, key, value) => {
    const list = target === MASTER_TARGET ? get().manifest?.mixer.masterInserts : get().manifest?.mixer.strips.find((s) => s.trackId === target)?.inserts;
    const insert = list?.find((i) => i.id === insertId);
    if (!insert || insert.presetData[key] === value) return; // no-op drags shouldn't flood the undo history
    get().dispatch({ type: "SET_INSERT_PRESET", target, insertId, presetData: { ...insert.presetData, [key]: value } });
  },

  setInstrumentParam: (instrumentId, key, value) => {
    const inst = get().manifest?.instruments.find((i) => i.id === instrumentId);
    if (!inst || inst.presetData[key] === value) return;
    get().dispatch({ type: "SET_INSTRUMENT_PRESET", instrumentId, presetData: { ...inst.presetData, [key]: value } });
  },

  setMasterVolume: (volumeDb) => get().dispatch({ type: "CHANGE_MASTER_VOLUME", volumeDb }),

  duplicateClip: (clipId) => {
    const manifest = get().manifest;
    const clip = manifest?.clips.find((c) => c.id === clipId);
    if (!manifest || !clip || clip.type !== "midi") return null;
    // Land right after the original; if something already occupies that spot, hop forward by whole clip lengths.
    let start = clip.startBeat + clip.lengthBeats;
    const overlaps = (at: number) => manifest.clips.some((c) => c.trackId === clip.trackId && c.startBeat < at + clip.lengthBeats && c.startBeat + c.lengthBeats > at);
    for (let guard = 0; overlaps(start) && guard < 1000; guard++) start += clip.lengthBeats;
    const id = randomUUID();
    get().dispatch({
      type: "ADD_MIDI_CLIP",
      clip: { ...structuredClone(clip), id, startBeat: start, notes: clip.notes.map((n) => ({ ...n, id: randomUUID() })), createdAt: new Date().toISOString() },
    });
    return id;
  },

  addNotes: (clipId, notes) => {
    const withIds = notes.map((n) => ({ ...n, id: randomUUID() }));
    if (withIds.length) get().dispatch({ type: "BATCH", commands: withIds.map((note) => ({ type: "ADD_MIDI_NOTE" as const, clipId, note })) });
    return withIds.map((n) => n.id);
  },

  deleteNotes: (clipId, noteIds) => {
    if (noteIds.length) get().dispatch({ type: "BATCH", commands: noteIds.map((noteId) => ({ type: "DELETE_MIDI_NOTE" as const, clipId, noteId })) });
  },

  moveNotes: (clipId, moves) => {
    if (moves.length) get().dispatch({ type: "BATCH", commands: moves.map((m) => ({ type: "MOVE_MIDI_NOTE" as const, clipId, noteId: m.id, newStartBeat: m.startBeat, newPitch: m.pitch })) });
  },

  resizeNotes: (clipId, resizes) => {
    if (resizes.length) get().dispatch({ type: "BATCH", commands: resizes.map((r) => ({ type: "RESIZE_MIDI_NOTE" as const, clipId, noteId: r.id, newLengthBeats: r.lengthBeats })) });
  },

  deleteClip: (clipId) => {
    if (get().activePianoRollClipId === clipId) set({ activePianoRollClipId: null });
    if (get().selectedClipId === clipId) set({ selectedClipId: null });
    get().dispatch({ type: "DELETE_CLIP", clipId });
  },

  setClipLoop: (clipId, loop) => get().dispatch({ type: "SET_CLIP_LOOP", clipId, loop }),

  quantizeClip: (clipId, gridBeats) => {
    const clip = get().manifest?.clips.find((c) => c.id === clipId);
    if (!clip || clip.type !== "midi" || gridBeats <= 0) return;
    const commands: EditorCommand[] = [];
    for (const n of clip.notes) {
      const snapped = Math.round(n.startBeat / gridBeats) * gridBeats;
      if (Math.abs(snapped - n.startBeat) > 1e-9) {
        commands.push({ type: "MOVE_MIDI_NOTE", clipId, noteId: n.id, newStartBeat: snapped, newPitch: n.pitch });
      }
    }
    if (commands.length) get().dispatch({ type: "BATCH", commands });
  },
}));
