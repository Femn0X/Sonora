"use client";

import { useEffect, useRef } from "react";
import type { MidiClip, MidiNote } from "@sonora/schema";
import { useProjectStore } from "../../state/projectStore";
import { auditionNote } from "../../engine/playback";
import { clipPatternLength } from "../../engine/noteScheduling";
import { DRUM_PADS, DRUM_PAD_BY_PITCH } from "../../engine/instruments/drumKit";
import { randomUUID } from "../../../lib/uuid";
import { RollPlayhead } from "../shared/RollPlayhead";

/**
 * Drum Roll — step sequencer. A 16th-note grid, one row per drum pad.
 *
 * It is just another *view* over a normal MidiClip (pad = GM drum pitch, step =
 * 1/16 note), not a separate data format. So a beat built here can be opened in
 * the piano roll, diffed/merged like any other MIDI, and survives forks.
 *
 *  - click a step: toggle it (drag to paint or erase a run of steps)
 *  - shift+click an active step: cycle accent (normal -> loud -> ghost)
 *  - click a pad name: audition that drum
 *  Every drag is one undo step.
 */

const LABEL_WIDTH = 110;
const ROW_HEIGHT = 30;
const STEP_WIDTH = 30;
const STEPS_PER_BEAT = 4;
const STEP_BEATS = 1 / STEPS_PER_BEAT;
const DEFAULT_VELOCITY = 100;

const stepOf = (n: MidiNote) => Math.round(n.startBeat * STEPS_PER_BEAT);

function nextAccent(v: number) {
  if (v < 80) return DEFAULT_VELOCITY; // ghost -> normal
  if (v < 115) return 127; //             normal -> loud
  return 60; //                           loud -> ghost
}

