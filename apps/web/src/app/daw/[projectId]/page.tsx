"use client";

import { useEffect, useState } from "react";
import { ArrangementView } from "../../../daw/components/arrangement/ArrangementView";
import { ClipEditor } from "../../../daw/components/ClipEditor";
import { AddTrackMenu } from "../../../daw/components/AddTrackMenu";
import { ExportButton } from "../../../daw/components/ExportButton";
import { DemoBanner } from "../../../daw/components/DemoBanner";
import { MixerPanel } from "../../../daw/components/mixer/MixerPanel";
import { RemixButton } from "../../../daw/components/RemixButton";
import { useProjectStore } from "../../../daw/state/projectStore";
import { AudioEngine } from "../../../daw/engine/audioEngine";
import { createDemoManifest } from "../../../daw/demoProject";
import { setActiveEngine, togglePlay, stopPlayback, setLoopEnabled } from "../../../daw/engine/playback";
import type { ProjectManifest } from "@sonora/schema";
import { apiFetch, ApiError } from "../../../lib/api";

/**
 * The main DAW workspace screen (ARCHITECTURE §14, screen 1).
 *
 * Load strategy: tries to fetch the real project manifest from the API.
 * If the project doesn't exist yet (e.g. visiting /daw/demo-project without
 * ever having created it), falls back to an in-memory demo manifest so the
 * screen is still explorable — but ONLY the demo fallback is silent; the
 * fallback state is tracked (`isDemo`) and surfaced in the UI, since
 * pretending a demo is a real persisted project would be exactly the kind
 * of "looks complete but isn't" gap the project's dev rules warn against.
 */
