"use client";

/**
 * Shown instead of the Save button when the workspace isn't backed by a saved project.
 *
 * Two very different situations look the same from the outside (the demo workspace appears), so say which:
 *  - the built-in demo (/daw/demo-project): expected, nothing went wrong
 *  - a REAL project that failed to load: show why, otherwise "create a project" is misleading advice
 *    (the user just did) and the failure looks like "new song doesn't work".
 */
export function DemoBanner({ loadError }: { loadError: string | null }) {
  const style: React.CSSProperties = { color: "#e0a83e", fontSize: 12, border: "1px solid #6b5a2a", padding: "4px 8px", borderRadius: 6, maxWidth: 520 };
  if (loadError) {
    return (
      <span role="alert" style={{ ...style, color: "#ff9a7a", borderColor: "#7a3a2a" }}>
        ⚠ Couldn’t load this project: {loadError} Showing a local demo instead; nothing here is saved.
      </span>
    );
  }
  return <span style={style}>⚠ Demo project — not saved. Create a project from the home page to persist and remix it.</span>;
}
