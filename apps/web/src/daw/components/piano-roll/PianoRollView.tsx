"use client";

import { useEffect, useRef, useState } from "react";
import type { MidiClip, MidiNote } from "@sonora/schema";
import { useProjectStore } from "../../state/projectStore";
import { auditionNote } from "../../engine/playback";
import { clipPatternLength } from "../../engine/noteScheduling";
import { DRUM_PAD_BY_PITCH } from "../../engine/instruments/drumKit";
import { isDrumInstrument } from "../../engine/instruments/registry";
import { randomUUID } from "../../../lib/uuid";
import { RollPlayhead } from "../shared/RollPlayhead";
import { moveGroup, resizeGroup, toClipboard, pasteNotes, duplicateShift, notesInRect, LOWEST_NOTE, HIGHEST_NOTE } from "./selection";
import { getNoteClipboard, setNoteClipboard } from "./noteClipboard";

/**
 * Piano Roll — MIDI note editor for a single clip.
 *
 * Canvas for the dense, high-frequency grid; React owns only the toolbar
 * (same pattern as ArrangementView).
 *
 * Interactions
 *  - click empty cell: create a note (drag right immediately to set its length)
 *  - drag a note: move (time + pitch); drag its right edge: resize
 *  - right-click a note, or select + Delete: remove it
 *  - click the piano keys: audition; notes are also heard as you place/move them
 *  - drag in the velocity lane: set velocity
 *  Every drag is one undo step.
 *
 * Selection & clipboard
 *  - click a note: select it; shift-click: add/remove from the selection
 *  - shift-drag on empty space: marquee-select (ctrl/cmd+shift-drag adds to the selection)
 *  - dragging a selected note moves the WHOLE selection (clamped as a group, so chords keep their shape)
 *  - ctrl/cmd+A select all, +C copy, +X cut, +V paste at the mouse position, +D duplicate after the selection
 *  - arrow keys nudge (left/right by the grid step, up/down by a semitone, shift = octave); Delete removes; Esc deselects
 *  Every one of these is a single undo step.
 */

const KEY_HEIGHT = 14;
const KEYBOARD_WIDTH = 56;
const VELOCITY_LANE_HEIGHT = 90;
const EDGE_GRAB_PX = 6;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEY_OFFSETS = new Set([1, 3, 6, 8, 10]);

const SNAP_OPTIONS = [
  { label: "1/4", value: 1 },
  { label: "1/8", value: 0.5 },
  { label: "1/16", value: 0.25 },
  { label: "1/32", value: 0.125 },
  { label: "Off", value: 0 },
];

// Minimal scale highlighting: parse "<Root> major|minor" from keySignature; anything else is skipped, not guessed.
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];
const NOTE_NAME_TO_PITCH_CLASS: Record<string, number> = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5, "F#": 6, GB: 6,
  G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11,
};