export default function DawPage({ params }: { params: { projectId: string } }) {
  const manifest = useProjectStore((s) => s.manifest);
  const loadManifest = useProjectStore((s) => s.loadManifest);
  const isDirty = useProjectStore((s) => s.isDirty);
  const isPlaying = useProjectStore((s) => s.isPlaying);
  const zoomPxPerBeat = useProjectStore((s) => s.zoomPxPerBeat);
  const setZoom = useProjectStore((s) => s.setZoom);
  const setTempo = useProjectStore((s) => s.setTempo);
  const activePianoRollClipId = useProjectStore((s) => s.activePianoRollClipId);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);

  const [engine, setEngine] = useState<AudioEngine | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [bottomTab, setBottomTab] = useState<"editor" | "mixer">("editor");
  const [isDemo, setIsDemo] = useState(false);
  /** Why a REAL project fell back to the demo (null for the genuine demo route) */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const realManifest = await apiFetch<ProjectManifest>(`/api/v1/projects/${params.projectId}/manifest`);
        if (!cancelled) {
          loadManifest(realManifest);
          setIsDemo(false);
          setLoadError(null);
        }
      } catch (err) {
        // Project doesn't exist / has no published version yet — fall back
        // to a local, clearly-labeled demo so the workspace is still usable
        // for exploring the DAW itself. This is NOT silent: `isDemo` drives
        // a visible banner and disables Save.
        if (cancelled) return;
        const demo = createDemoManifest(params.projectId);
        loadManifest(demo);
        setIsDemo(true);
        setLoadError(
          params.projectId === "demo-project" ? null : err instanceof ApiError ? err.message : "Could not reach the API. Is it running on the expected port?"
        );
        console.info(
          err instanceof ApiError
            ? `[DAW] No saved project "${params.projectId}" (${err.message}) — showing local demo instead.`
            : `[DAW] Could not reach the API — showing local demo instead.`
        );
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [params.projectId, loadManifest]);

  // The engine is held in state (not a ref) so the manifest effect below re-runs
  // when a fresh engine is created (e.g. React strict-mode remounts in dev).
  useEffect(() => {
    const e = new AudioEngine();
    setActiveEngine(e);
    setEngine(e);
    return () => {
      setActiveEngine(null);
      e.dispose();
      setEngine(null);
    };
  }, []);

  useEffect(() => {
    if (engine && manifest) engine.loadManifest(manifest);
  }, [engine, manifest]);

  useEffect(() => {
    setLoopEnabled(loopOn);
  }, [loopOn, engine]);

  // Opening a clip (double-click) should show its editor, even if the Mixer tab was active.
  useEffect(() => {
    if (activePianoRollClipId) setBottomTab("editor");
  }, [activePianoRollClipId]);

  async function handlePublish() {
    if (!manifest || isDemo) return;
    const message = window.prompt("Describe this version (like a commit message):", "Update project");
    if (message === null) return; // user cancelled
    setSaveState("saving");
    setSaveError(null);
    try {
      await apiFetch(`/api/v1/projects/${params.projectId}/versions`, {
        method: "POST",
        body: JSON.stringify({ message, manifest }),
      });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof ApiError ? err.message : "Could not reach the Sonora API.");
    }
  }

  // Keyboard shortcuts: Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo, Cmd/Ctrl+S save
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "BUTTON";
      if (e.code === "Space" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void togglePlay();
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        handlePublish();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [manifest, isDemo]);

  if (!manifest) return <div style={{ padding: 24 }}>Loading project…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderBottom: "1px solid #2a2a2a" }}>
        <strong>{manifest.title}</strong>

        <label style={{ color: "#888", fontSize: 13 }}>
          <input
            type="number"
            value={manifest.bpm}
            min={20}
            max={999}
            onChange={(e) => {
              const bpm = Number(e.target.value);
              if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 300) setTempo(bpm);
            }}
            style={{ width: 56, background: "#1e1e1e", color: "#eee", border: "1px solid #333", borderRadius: 4, padding: 2 }}
          />{" "}
          BPM · {manifest.timeSignature.join("/")}
        </label>

        <button onClick={() => void togglePlay()} style={{ padding: "6px 14px", borderRadius: 6 }} title="Play / pause (Space)">
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <button onClick={stopPlayback} style={{ padding: "6px 14px", borderRadius: 6 }} title="Stop and return to start">
          ■ Stop
        </button>
        <label style={{ color: "#888", fontSize: 13 }} title="Loop the arrangement (to the end of the last clip, rounded up to a bar)">
          <input type="checkbox" checked={loopOn} onChange={(e) => setLoopOn(e.target.checked)} style={{ marginRight: 5 }} />
          Loop
        </label>
        <AddTrackMenu />
        <ExportButton />

        <label style={{ color: "#888", fontSize: 13 }}>
          Zoom
          <input
            type="range"
            min={8}
            max={80}
            value={zoomPxPerBeat}
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ marginLeft: 6 }}
          />
        </label>

        {isDemo ? (
        <DemoBanner loadError={loadError} />
        ) : (
          <button onClick={handlePublish} disabled={saveState === "saving"} style={{ padding: "6px 14px", borderRadius: 6 }}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : isDirty ? "Save version*" : "Save version"}
          </button>
        )}
        {saveError && <span style={{ color: "#ff8080", fontSize: 12 }}>{saveError}</span>}

        <div style={{ flex: 1 }} />
        <RemixButton
          projectId={params.projectId}
          license={manifest.license}
          onForked={(newId) => (window.location.href = `/daw/${newId}`)}
        />
      </div>

      {/* Main workspace: browser | arrangement */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ width: 220, borderRight: "1px solid #2a2a2a", padding: 12 }}>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 8 }}>BROWSER</div>
          <div style={{ color: "#555", fontSize: 13 }}>
            Samples / Instruments / Presets — <em>Phase: next iteration</em>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          <ArrangementView />
        </div>
      </div>

      {/* Bottom panel: Piano Roll when a MIDI clip is open, otherwise a hint */}
      <div style={{ height: 340, borderTop: "1px solid #2a2a2a", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", gap: 4, padding: "4px 8px", background: "#161616", borderBottom: "1px solid #2a2a2a" }}>
          {(["editor", "mixer"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setBottomTab(tab)}
              aria-pressed={bottomTab === tab}
              style={{ fontSize: 12, padding: "3px 14px", borderRadius: 4, border: "1px solid #333", background: bottomTab === tab ? "#3a3a3a" : "#1e1e1e", color: bottomTab === tab ? "#fff" : "#999", cursor: "pointer" }}
            >
              {tab === "editor" ? "Editor" : "Mixer"}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {bottomTab === "mixer" ? (
            <MixerPanel />
          ) : activePianoRollClipId ? (
            <ClipEditor clipId={activePianoRollClipId} />
          ) : (
            <div style={{ padding: 12, color: "#555", fontSize: 13 }}>
              Double-click an empty spot on a track to create a clip, or double-click a clip to edit it here (drums open as a step sequencer). Open the Mixer tab for effects, instrument settings and levels.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
