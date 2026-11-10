/**
 * Project Source Format (PSF) — v1.0
 *
 * These types are the canonical, shared definition of a Sonora project's
 * structural data. They are used by:
 *   - the web app (DAW editing, serialization)
 *   - the API (validation, diffing, version snapshots)
 *   - workers (rendering, migration)
 *
 * Design rules (see ARCHITECTURE.md §4):
 *  - Everything here is plain JSON-serializable (no functions, no class instances)
 *    so it can be diffed, stored, and transmitted without special handling.
 *  - Binary data is NEVER embedded — always referenced via AssetRef (content hash).
 *  - Every editable object carries authorId so per-track/clip attribution works.
 */

export const PSF_SCHEMA_VERSION = "1.0" as const;

export type Uuid = string;
export type Sha256Hash = string;
export type IsoDateTime = string;

// ---------------------------------------------------------------------------
// Assets (content-addressed, deduplicated)
// ---------------------------------------------------------------------------

export interface AssetRef {
  /** SHA-256 of the file content. Primary key in the `assets` table/store. */
  hash: Sha256Hash;
  sizeBytes: number;
  mimeType: string;
  originalFilename: string;
  /** e.g. "splice:sp_1234" — lets the UI say "from Splice pack X" instead of just "missing" */
  sourceLibrary?: string;
}

// ---------------------------------------------------------------------------
// Tempo / time signature
// ---------------------------------------------------------------------------

export interface TempoChange {
  /** Position in beats from project start */
  beat: number;
  bpm: number;
}

export interface TimeSignatureChange {
  beat: number;
  numerator: number;
  denominator: number;
}

export interface Marker {
  beat: number;
  label: string;
  color?: string;
}

// ---------------------------------------------------------------------------
// MIDI
// ---------------------------------------------------------------------------

export interface MidiNote {
  id: Uuid;
  /** Start position within the clip, in beats */
  startBeat: number;
  lengthBeats: number;
  /** MIDI note number, 0-127 */
  pitch: number;
  /** 0-127 */
  velocity: number;
  /** Optional per-note modulation (e.g., pitch bend curve), kept minimal for MVP */
  muted?: boolean;
}

