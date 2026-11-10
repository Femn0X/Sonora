"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "../../lib/api";

/**
 * The single most important CTA in the product (ARCHITECTURE §14: "visually
 * dominant... the most important button on the page"). Deliberately built as
 * its own component, reused on: the public project page, feed cards, and the
 * DAW header when viewing a project you don't own — so "remix" always looks
 * and behaves identically no matter where a user encounters it.
 */

type OriginType = "remix" | "fork" | "edit" | "bootleg" | "alt_version";

const ORIGIN_LABELS: Record<OriginType, string> = {
  remix: "Remix",
  fork: "Fork",
  edit: "Edit",
  bootleg: "Bootleg",
  alt_version: "Alt Version",
};

export function RemixButton({
  projectId,
  license,
  onForked,
}: {
  projectId: string;
  license: string;
  onForked?: (newProjectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabled = license === "no_remix";

  async function handleFork(originType: OriginType) {
    setLoading(true);
    setError(null);
    try {
      const newProject = await apiFetch<{ id: string }>(`/api/v1/projects/${projectId}/fork`, {
        method: "POST",
        body: JSON.stringify({ originType }),
      });
      // Remixing should feel "nearly instantaneous" (product spec §8): default
      // to opening the new editable copy immediately. Callers that need custom
      // navigation (e.g. the DAW page, itself a client component) can still
      // override this — but a plain default means server components (like the
      // public project page) can render this button without passing a
      // function prop across the server/client boundary, which Next.js
      // disallows for anything other than a Server Action.
      if (onForked) {
        onForked(newProject.id);
      } else {
        window.location.href = `/daw/${newProject.id}`;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the Sonora API. Is it running?");
    } finally {
      setLoading(false);
      setOpen(false);
    }
  }

  if (disabled) {
    return (
      <button disabled title="The creator has disabled remixing for this project" style={styles.disabled}>
        Remixing disabled
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button style={styles.primary} onClick={() => setOpen((v) => !v)} disabled={loading}>
        {loading ? "Creating your copy…" : "🔀 Remix this Project"}
      </button>
      {open && (
        <div style={styles.menu}>
          {(Object.keys(ORIGIN_LABELS) as OriginType[]).map((type) => (
            <button key={type} style={styles.menuItem} onClick={() => handleFork(type)}>
              {ORIGIN_LABELS[type]}
            </button>
          ))}
        </div>
      )}
      {error && <div style={styles.error}>{error}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  primary: {
    background: "linear-gradient(135deg, #7c5cff, #5b8def)",
    color: "white",
    fontWeight: 700,
    fontSize: 15,
    padding: "12px 20px",
    borderRadius: 10,
    border: "none",
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(124,92,255,0.4)",
  },
  disabled: {
    background: "#2a2a2a",
    color: "#888",
    fontWeight: 600,
    padding: "12px 20px",
    borderRadius: 10,
    border: "1px solid #3a3a3a",
    cursor: "not-allowed",
  },
  menu: {
    position: "absolute",
    top: "110%",
    left: 0,
    background: "#1e1e1e",
    border: "1px solid #333",
    borderRadius: 10,
    overflow: "hidden",
    minWidth: 220,
    zIndex: 10,
  },
  menuItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "10px 16px",
    background: "transparent",
    color: "#eee",
    border: "none",
    cursor: "pointer",
  },
  error: {
    marginTop: 8,
    color: "#ff8080",
    fontSize: 13,
    maxWidth: 260,
  },
};