function parseScale(keySignature?: string): Set<number> | null {
  if (!keySignature) return null;
  const match = keySignature.trim().match(/^([A-Ga-g][#b]?)\s*(major|minor)?$/i);
  if (!match) return null;
  const root = NOTE_NAME_TO_PITCH_CLASS[match[1].toUpperCase()];
  if (root === undefined) return null;
  const intervals = match[2]?.toLowerCase() === "minor" ? MINOR_INTERVALS : MAJOR_INTERVALS;
  return new Set(intervals.map((i) => (root + i) % 12));
}

type Drag =
  | {
      mode: "move" | "resize";
      /** The note under the mouse: its snapped position drives the whole group */
      anchor: MidiNote;
      startX: number;
      startY: number;
      /** Snapshot of the selection when the drag began; every update is computed from this, never from live data */
      group: MidiNote[];
      lastStart: number;
      lastPitch: number;
      lastLength: number;
    }
  | { mode: "marquee"; startX: number; startY: number; base: Set<string> };

export function PianoRollView({ clipId }: { clipId: string }) {
  const manifest = useProjectStore((s) => s.manifest);
  const store = useProjectStore;

  const gridRef = useRef<HTMLCanvasElement>(null);
  const velocityRef = useRef<HTMLCanvasElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(60);
  const [snap, setSnap] = useState(0.25);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Where ctrl+V pastes: wherever the mouse is over the grid (clicking an empty cell would create a stray note) */
  const pasteBeat = useRef(0);

  const drag = useRef<Drag | null>(null);
  const velocityDrag = useRef<{ noteId: string; last: number } | null>(null);
  /** New notes reuse the last length the user set (FL Studio behaviour) */
  const lastLength = useRef(0.25);

  const clip = manifest?.clips.find((c) => c.id === clipId) as MidiClip | undefined;
  const track = manifest?.tracks.find((t) => t.id === clip?.trackId);
  const instrument = manifest?.instruments.find((i) => i.id === track?.instrumentId);
  const isDrums = isDrumInstrument(instrument);
  const scale = isDrums ? null : parseScale(manifest?.keySignature);

  // Notes live in the pattern body when the clip loops, otherwise in the whole clip.
  const editLength = clip ? clipPatternLength(clip) ?? clip.lengthBeats : 16;
  const numRows = HIGHEST_NOTE - LOWEST_NOTE + 1;
  const gridHeight = numRows * KEY_HEIGHT;
  const gridWidth = KEYBOARD_WIDTH + editLength * zoom + 40;
  const beatsPerBar = manifest?.timeSignature[0] ?? 4;

  const pitchToRow = (pitch: number) => HIGHEST_NOTE - pitch;
  const rowToPitch = (row: number) => HIGHEST_NOTE - row;
  const snapBeat = (beat: number) => (snap === 0 ? Math.max(0, beat) : Math.max(0, Math.round(beat / snap) * snap));

  // Scroll to the notes (or middle C) when a clip is opened, instead of the top of a 72-row grid.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !clip) return;
    const pitches = clip.notes.map((n) => n.pitch);
    const center = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    el.scrollTop = Math.max(0, pitchToRow(Math.round(center)) * KEY_HEIGHT - el.clientHeight / 2);
  }, [clipId]);

  // --- grid drawing ---------------------------------------------------------
  useEffect(() => {
    const canvas = gridRef.current;
    if (!canvas || !clip) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const bodyRight = KEYBOARD_WIDTH + editLength * zoom;

    for (let row = 0; row < numRows; row++) {
      const pitch = rowToPitch(row);
      const pc = ((pitch % 12) + 12) % 12;
      const isBlack = BLACK_KEY_OFFSETS.has(pc);
      const inScale = scale?.has(pc) ?? true;
      ctx.fillStyle = inScale ? (isBlack ? "#1a1a1a" : "#212121") : isBlack ? "#151515" : "#191919";
      ctx.fillRect(KEYBOARD_WIDTH, row * KEY_HEIGHT, canvas.width - KEYBOARD_WIDTH, KEY_HEIGHT);
      ctx.strokeStyle = "#2a2a2a";
      ctx.lineWidth = 1;
      ctx.strokeRect(KEYBOARD_WIDTH, row * KEY_HEIGHT, canvas.width - KEYBOARD_WIDTH, KEY_HEIGHT);
      // Highlight rows that are real drum pads on drum tracks
      if (isDrums && DRUM_PAD_BY_PITCH.has(pitch)) {
        ctx.fillStyle = "rgba(224,138,62,0.12)";
        ctx.fillRect(KEYBOARD_WIDTH, row * KEY_HEIGHT, canvas.width - KEYBOARD_WIDTH, KEY_HEIGHT);
      }
    }

    // Grid lines: beats, with bar lines heavier, plus sub-beat lines when zoomed in
    const beats = Math.ceil(editLength);
    for (let beat = 0; beat <= beats; beat++) {
      const x = KEYBOARD_WIDTH + beat * zoom;
      ctx.strokeStyle = beat % beatsPerBar === 0 ? "#555" : "#2f2f2f";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, gridHeight);
      ctx.stroke();
      if (zoom >= 80 && beat < beats) {
        ctx.strokeStyle = "#262626";
        for (const sub of [0.25, 0.5, 0.75]) {
          const sx = x + sub * zoom + 0.5;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, gridHeight);
          ctx.stroke();
        }
      }
    }

    // Everything past the end of the editable region is dimmed: notes there would never play.
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(bodyRight, 0, canvas.width - bodyRight, gridHeight);

    // Keyboard
    for (let row = 0; row < numRows; row++) {
      const pitch = rowToPitch(row);
      const pc = ((pitch % 12) + 12) % 12;
      const isBlack = BLACK_KEY_OFFSETS.has(pc);
      ctx.fillStyle = isBlack ? "#111" : "#e8e8e8";
      ctx.fillRect(0, row * KEY_HEIGHT, KEYBOARD_WIDTH, KEY_HEIGHT);
      ctx.strokeStyle = "#333";
      ctx.strokeRect(0, row * KEY_HEIGHT, KEYBOARD_WIDTH, KEY_HEIGHT);
      const pad = isDrums ? DRUM_PAD_BY_PITCH.get(pitch) : undefined;
      if (pad) {
        ctx.fillStyle = isBlack ? "#e8a860" : "#a8601c";
        ctx.font = "9px system-ui, sans-serif";
        ctx.fillText(pad.name.slice(0, 9), 3, row * KEY_HEIGHT + 10);
      } else if (pc === 0) {
        ctx.fillStyle = "#666";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(`${NOTE_NAMES[pc]}${Math.floor(pitch / 12) - 1}`, 4, row * KEY_HEIGHT + 10);
      }
    }

    // Notes
    for (const note of clip.notes) {
      const x = KEYBOARD_WIDTH + note.startBeat * zoom;
      const y = pitchToRow(note.pitch) * KEY_HEIGHT;
      const w = Math.max(note.lengthBeats * zoom, 4);
      const brightness = 0.4 + (note.velocity / 127) * 0.6;
      const isSel = selected.has(note.id);
      ctx.fillStyle = isSel ? "#ffb84d" : `rgba(91, 141, 239, ${brightness})`;
      ctx.fillRect(x, y + 1, w, KEY_HEIGHT - 2);
      ctx.strokeStyle = isSel ? "#fff" : "#3a5fb0";
      ctx.strokeRect(x + 0.5, y + 1.5, w - 1, KEY_HEIGHT - 3);
    }
  }, [clip, zoom, selected, scale, isDrums, editLength, beatsPerBar, numRows, gridHeight]);

  // --- velocity lane drawing --------------------------------------------------
  useEffect(() => {
    const canvas = velocityRef.current;
    if (!canvas || !clip) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#6a6a6a";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("Velocity", 6, 14);
    for (const note of clip.notes) {
      const x = KEYBOARD_WIDTH + note.startBeat * zoom;
      const h = (note.velocity / 127) * (VELOCITY_LANE_HEIGHT - 10);
      ctx.fillStyle = selected.has(note.id) ? "#ffb84d" : "#5b8def";
      ctx.fillRect(x, VELOCITY_LANE_HEIGHT - h - 4, 6, h);
    }
  }, [clip, zoom, selected, gridWidth]);

  // --- helpers ----------------------------------------------------------------
  function point(e: React.MouseEvent, canvas: HTMLCanvasElement | null) {
    const rect = canvas!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function findNoteAt(x: number, y: number): MidiNote | null {
    if (!clip) return null;
    const pitch = rowToPitch(Math.floor(y / KEY_HEIGHT));
    // iterate from the end so the most recently drawn (top-most) note wins
    for (let i = clip.notes.length - 1; i >= 0; i--) {
      const n = clip.notes[i];
      if (n.pitch !== pitch) continue;
      const nx = KEYBOARD_WIDTH + n.startBeat * zoom;
      if (x >= nx && x <= nx + Math.max(n.lengthBeats * zoom, 4)) return n;
    }
    return null;
  }

  // --- grid mouse -------------------------------------------------------------
  const minStep = () => snap || 0.125;

  function onGridDown(e: React.MouseEvent) {
    if (!clip || e.button !== 0) return;
    const { x, y } = point(e, gridRef.current);
    const pitch = rowToPitch(Math.floor(y / KEY_HEIGHT));
    if (pitch < LOWEST_NOTE || pitch > HIGHEST_NOTE) return;

    if (x < KEYBOARD_WIDTH) {
      auditionNote(clip.trackId, pitch, 100);
      return;
    }

    pasteBeat.current = snapBeat((x - KEYBOARD_WIDTH) / zoom);
    const existing = findNoteAt(x, y);

    if (existing) {
      if (e.shiftKey) {
        // shift-click toggles membership; it never starts a drag
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(existing.id)) next.delete(existing.id);
          else next.add(existing.id);
          return next;
        });
        return;
      }
      // Dragging an unselected note selects just it; dragging a selected one moves the whole selection.
      let current = selected;
      if (!current.has(existing.id)) {
        current = new Set([existing.id]);
        setSelected(current);
      }
      auditionNote(clip.trackId, existing.pitch, existing.velocity);
      store.getState().beginGesture();
      const right = KEYBOARD_WIDTH + (existing.startBeat + existing.lengthBeats) * zoom;
      const grab = Math.min(EDGE_GRAB_PX, existing.lengthBeats * zoom * 0.4);
      drag.current = {
        mode: right - x < grab ? "resize" : "move",
        anchor: existing, startX: x, startY: y,
        group: clip.notes.filter((n) => current.has(n.id)),
        lastStart: existing.startBeat, lastPitch: existing.pitch, lastLength: existing.lengthBeats,
      };
      return;
    }

    if (e.shiftKey) {
      // Marquee selection. Ctrl/cmd+shift keeps the existing selection and adds to it.
      drag.current = { mode: "marquee", startX: x, startY: y, base: e.ctrlKey || e.metaKey ? new Set(selected) : new Set() };
      if (!(e.ctrlKey || e.metaKey)) setSelected(new Set());
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
      return;
    }

    // Empty cell: create a note and keep the gesture open so dragging sets its length.
    const start = snapBeat((x - KEYBOARD_WIDTH) / zoom);
    if (start >= editLength) return;
    const length = Math.min(lastLength.current, editLength - start);
    const note: MidiNote = { id: randomUUID(), pitch, startBeat: start, lengthBeats: length, velocity: 100 };
    store.getState().beginGesture();
    store.getState().dispatch({ type: "ADD_MIDI_NOTE", clipId: clip.id, note });
    setSelected(new Set([note.id]));
    auditionNote(clip.trackId, pitch, note.velocity);
    drag.current = { mode: "resize", anchor: note, startX: x, startY: y, group: [note], lastStart: start, lastPitch: pitch, lastLength: length };
  }

  function onGridMove(e: React.MouseEvent) {
    const d = drag.current;
    if (!clip) return;
    const { x, y } = point(e, gridRef.current);
    if (!d) {
      if (x >= KEYBOARD_WIDTH) pasteBeat.current = snapBeat((x - KEYBOARD_WIDTH) / zoom);
      return;
    }

    if (d.mode === "marquee") {
      setMarquee({ x0: d.startX, y0: d.startY, x1: x, y1: y });
      const hit = notesInRect(clip.notes, {
        beatA: (d.startX - KEYBOARD_WIDTH) / zoom, beatB: (x - KEYBOARD_WIDTH) / zoom,
        pitchA: rowToPitch(Math.floor(d.startY / KEY_HEIGHT)), pitchB: rowToPitch(Math.floor(y / KEY_HEIGHT)),
      });
      setSelected(new Set([...d.base, ...hit.map((n) => n.id)]));
      return;
    }

    if (d.mode === "move") {
      // The anchor note's snapped position decides the shift; the group is clamped as one unit.
      const dBeat = snapBeat(d.anchor.startBeat + (x - d.startX) / zoom) - d.anchor.startBeat;
      const dPitch = -Math.round((y - d.startY) / KEY_HEIGHT);
      const moves = moveGroup(d.group, dBeat, dPitch, editLength, minStep());
      const anchorMove = moves.find((m) => m.id === d.anchor.id)!;
      if (anchorMove.startBeat === d.lastStart && anchorMove.pitch === d.lastPitch) return;
      if (anchorMove.pitch !== d.lastPitch) auditionNote(clip.trackId, anchorMove.pitch, d.anchor.velocity);
      d.lastStart = anchorMove.startBeat;
      d.lastPitch = anchorMove.pitch;
      store.getState().moveNotes(clip.id, moves);
    } else {
      const raw = d.anchor.lengthBeats + (x - d.startX) / zoom;
      const length = Math.min(editLength - d.anchor.startBeat, Math.max(minStep(), snapBeat(raw)));
      if (length === d.lastLength) return;
      d.lastLength = length;
      lastLength.current = length;
      store.getState().resizeNotes(clip.id, resizeGroup(d.group, length - d.anchor.lengthBeats, editLength, minStep()));
    }
  }

  function onGridUp() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === "marquee") setMarquee(null);
    else store.getState().endGesture();
  }

  function onGridContext(e: React.MouseEvent) {
    e.preventDefault();
    if (!clip) return;
    const { x, y } = point(e, gridRef.current);
    const note = findNoteAt(x, y);
    if (note) {
      store.getState().deleteNote(clip.id, note.id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(note.id);
        return next;
      });
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!clip) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const sel = clip.notes.filter((n) => selected.has(n.id)); // ids of notes since deleted/undone are simply ignored
    const state = store.getState();

    if (mod && key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(clip.notes.map((n) => n.id)));
    } else if (mod && (key.toLowerCase() === "c" || key.toLowerCase() === "x")) {
      if (sel.length === 0) return;
      e.preventDefault();
      setNoteClipboard(toClipboard(sel));
      if (key.toLowerCase() === "x") {
        state.deleteNotes(clip.id, sel.map((n) => n.id));
        setSelected(new Set());
      }
    } else if (mod && key.toLowerCase() === "v") {
      const items = pasteNotes(getNoteClipboard(), pasteBeat.current, editLength);
      if (items.length === 0) return;
      e.preventDefault();
      setSelected(new Set(state.addNotes(clip.id, items)));
    } else if (mod && key.toLowerCase() === "d") {
      if (sel.length === 0) return;
      e.preventDefault();
      const origin = Math.min(...sel.map((n) => n.startBeat));
      const items = pasteNotes(toClipboard(sel), origin + duplicateShift(sel, snap), editLength);
      if (items.length) setSelected(new Set(state.addNotes(clip.id, items)));
    } else if (key === "Delete" || key === "Backspace") {
      if (sel.length === 0) return;
      e.preventDefault();
      state.deleteNotes(clip.id, sel.map((n) => n.id));
      setSelected(new Set());
    } else if (key === "Escape") {
      setSelected(new Set());
    } else if (key.startsWith("Arrow") && sel.length > 0 && !mod) {
      e.preventDefault();
      const step = minStep();
      const dBeat = key === "ArrowRight" ? step : key === "ArrowLeft" ? -step : 0;
      const dPitch = key === "ArrowUp" ? (e.shiftKey ? 12 : 1) : key === "ArrowDown" ? (e.shiftKey ? -12 : -1) : 0;
      const moves = moveGroup(sel, dBeat, dPitch, editLength, step);
      // Already against an edge: nothing moves, so don't record an undo step that does nothing.
      if (moves.every((m, i) => m.startBeat === sel[i].startBeat && m.pitch === sel[i].pitch)) return;
      state.moveNotes(clip.id, moves);
      if (dPitch !== 0) auditionNote(clip.trackId, moves[0].pitch, sel[0].velocity);
    }
  }

  // --- velocity lane ------------------------------------------------------------
  const velocityFromY = (y: number) => {
    const clamped = Math.max(0, Math.min(VELOCITY_LANE_HEIGHT - 4, VELOCITY_LANE_HEIGHT - y));
    return Math.max(1, Math.min(127, Math.round((clamped / (VELOCITY_LANE_HEIGHT - 10)) * 127)));
  };

  function onVelocityDown(e: React.MouseEvent) {
    if (!clip) return;
    const { x, y } = point(e, velocityRef.current);
    const hits = clip.notes.filter((n) => {
      const nx = KEYBOARD_WIDTH + n.startBeat * zoom;
      return x >= nx - 3 && x <= nx + 9;
    });
    // With stacked notes (chords) prefer the selected one, otherwise the top-most.
    const note = hits.find((n) => selected.has(n.id)) ?? hits[hits.length - 1];
    if (!note) return;
    store.getState().beginGesture();
    const v = velocityFromY(y);
    velocityDrag.current = { noteId: note.id, last: v };
    store.getState().updateNote(clip.id, note.id, { velocity: v });
    setSelected(new Set([note.id]));
  }

  function onVelocityMove(e: React.MouseEvent) {
    const d = velocityDrag.current;
    if (!d || !clip) return;
    const v = velocityFromY(point(e, velocityRef.current).y);
    if (v === d.last) return;
    d.last = v;
    store.getState().updateNote(clip.id, d.noteId, { velocity: v });
  }

  function onVelocityUp() {
    if (velocityDrag.current) store.getState().endGesture();
    velocityDrag.current = null;
  }

  if (!clip) return <div style={{ padding: 16, color: "#888" }}>Clip not found (it may have been deleted).</div>;

  const selectStyle = { marginLeft: 6, background: "#1e1e1e", color: "#eee", border: "1px solid #333", borderRadius: 4 };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", outline: "none" }} tabIndex={0} onKeyDown={onKeyDown}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "5px 12px", borderBottom: "1px solid #2a2a2a" }}>
        <label style={{ color: "#888", fontSize: 12 }}>
          Snap
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))} style={selectStyle}>
            {SNAP_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label style={{ color: "#888", fontSize: 12 }}>
          Zoom
          <input type="range" min={20} max={160} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ marginLeft: 6 }} />
        </label>
        <button style={{ fontSize: 12 }} onClick={() => store.getState().quantizeClip(clip.id, snap || 0.25)} title="Snap all note starts to the current grid">
          Quantize
        </button>
        {scale && <span style={{ color: "#666", fontSize: 12 }}>Scale: {manifest?.keySignature}</span>}
        {selected.size > 0 && clip.notes.some((n) => selected.has(n.id)) && (
          <span style={{ color: "#ffb84d", fontSize: 12 }}>{clip.notes.filter((n) => selected.has(n.id)).length} selected</span>
        )}
        <span style={{ color: "#555", fontSize: 11 }}>
          click: add · shift-click/drag: select · ctrl+C/X/V (paste at mouse)/D · arrows: nudge · del
        </span>
      </div>

      <div ref={scrollerRef} style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ position: "relative", width: gridWidth }}>
          <canvas
            ref={gridRef}
            width={gridWidth}
            height={gridHeight}
            onMouseDown={onGridDown}
            onMouseMove={onGridMove}
            onMouseUp={onGridUp}
            onMouseLeave={onGridUp}
            onContextMenu={onGridContext}
            style={{ display: "block", cursor: "crosshair" }}
          />
          <RollPlayhead clip={clip} zoom={zoom} leftOffset={KEYBOARD_WIDTH} height={gridHeight} />
          {marquee && (
            <div
              data-testid="marquee"
              style={{
                position: "absolute",
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
                border: "1px dashed #ffb84d",
                background: "rgba(255,184,77,0.12)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        <div style={{ position: "sticky", bottom: 0, borderTop: "1px solid #2a2a2a", width: gridWidth }}>
          <canvas
            ref={velocityRef}
            width={gridWidth}
            height={VELOCITY_LANE_HEIGHT}
            onMouseDown={onVelocityDown}
            onMouseMove={onVelocityMove}
            onMouseUp={onVelocityUp}
            onMouseLeave={onVelocityUp}
            style={{ display: "block", cursor: "ns-resize" }}
          />
        </div>
      </div>
    </div>
  );
}
