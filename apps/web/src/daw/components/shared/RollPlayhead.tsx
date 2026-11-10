"use client";

import type { MidiClip } from "@sonora/schema";
import { useProjectStore } from "../../state/projectStore";
import { clipPatternLength } from "../../engine/noteScheduling";

/**
 * Playhead line for the clip editors. A DOM overlay (not part of the canvas)
 * so the heavy note grid isn't redrawn 60 times a second; it subscribes to
 * the playhead itself so the surrounding editor doesn't re-render either.
 *
 * Position is relative to the clip, and wraps at the pattern length for
 * looped clips so it tracks the pattern being heard on every repetition.
 */
export function RollPlayhead({ clip, zoom, leftOffset, height }: { clip: MidiClip; zoom: number; leftOffset: number; height: number }) {
  const beat = useProjectStore((s) => s.playheadBeat);
  const playing = useProjectStore((s) => s.isPlaying);
  if (!playing) return null;

  let rel = beat - clip.startBeat;
  if (rel < 0 || rel >= clip.lengthBeats) return null;
  const pattern = clipPatternLength(clip);
  if (pattern) rel = rel % pattern;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: leftOffset + rel * zoom,
        width: 2,
        height,
        background: "#ff5555",
        pointerEvents: "none",
      }}
    />
  );
}
