"use client";

import { useEffect, useRef } from "react";
import type { Clip, MidiClip } from "@sonora/schema";
import { useProjectStore } from "../../state/projectStore";
import { seekTo } from "../../engine/playback";
import { clipPatternLength } from "../../engine/noteScheduling";

/**
 * The Arrangement view: tracks-as-lanes, clips-as-rectangles, drawn on Canvas
 * (ARCHITECTURE §3: one canvas redraw is far cheaper than hundreds of DOM
 * nodes while the playhead animates every frame).
 *
 * Interactions
 *  - click the ruler: move the playhead (drag to scrub)
 *  - double-click an empty lane: create a clip on that bar and open its editor
 *  - double-click a clip: open its editor (step sequencer for drums, piano roll otherwise)
 *  - drag a clip: move it (also between tracks); drag its right edge: stretch it
 *    (looping drum patterns repeat to fill the new length)
 *  - Delete / Backspace: delete the selected clip; Ctrl/Cmd+D: duplicate it after itself
 *  Every drag is a single undo step.
 */

const TRACK_HEIGHT = 64;
const HEADER_WIDTH = 160;
const RULER_HEIGHT = 24;
const RESIZE_HANDLE_PX = 7;
const SNAP_BEATS = 0.25;
const MIN_LANES = 4;

const snap = (beats: number, grid = SNAP_BEATS) => Math.round(beats / grid) * grid;

type Drag =
  | { kind: "move"; clipId: string; startX: number; startY: number; origStart: number; origTrackId: string; lastStart: number; lastTrackId: string }
  | { kind: "resize"; clipId: string; startX: number; origLength: number; lastLength: number }
  | { kind: "seek" };