export interface MidiClip {
  id: Uuid;
  type: "midi";
  trackId: Uuid;
  startBeat: number;
  lengthBeats: number;
  loop?: { enabled: boolean; lengthBeats: number };
  notes: MidiNote[];
  instrumentId: Uuid;
  authorId: Uuid;
  createdAt: IsoDateTime;
  color?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface FadeCurve {
  lengthBeats: number;
  shape: "linear" | "exponential" | "logarithmic" | "sCurve";
}

export interface AudioClip {
  id: Uuid;
  type: "audio";
  trackId: Uuid;
  startBeat: number;
  lengthBeats: number;
  /** Reference into the asset store — never inline audio data */
  assetHash: Sha256Hash;
  /** Offset into the source asset, in seconds, where playback starts */
  sourceOffsetSeconds: number;
  gainDb: number;
  fadeIn?: FadeCurve;
  fadeOut?: FadeCurve;
  /** Time-stretch / warp info, kept simple for MVP (ratio-based) */
  warp?: { mode: "none" | "stretch"; ratio: number };
  authorId: Uuid;
  createdAt: IsoDateTime;
  color?: string;
  name?: string;
}

export type Clip = MidiClip | AudioClip;

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

export interface AutomationPoint {
  beat: number;
  value: number; // normalized 0-1, mapped to the target param's range by the engine
  curve?: "linear" | "hold" | "smooth";
}

export interface AutomationLane {
  id: Uuid;
  trackId: Uuid;
  /** e.g. "volume", "pan", "insert:reverb:mix" */
  targetParam: string;
  points: AutomationPoint[];
  authorId: Uuid;
}

// ---------------------------------------------------------------------------
// Instruments / effects (with graceful-degradation fields — see ARCHITECTURE §7)
// ---------------------------------------------------------------------------

export interface InstrumentRef {
  id: Uuid;
  /** e.g. "sonora.sampler", "sonora.subtractive-synth", or a future native VST id */
  pluginId: string;
  pluginType: "builtin" | "native-vst" | "native-au";
  version: string;
  isBuiltIn: boolean;
  /** Opaque preset payload for the plugin — preserved even if the plugin is unavailable */
  presetData: Record<string, unknown>;
  displayName: string;
}

export interface EffectInsert {
  id: Uuid;
  pluginId: string;
  pluginType: "builtin" | "native-vst" | "native-au";
  isBuiltIn: boolean;
  presetData: Record<string, unknown>;
  bypassed: boolean;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Tracks & Mixer
// ---------------------------------------------------------------------------

export interface SendRoute {
  targetTrackId: Uuid;
  amountDb: number;
}

export interface MixerStrip {
  trackId: Uuid;
  volumeDb: number;
  pan: number; // -1..1
  muted: boolean;
  soloed: boolean;
  inserts: EffectInsert[];
  sends: SendRoute[];
}

export interface Track {
  id: Uuid;
  name: string;
  type: "midi" | "audio" | "bus";
  color: string;
  orderIndex: number;
  authorId: Uuid;
  /** For midi tracks, which instrument plays its clips */
  instrumentId?: Uuid;
}

export interface Mixer {
  strips: MixerStrip[];
  masterInserts: EffectInsert[];
  masterVolumeDb: number;
}

// ---------------------------------------------------------------------------
// Project origin (fork/remix lineage) — see ARCHITECTURE §5
// ---------------------------------------------------------------------------

export type ProjectOriginType =
  | "original"
  | "fork"
  | "remix"
  | "edit"
  | "bootleg"
  | "alt_version";

export type ProjectLicense =
  | "no_remix"
  | "remix_allowed"
  | "remix_with_attribution"
  | "remix_commercial"
  | "cc_by"
  | "cc_by_sa"
  | "cc_by_nc";

export interface ProjectOrigin {
  type: ProjectOriginType;
  parentProjectId: Uuid;
  parentVersionId: Uuid;
}

// ---------------------------------------------------------------------------
// Top-level project manifest
// ---------------------------------------------------------------------------

export interface ProjectManifest {
  schemaVersion: typeof PSF_SCHEMA_VERSION;
  projectId: Uuid;
  title: string;
  bpm: number;
  tempoMap: TempoChange[];
  timeSignature: [number, number];
  timeSignatureMap: TimeSignatureChange[];
  keySignature?: string;
  sampleRate: number;
  markers: Marker[];
  tracks: Track[];
  clips: Clip[];
  automation: AutomationLane[];
  instruments: InstrumentRef[];
  mixer: Mixer;
  origin?: ProjectOrigin;
  license: ProjectLicense;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createBlankManifest(params: {
  projectId: Uuid;
  title: string;
  authorId: Uuid;
  bpm?: number;
}): ProjectManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: PSF_SCHEMA_VERSION,
    projectId: params.projectId,
    title: params.title,
    bpm: params.bpm ?? 120,
    tempoMap: [{ beat: 0, bpm: params.bpm ?? 120 }],
    timeSignature: [4, 4],
    timeSignatureMap: [{ beat: 0, numerator: 4, denominator: 4 }],
    sampleRate: 48000,
    markers: [],
    tracks: [],
    clips: [],
    automation: [],
    instruments: [],
    mixer: { strips: [], masterInserts: [], masterVolumeDb: 0 },
    license: "remix_with_attribution",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Creates a copy-on-fork manifest: deep clone + reset ids that must be unique
 * to the new project, while preserving track/clip/author history so
 * per-object attribution survives into the remix.
 */
export function forkManifest(
  parent: ProjectManifest,
  params: { newProjectId: Uuid; parentVersionId: Uuid; originType: ProjectOriginType; newTitle: string }
): ProjectManifest {
  const now = new Date().toISOString();
  return {
    ...structuredClone(parent),
    projectId: params.newProjectId,
    title: params.newTitle,
    origin: {
      type: params.originType,
      parentProjectId: parent.projectId,
      parentVersionId: params.parentVersionId,
    },
    // License propagates forward for copyleft-style licenses; enforced again server-side.
    createdAt: now,
    updatedAt: now,
  };
}
