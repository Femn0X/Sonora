"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectManifest } from "@sonora/schema";
import { useProjectStore } from "../state/projectStore";
import { bounceToWavBlob, exportFileName } from "../engine/export";

/**
 * "Export WAV": renders the project offline with the same engine you hear, then downloads it.
 * Rendering happens on the audio side (the page stays responsive); the button shows progress and any error
 * (empty project, too long, no offline audio support) inline.
 */

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportButton({ render = bounceToWavBlob }: { render?: (manifest: ProjectManifest) => Promise<Blob> }) {
  const manifest = useProjectStore((s) => s.manifest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    if (!manifest || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The store never mutates a manifest (every edit creates a new one), so this reference is already a snapshot:
      // edits made while rendering can not change what is being exported.
      const blob = await render(manifest);
      download(blob, exportFileName(manifest.title));
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button onClick={run} disabled={busy || !manifest} style={{ padding: "6px 14px", borderRadius: 6 }} title="Render the project to a WAV file">
        {busy ? "Rendering…" : "⬇ Export WAV"}
      </button>
      {error && (
        <span role="alert" style={{ color: "#e07a6a", fontSize: 12, maxWidth: 320 }}>
          {error}
        </span>
      )}
    </div>
  );
}