export function ArrangementView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const manifest = useProjectStore((s) => s.manifest);
  const zoom = useProjectStore((s) => s.zoomPxPerBeat);
  const playheadBeat = useProjectStore((s) => s.playheadBeat);
  const selectedClipId = useProjectStore((s) => s.selectedClipId);
  const previewClipId = useProjectStore((s) => s.previewClipId);
  const store = useProjectStore;

  const bar = manifest?.timeSignature[0] ?? 4;
  const laneCount = Math.max(MIN_LANES, manifest?.tracks.length ?? 0);
  const contentEnd = Math.max(0, ...(manifest?.clips.map((c) => c.startBeat + c.lengthBeats) ?? [0]));
  const totalBeats = Math.max(64, Math.ceil(contentEnd / bar) * bar + bar * 8);
  const canvasWidth = HEADER_WIDTH + totalBeats * zoom;
  const canvasHeight = RULER_HEIGHT + laneCount * TRACK_HEIGHT;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !manifest) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;

    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, width, height);

    // Lanes (empty lanes are drawn too so the grid reads as a workspace)
    for (let i = 0; i < laneCount; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#1c1c1c" : "#191919";
      ctx.fillRect(HEADER_WIDTH, RULER_HEIGHT + i * TRACK_HEIGHT, width - HEADER_WIDTH, TRACK_HEIGHT);
    }

    // Beat / bar grid
    for (let beat = 0; beat <= totalBeats; beat++) {
      const x = HEADER_WIDTH + beat * zoom;
      const isBar = beat % bar === 0;
      if (!isBar && zoom < 12) continue;
      ctx.strokeStyle = isBar ? "#3a3a3a" : "#242424";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_HEIGHT);
      ctx.lineTo(x + 0.5, height);
      ctx.stroke();
    }

    // Ruler
    ctx.fillStyle = "#202020";
    ctx.fillRect(HEADER_WIDTH, 0, width - HEADER_WIDTH, RULER_HEIGHT);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = "#9a9a9a";
    const labelEvery = Math.max(1, Math.ceil(44 / (bar * zoom)));
    for (let b = 0; b * bar <= totalBeats; b += labelEvery) {
      ctx.fillText(String(b + 1), HEADER_WIDTH + b * bar * zoom + 4, 15);
    }

    // Track headers
    manifest.tracks.forEach((track, i) => {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT;
      const strip = manifest.mixer.strips.find((s) => s.trackId === track.id);
      ctx.fillStyle = "#242424";
      ctx.fillRect(0, y, HEADER_WIDTH, TRACK_HEIGHT);
      ctx.fillStyle = track.color;
      ctx.fillRect(0, y, 4, TRACK_HEIGHT);
      ctx.fillStyle = "#e5e5e5";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(track.name, 12, y + 22);
      ctx.fillStyle = "#777";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(manifest.instruments.find((x) => x.id === track.instrumentId)?.displayName ?? (track.type === "audio" ? "Audio" : "No instrument"), 12, y + 38);
      drawToggle(ctx, HEADER_WIDTH - 50, y + 40, "M", !!strip?.muted, "#e0a03e");
      drawToggle(ctx, HEADER_WIDTH - 26, y + 40, "S", !!strip?.soloed, "#3ec7a0");
      ctx.strokeStyle = "#111";
      ctx.beginPath();
      ctx.moveTo(0, y + TRACK_HEIGHT + 0.5);
      ctx.lineTo(HEADER_WIDTH, y + TRACK_HEIGHT + 0.5);
      ctx.stroke();
    });
    if (manifest.tracks.length === 0) {
      ctx.fillStyle = "#6a6a6a";
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("No tracks yet — use “+ Track” to add a drum kit or synth.", HEADER_WIDTH + 24, RULER_HEIGHT + 40);
    }

    // Clips
    for (const clip of manifest.clips) {
      const trackIndex = manifest.tracks.findIndex((t) => t.id === clip.trackId);
      if (trackIndex === -1) continue;
      const track = manifest.tracks[trackIndex];
      const x = HEADER_WIDTH + clip.startBeat * zoom;
      const y = RULER_HEIGHT + trackIndex * TRACK_HEIGHT + 4;
      const w = Math.max(clip.lengthBeats * zoom, 2);
      const h = TRACK_HEIGHT - 8;
      const selected = clip.id === selectedClipId;
      const previewing = clip.id === previewClipId;

      ctx.fillStyle = clip.type === "midi" ? track.color : "#3ecf8e";
      ctx.globalAlpha = selected || previewing ? 0.95 : 0.7;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      // darker header strip + resize handle
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(x, y, w, 5);
      ctx.fillRect(x + w - 3, y, 3, h);

      if (clip.type === "midi" && w > 12) drawMidiPreview(ctx, clip, x, y + 5, w, h - 5, zoom);

      if (selected || previewing) {
        ctx.strokeStyle = previewing ? "#ffe066" : "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
    }

    // Playhead
    const px = HEADER_WIDTH + playheadBeat * zoom;
    ctx.strokeStyle = "#ff5555";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillStyle = "#ff5555";
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 8);
    ctx.fill();
  }, [manifest, zoom, playheadBeat, selectedClipId, previewClipId, bar, laneCount, totalBeats]);

  // --- hit testing ---------------------------------------------------------

  function localPoint(e: React.MouseEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function trackIndexAt(y: number) {
    const i = Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
    return i >= 0 ? i : -1;
  }

  function findClipAt(x: number, y: number): Clip | null {
    if (!manifest || x < HEADER_WIDTH) return null;
    const track = manifest.tracks[trackIndexAt(y)];
    if (!track) return null;
    return (
      manifest.clips.find((c) => {
        if (c.trackId !== track.id) return false;
        const cx = HEADER_WIDTH + c.startBeat * zoom;
        return x >= cx && x <= cx + Math.max(c.lengthBeats * zoom, 2);
      }) ?? null
    );
  }

  const beatAt = (x: number) => Math.max(0, (x - HEADER_WIDTH) / zoom);

  // --- mouse -----------------------------------------------------------------

  function onMouseDown(e: React.MouseEvent) {
    if (!manifest) return;
    wrapRef.current?.focus();
    const { x, y } = localPoint(e);

    if (y < RULER_HEIGHT && x >= HEADER_WIDTH) {
      drag.current = { kind: "seek" };
      seekTo(snap(beatAt(x)));
      return;
    }

    if (x < HEADER_WIDTH) {
      const track = manifest.tracks[trackIndexAt(y)];
      if (!track) return;
      const strip = manifest.mixer.strips.find((s) => s.trackId === track.id);
      const rowY = y - (RULER_HEIGHT + trackIndexAt(y) * TRACK_HEIGHT);
      if (rowY >= 40 && rowY <= 58) {
        if (x >= HEADER_WIDTH - 50 && x <= HEADER_WIDTH - 32) store.getState().setTrackMute(track.id, !strip?.muted);
        else if (x >= HEADER_WIDTH - 26 && x <= HEADER_WIDTH - 8) store.getState().setTrackSolo(track.id, !strip?.soloed);
      }
      return;
    }

    const clip = findClipAt(x, y);
    if (!clip) {
      store.getState().selectClip(null);
      return;
    }
    store.getState().selectClip(clip.id);
    store.getState().beginGesture();
    const right = HEADER_WIDTH + (clip.startBeat + clip.lengthBeats) * zoom;
    if (x >= right - RESIZE_HANDLE_PX) {
      drag.current = { kind: "resize", clipId: clip.id, startX: x, origLength: clip.lengthBeats, lastLength: clip.lengthBeats };
    } else {
      drag.current = {
        kind: "move", clipId: clip.id, startX: x, startY: y,
        origStart: clip.startBeat, origTrackId: clip.trackId, lastStart: clip.startBeat, lastTrackId: clip.trackId,
      };
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!manifest) return;
    const { x, y } = localPoint(e);
    const d = drag.current;

    if (!d) {
      const clip = findClipAt(x, y);
      const onEdge = clip && x >= HEADER_WIDTH + (clip.startBeat + clip.lengthBeats) * zoom - RESIZE_HANDLE_PX;
      canvasRef.current!.style.cursor = y < RULER_HEIGHT && x >= HEADER_WIDTH ? "text" : onEdge ? "ew-resize" : clip ? "grab" : "default";
      return;
    }

    if (d.kind === "seek") {
      seekTo(snap(beatAt(x)));
    } else if (d.kind === "resize") {
      const clip = manifest.clips.find((c) => c.id === d.clipId);
      if (!clip) return;
      const pattern = clip.type === "midi" ? clipPatternLength(clip) : null;
      const raw = d.origLength + (x - d.startX) / zoom;
      // Looped patterns stretch in whole repetitions so the pattern never gets cut mid-way by accident.
      const next = pattern ? Math.max(pattern, Math.round(raw / pattern) * pattern) : Math.max(SNAP_BEATS, snap(raw));
      if (next !== d.lastLength) {
        d.lastLength = next;
        store.getState().resizeClip(d.clipId, next);
      }
    } else {
      const start = Math.max(0, snap(d.origStart + (x - d.startX) / zoom));
      const overIdx = Math.min(manifest.tracks.length - 1, Math.max(0, trackIndexAt(y)));
      const overTrack = manifest.tracks[overIdx];
      const trackId = overTrack && overTrack.type !== "audio" ? overTrack.id : d.lastTrackId;
      if (start !== d.lastStart || trackId !== d.lastTrackId) {
        d.lastStart = start;
        d.lastTrackId = trackId;
        store.getState().moveClip(d.clipId, start, trackId !== d.origTrackId ? trackId : undefined);
      }
    }
  }

  function onMouseUp() {
    if (drag.current && drag.current.kind !== "seek") store.getState().endGesture();
    drag.current = null;
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (!manifest) return;
    const { x, y } = localPoint(e);
    if (x < HEADER_WIDTH || y < RULER_HEIGHT) return;
    const clip = findClipAt(x, y);
    if (clip) {
      if (clip.type === "midi") store.getState().openPianoRoll(clip.id);
      return;
    }
    const track = manifest.tracks[trackIndexAt(y)];
    if (!track || track.type === "audio") return;
    const startBeat = Math.floor(beatAt(x) / bar) * bar;
    const clipLen = bar; // minimum footprint test; real length chosen by the store
    const overlaps = manifest.clips.some((c) => c.trackId === track.id && c.startBeat < startBeat + clipLen && c.startBeat + c.lengthBeats > startBeat);
    if (overlaps) return;
    const id = store.getState().createClipOnTrack(track.id, startBeat);
    if (id) store.getState().openPianoRoll(id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedClipId) {
      e.preventDefault();
      store.getState().deleteClip(selectedClipId);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selectedClipId) {
      // Duplicate right after the clip (or the next free slot) and select the copy, so pressing it again keeps extending the song.
      e.preventDefault();
      const copyId = store.getState().duplicateClip(selectedClipId);
      if (copyId) store.getState().selectClip(copyId);
    }
  }

  return (
    <div ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} style={{ overflowX: "auto", outline: "none" }}>
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={onDoubleClick}
        style={{ display: "block", width: canvasWidth, height: canvasHeight }}
      />
    </div>
  );
}

