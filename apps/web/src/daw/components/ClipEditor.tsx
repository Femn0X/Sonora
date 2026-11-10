"use client";

import { useState } from "react";
import type { MidiClip } from "@sonora/schema";
import { useProjectStore } from "../state/projectStore";
import type { EditorCommand } from "../state/commands";
import { togglePatternPlay } from "../engine/playback";
import { clipPatternLength } from "../engine/noteScheduling";
import { isDrumInstrument } from "../engine/instruments/registry";
import { PianoRollView } from "./piano-roll/PianoRollView";
import { DrumRollView } from "./drum-roll/DrumRollView";

/**
 * Bottom-panel editor for one MIDI clip. Drum tracks open in the step
 * sequencer, everything else in the piano roll; drum clips can be flipped to
 * the piano roll (e.g. for velocity detail or off-grid hits).
 */

const BAR_OPTIONS = [1, 2, 3, 4, 6, 8, 16];

export function ClipEditor({ clipId }: { clipId: string }) {
  const manifest = useProjectStore((s) => s.manifest);
  const previewClipId = useProjectStore((s) => s.previewClipId);
  const closePianoRoll = useProjectStore((s) => s.closePianoRoll);
  const [override, setOverride] = useState<{ clipId: string; mode: "steps" | "piano" } | null>(null);
  const store = useProjectStore;

  const clip = manifest?.clips.find((c) => c.id === clipId) as MidiClip | undefined;
  if (!manifest || !clip) return <div style={{ padding: 16, color: "#888" }}>Clip not found (it may have been deleted).</div>;

  const track = manifest.tracks.find((t) => t.id === clip.trackId);
  const drums = isDrumInstrument(manifest.instruments.find((i) => i.id === track?.instrumentId));
  const mode = drums ? (override?.clipId === clipId ? override.mode : "steps") : "piano";

  const bar = manifest.timeSignature[0] ?? 4;
  const pattern = clipPatternLength(clip);
  const editBeats = pattern ?? clip.lengthBeats;
  const barsValue = editBeats / bar;
  const barOptions = BAR_OPTIONS.includes(barsValue) ? BAR_OPTIONS : [...BAR_OPTIONS, barsValue].sort((a, b) => a - b);
  const previewing = previewClipId === clipId;

  function setLength(bars: number) {
    const beats = bars * bar;
    if (pattern) {
      // The clip must be at least one pattern long or the new pattern would be cut off.
      const commands: EditorCommand[] = [{ type: "SET_CLIP_LOOP", clipId, loop: { enabled: true, lengthBeats: beats } }];
      if (clip!.lengthBeats < beats) commands.push({ type: "RESIZE_CLIP", clipId, newLengthBeats: beats });
      store.getState().dispatch({ type: "BATCH", commands });
    } else {
      store.getState().resizeClip(clipId, beats);
    }
  }

  function setRepeat(on: boolean) {
    store.getState().setClipLoop(clipId, { enabled: on, lengthBeats: pattern ?? clip!.lengthBeats });
  }

  const tab = (active: boolean) => ({
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 4,
    border: "1px solid #333",
    background: active ? "#3a3a3a" : "#1e1e1e",
    color: active ? "#fff" : "#999",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 12px", borderBottom: "1px solid #2a2a2a", background: "#1a1a1a" }}>
        <strong style={{ fontSize: 13 }}>{track?.name ?? "Track"}</strong>

        {drums && (
          <div style={{ display: "flex", gap: 4 }}>
            <button style={tab(mode === "steps")} onClick={() => setOverride({ clipId, mode: "steps" })}>Step sequencer</button>
            <button style={tab(mode === "piano")} onClick={() => setOverride({ clipId, mode: "piano" })}>Piano roll</button>
          </div>
        )}

        <button
          onClick={() => void togglePatternPlay(clipId)}
          style={{ ...tab(previewing), background: previewing ? "#7a3a3a" : "#1e1e1e", color: "#eee" }}
          title="Loop just this clip, on its own"
        >
          {previewing ? "■ Stop pattern" : "▶ Play pattern"}
        </button>

        <label style={{ color: "#888", fontSize: 12 }}>
          {pattern ? "Pattern" : "Length"}
          <select
            value={barsValue}
            onChange={(e) => setLength(Number(e.target.value))}
            style={{ marginLeft: 6, background: "#1e1e1e", color: "#eee", border: "1px solid #333", borderRadius: 4 }}
          >
            {barOptions.map((b) => (
              <option key={b} value={b}>{b} bar{b === 1 ? "" : "s"}</option>
            ))}
          </select>
        </label>

        <label style={{ color: "#888", fontSize: 12 }} title="Repeat this pattern for the full clip length when you stretch the clip in the arrangement">
          <input type="checkbox" checked={!!pattern} onChange={(e) => setRepeat(e.target.checked)} style={{ marginRight: 5 }} />
          Repeat
        </label>

        <div style={{ flex: 1 }} />
        <button onClick={closePianoRoll} style={{ fontSize: 12 }}>✕ Close</button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === "steps" ? <DrumRollView clipId={clipId} /> : <PianoRollView clipId={clipId} />}
      </div>
    </div>
  );
}
