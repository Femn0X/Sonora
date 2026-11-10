"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "../lib/api";

/**
 * Home page. Adds a real "create project" flow (POST /api/v1/projects) so
 * the full save → publish → remix loop has an actual entry point beyond the
 * hardcoded demo route. The demo route is kept as a no-signup way to poke
 * at the DAW UI itself.
 */
export default function Home() {
  const [title, setTitle] = useState("My New Song");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const { project } = await apiFetch<{ project: { id: string } }>("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      window.location.href = `/daw/${project.id}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the Sonora API. Is it running on :4000?");
      setCreating(false);
    }
  }

  return (
    <main style={{ padding: 48, maxWidth: 720 }}>
      <h1>Sonora</h1>
      <p style={{ color: "#aaa" }}>
        A DAW where every project is forkable, remixable, and versioned — like Git,
        for music. See <code>ARCHITECTURE.md</code> for the full design.
      </p>

      <div style={{ display: "flex", gap: 8, margin: "24px 0" }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Project title"
          style={{ padding: 8, background: "#1e1e1e", color: "#eee", border: "1px solid #333", borderRadius: 6, flex: 1 }}
        />
        <button
          onClick={handleCreate}
          disabled={creating || !title.trim()}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            background: "linear-gradient(135deg, #7c5cff, #5b8def)",
            color: "white",
            border: "none",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {creating ? "Creating…" : "+ New Project"}
        </button>
      </div>
      {error && <p style={{ color: "#ff8080", fontSize: 13 }}>{error}</p>}

      <a href="/daw/demo-project" style={{ color: "#7c5cff", display: "block", marginTop: 8 }}>
        Or open the local demo DAW workspace (not saved) →
      </a>
    </main>
  );
}
