"use client";

import { useState } from "react";
import { useProjectStore } from "../state/projectStore";
import { TRACK_TEMPLATES } from "../engine/instruments/registry";

/** Templates grouped under their instrument, in first-seen order. */
const GROUPS = (() => {
  const map = new Map<string, typeof TRACK_TEMPLATES>();
  for (const t of TRACK_TEMPLATES) {
    const g = t.group ?? "Basics";
    map.set(g, [...(map.get(g) ?? []), t]);
  }
  return [...map].map(([group, items]) => ({ group, items }));
})();

/** "+ Track" dropdown: each entry creates an instrument + track + mixer strip as one undo step. */
export function AddTrackMenu() {
  const [open, setOpen] = useState(false);
  const manifest = useProjectStore((s) => s.manifest);
  const addTrackFromTemplate = useProjectStore((s) => s.addTrackFromTemplate);

  // No client-side user identity exists yet; reuse the project's existing author.
  const authorId = manifest?.tracks[0]?.authorId ?? "local-user";

  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ padding: "6px 14px", borderRadius: 6 }}>
        + Track
      </button>
      {open && (
        <div
          style={{ position: "absolute", top: "110%", left: 0, zIndex: 20, background: "#1e1e1e", border: "1px solid #333", borderRadius: 6, minWidth: 190, padding: 4, maxHeight: 420, overflowY: "auto" }}
          onMouseLeave={() => setOpen(false)}
        >
          {GROUPS.map(({ group, items }) => (
            <div key={group}>
              <div style={{ padding: "6px 10px 2px", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: "#777" }}>{group}</div>
              {items.map((t) => (
                <button
                  key={t.key}
                  onClick={() => {
                    addTrackFromTemplate(t, authorId);
                    setOpen(false);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "5px 10px", background: "transparent", border: "none", color: "#ddd", cursor: "pointer", fontSize: 13 }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: t.color }} />
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