export function DrumRollView({ clipId }: { clipId: string }) {
  const manifest = useProjectStore((s) => s.manifest);
  const store = useProjectStore;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paint = useRef<{ mode: "add" | "remove"; visited: Set<string> } | null>(null);

  const clip = manifest?.clips.find((c) => c.id === clipId) as MidiClip | undefined;
  const beatsPerBar = manifest?.timeSignature[0] ?? 4;
  const editLength = clip ? clipPatternLength(clip) ?? clip.lengthBeats : 4;
  const steps = Math.max(1, Math.round(editLength * STEPS_PER_BEAT));
  const width = LABEL_WIDTH + steps * STEP_WIDTH;
  const height = DRUM_PADS.length * ROW_HEIGHT;

  const padNotes = clip?.notes.filter((n) => DRUM_PAD_BY_PITCH.has(n.pitch)) ?? [];
  const otherNotes = (clip?.notes.length ?? 0) - padNotes.length;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !clip) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#171717";
    ctx.fillRect(0, 0, width, height);

    DRUM_PADS.forEach((pad, row) => {
      const y = row * ROW_HEIGHT;
      // label
      ctx.fillStyle = "#262626";
      ctx.fillRect(0, y, LABEL_WIDTH, ROW_HEIGHT);
      ctx.fillStyle = "#d8d8d8";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(pad.name, 10, y + 19);
      ctx.strokeStyle = "#111";
      ctx.strokeRect(0.5, y + 0.5, LABEL_WIDTH - 1, ROW_HEIGHT - 1);

      // step cells; alternate beats are shaded so the 4-step groups read at a glance
      for (let s = 0; s < steps; s++) {
        const beatIdx = Math.floor(s / STEPS_PER_BEAT);
        ctx.fillStyle = beatIdx % 2 === 0 ? "#2b2b2b" : "#222222";
        ctx.fillRect(LABEL_WIDTH + s * STEP_WIDTH + 1, y + 1, STEP_WIDTH - 2, ROW_HEIGHT - 2);
      }
    });

    // bar lines
    for (let s = 0; s <= steps; s += beatsPerBar * STEPS_PER_BEAT) {
      ctx.fillStyle = "#555";
      ctx.fillRect(LABEL_WIDTH + s * STEP_WIDTH - 1, 0, 2, height);
    }

    // active steps (brightness = velocity)
    for (const n of padNotes) {
      const row = DRUM_PADS.findIndex((p) => p.pitch === n.pitch);
      const s = stepOf(n);
      if (row < 0 || s < 0 || s >= steps) continue;
      const alpha = 0.4 + (n.velocity / 127) * 0.6;
      ctx.fillStyle = `rgba(224, 138, 62, ${alpha})`;
      ctx.fillRect(LABEL_WIDTH + s * STEP_WIDTH + 1, row * ROW_HEIGHT + 1, STEP_WIDTH - 2, ROW_HEIGHT - 2);
      ctx.strokeStyle = n.velocity >= 115 ? "#fff" : "#a8601c";
      ctx.lineWidth = n.velocity >= 115 ? 2 : 1;
      ctx.strokeRect(LABEL_WIDTH + s * STEP_WIDTH + 1.5, row * ROW_HEIGHT + 1.5, STEP_WIDTH - 3, ROW_HEIGHT - 3);
      ctx.lineWidth = 1;
    }
  }, [clip, steps, width, height, beatsPerBar, padNotes.length]);

  function cellAt(e: React.MouseEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const row = Math.floor(y / ROW_HEIGHT);
    if (row < 0 || row >= DRUM_PADS.length) return null;
    if (x < LABEL_WIDTH) return { row, step: -1 };
    const step = Math.floor((x - LABEL_WIDTH) / STEP_WIDTH);
    return step >= 0 && step < steps ? { row, step } : null;
  }

  const notesAt = (row: number, step: number) =>
    (clip?.notes ?? []).filter((n) => n.pitch === DRUM_PADS[row].pitch && stepOf(n) === step);

  function applyCell(row: number, step: number, mode: "add" | "remove") {
    if (!clip) return;
    const existing = notesAt(row, step);
    const pitch = DRUM_PADS[row].pitch;
    if (mode === "add" && existing.length === 0) {
      store.getState().dispatch({
        type: "ADD_MIDI_NOTE",
        clipId: clip.id,
        note: { id: randomUUID(), pitch, startBeat: step * STEP_BEATS, lengthBeats: STEP_BEATS, velocity: DEFAULT_VELOCITY },
      });
      auditionNote(clip.trackId, pitch, DEFAULT_VELOCITY);
    } else if (mode === "remove") {
      for (const n of existing) store.getState().deleteNote(clip.id, n.id);
    }
  }

  function onDown(e: React.MouseEvent) {
    if (!clip || e.button !== 0) return;
    const cell = cellAt(e);
    if (!cell) return;
    if (cell.step === -1) {
      auditionNote(clip.trackId, DRUM_PADS[cell.row].pitch, 110);
      return;
    }
    const existing = notesAt(cell.row, cell.step);

    if (e.shiftKey && existing.length > 0) {
      const n = existing[0];
      store.getState().updateNote(clip.id, n.id, { velocity: nextAccent(n.velocity) });
      auditionNote(clip.trackId, n.pitch, nextAccent(n.velocity));
      return;
    }

    const mode = existing.length > 0 ? "remove" : "add";
    store.getState().beginGesture();
    paint.current = { mode, visited: new Set([`${cell.row}:${cell.step}`]) };
    applyCell(cell.row, cell.step, mode);
  }

  function onMove(e: React.MouseEvent) {
    const p = paint.current;
    if (!p) return;
    const cell = cellAt(e);
    if (!cell || cell.step < 0) return;
    const key = `${cell.row}:${cell.step}`;
    if (p.visited.has(key)) return;
    p.visited.add(key);
    applyCell(cell.row, cell.step, p.mode);
  }

  function onUp() {
    if (paint.current) store.getState().endGesture();
    paint.current = null;
  }

  function clearAll() {
    if (!clip || padNotes.length === 0) return;
    store.getState().dispatch({
      type: "BATCH",
      commands: padNotes.map((n) => ({ type: "DELETE_MIDI_NOTE" as const, clipId: clip.id, noteId: n.id })),
    });
  }

  if (!clip) return <div style={{ padding: 16, color: "#888" }}>Clip not found (it may have been deleted).</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "5px 12px", borderBottom: "1px solid #2a2a2a" }}>
        <button style={{ fontSize: 12 }} onClick={() => store.getState().quantizeClip(clip.id, STEP_BEATS)} title="Snap any off-grid hits (e.g. from the piano roll) to 1/16 steps">
          Snap to grid
        </button>
        <button style={{ fontSize: 12 }} onClick={clearAll} disabled={padNotes.length === 0}>
          Clear
        </button>
        <span style={{ color: "#555", fontSize: 11 }}>click/drag: paint steps · shift+click: accent · click a pad name: preview</span>
        {otherNotes > 0 && (
          <span style={{ color: "#9a7b3a", fontSize: 11 }} title="These notes aren't on a drum pad, so this kit won't play them. They're visible in the piano roll.">
            {otherNotes} note{otherNotes === 1 ? "" : "s"} outside the kit
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
        <div style={{ position: "relative", width }}>
          <canvas
            ref={canvasRef}
            width={width}
            height={height}
            onMouseDown={onDown}
            onMouseMove={onMove}
            onMouseUp={onUp}
            onMouseLeave={onUp}
            onContextMenu={(e) => e.preventDefault()}
            style={{ display: "block", cursor: "pointer" }}
          />
          <RollPlayhead clip={clip} zoom={STEP_WIDTH * STEPS_PER_BEAT} leftOffset={LABEL_WIDTH} height={height} />
        </div>
      </div>
    </div>
  );
}