function drawToggle(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, on: boolean, color: string) {
  ctx.fillStyle = on ? color : "#2f2f2f";
  ctx.fillRect(x, y, 20, 18);
  ctx.fillStyle = on ? "#111" : "#8a8a8a";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.fillText(label, x + 6, y + 13);
}

/** Mini piano-roll preview inside a clip; repeats looped patterns across the clip. */
function drawMidiPreview(ctx: CanvasRenderingContext2D, clip: MidiClip, x: number, y: number, w: number, h: number, zoom: number) {
  if (clip.notes.length === 0) return;
  const pattern = clipPatternLength(clip);
  let min = 127;
  let max = 0;
  for (const n of clip.notes) {
    min = Math.min(min, n.pitch);
    max = Math.max(max, n.pitch);
  }
  const span = Math.max(max - min, 7);
  const reps = pattern ? Math.ceil(clip.lengthBeats / pattern) : 1;
  const bodyLen = pattern ?? clip.lengthBeats;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let r = 0; r < reps; r++) {
    const off = r * bodyLen;
    ctx.fillStyle = r === 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)";
    for (const n of clip.notes) {
      if (pattern && n.startBeat >= pattern) continue;
      const nx = x + (off + n.startBeat) * zoom;
      const ny = y + h - 3 - ((n.pitch - min) / span) * (h - 6);
      ctx.fillRect(nx, ny, Math.max(n.lengthBeats * zoom, 2), 2);
    }
    if (r > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x + off * zoom, y, 1, h);
    }
  }
  ctx.restore();
}
