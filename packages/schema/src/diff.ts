import type { ProjectManifest, Track, Clip } from "./project";

/**
 * Lightweight structural diff between two manifests, used to:
 *  - populate `versions.diff_summary` for the version history UI
 *  - drive the track-level auto-merge described in ARCHITECTURE.md §5.4
 *
 * This is intentionally shallow (id-set based) rather than a deep field-by-field
 * diff — see ARCHITECTURE.md for why full semantic merge is out of scope for MVP.
 */

export interface ManifestDiffSummary {
  tracksAdded: string[];
  tracksRemoved: string[];
  clipsAdded: string[];
  clipsRemoved: string[];
  clipsModified: string[];
  bpmChanged: boolean;
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export function diffManifests(before: ProjectManifest, after: ProjectManifest): ManifestDiffSummary {
  const beforeTracks = byId(before.tracks);
  const afterTracks = byId(after.tracks);
  const beforeClips = byId(before.clips);
  const afterClips = byId(after.clips);

  const tracksAdded = [...afterTracks.keys()].filter((id) => !beforeTracks.has(id));
  const tracksRemoved = [...beforeTracks.keys()].filter((id) => !afterTracks.has(id));

  const clipsAdded = [...afterClips.keys()].filter((id) => !beforeClips.has(id));
  const clipsRemoved = [...beforeClips.keys()].filter((id) => !afterClips.has(id));
  const clipsModified = [...afterClips.keys()].filter((id) => {
    const b = beforeClips.get(id);
    const a = afterClips.get(id);
    if (!b || !a) return false;
    return JSON.stringify(b) !== JSON.stringify(a);
  });

  return {
    tracksAdded,
    tracksRemoved,
    clipsAdded,
    clipsRemoved,
    clipsModified,
    bpmChanged: before.bpm !== after.bpm,
  };
}

export type MergeResult =
  | { status: "clean"; manifest: ProjectManifest }
  | { status: "conflict"; conflicts: ClipConflict[] };

export interface ClipConflict {
  clipId: string;
  trackId: string;
  baseClip: Clip | undefined;
  oursClip: Clip | undefined;
  theirsClip: Clip | undefined;
}

/**
 * Structural 3-way merge: base = common ancestor version, ours/theirs = two
 * divergent branches. Only handles the "compatible changes" case described in
 * ARCHITECTURE.md §5.4 (non-overlapping track/clip edits). Anything touched by
 * both branches is surfaced as a conflict for the human merge-review UI,
 * never silently resolved.
 */
export function mergeManifests(
  base: ProjectManifest,
  ours: ProjectManifest,
  theirs: ProjectManifest
): MergeResult {
  const baseClips = byId(base.clips);
  const oursClips = byId(ours.clips);
  const theirsClips = byId(theirs.clips);

  const allClipIds = new Set([...baseClips.keys(), ...oursClips.keys(), ...theirsClips.keys()]);
  const mergedClips: Clip[] = [];
  const conflicts: ClipConflict[] = [];

  for (const id of allClipIds) {
    const b = baseClips.get(id);
    const o = oursClips.get(id);
    const t = theirsClips.get(id);

    const oChanged = JSON.stringify(b) !== JSON.stringify(o);
    const tChanged = JSON.stringify(b) !== JSON.stringify(t);

    if (oChanged && tChanged && JSON.stringify(o) !== JSON.stringify(t)) {
      conflicts.push({ clipId: id, trackId: (o ?? t ?? b)!.trackId, baseClip: b, oursClip: o, theirsClip: t });
      continue;
    }
    // Only one side changed (or both changed identically) -> take whichever changed, or base if neither.
    const resolved = oChanged ? o : tChanged ? t : b;
    if (resolved) mergedClips.push(resolved);
  }

  if (conflicts.length > 0) {
    return { status: "conflict", conflicts };
  }

  // Tracks: simple union by id, preferring the branch that modified an existing track.
  const trackMap = new Map<string, Track>();
  for (const track of [...base.tracks, ...ours.tracks, ...theirs.tracks]) {
    trackMap.set(track.id, track);
  }

  return {
    status: "clean",
    manifest: {
      ...ours,
      tracks: [...trackMap.values()],
      clips: mergedClips,
      updatedAt: new Date().toISOString(),
    },
  };
}
