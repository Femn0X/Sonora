/**
 * Sample library: decoded audio the Sampler plays, keyed by a CONTENT HASH.
 *
 * Content-addressing matters for a collaboration tool: the same recording gets the same id on every machine, so a
 * project that references a sample by id still resolves it after being shared, forked or re-imported, and importing
 * the same file twice never stores it twice. Projects only ever store the id (and a display name), never the audio.
 *
 * Limits protect the browser from huge or hostile files (a tiny compressed file can decode to gigabytes of PCM).
 */

export const MAX_SAMPLE_BYTES = 30 * 1024 * 1024;
export const MAX_SAMPLE_SECONDS = 180;

export interface SampleInfo {
  id: string;
  name: string;
  buffer: AudioBuffer;
  /** The original file bytes, kept so the sample can be persisted and re-decoded later */
  bytes: ArrayBuffer;
}

export class SampleError extends Error {}

type Listener = () => void;

export class SampleLibrary {
  private samples = new Map<string, SampleInfo>();
  private listeners = new Set<Listener>();

  register(info: SampleInfo) {
    this.samples.set(info.id, info);
    this.emit();
  }
  get(id: string): SampleInfo | undefined {
    return this.samples.get(id);
  }
  has(id: string) {
    return this.samples.has(id);
  }
  list(): SampleInfo[] {
    return [...this.samples.values()];
  }
  remove(id: string) {
    if (this.samples.delete(id)) this.emit();
  }
  clear() {
    this.samples.clear();
    this.emit();
  }
  /** Subscribe to changes (for UI). Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
}

export const sampleLibrary = new SampleLibrary();

/** Stable id for some bytes: the first 128 bits of their SHA-256, as hex. */
export async function sampleIdForBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Decoder = (bytes: ArrayBuffer) => Promise<AudioBuffer>;

/** Decode with a throwaway OfflineAudioContext (works without a user gesture, unlike a real AudioContext). */
export const browserDecoder: Decoder = (bytes) => {
  const Ctor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) throw new SampleError("This browser can't decode audio.");
  return new Ctor(1, 1, 44100).decodeAudioData(bytes);
};

/** A friendly display name from a file name ("My Take 3.wav" -> "My Take 3"). */
export function sampleDisplayName(fileName: string): string {
  // eslint-disable-next-line no-control-regex -- Strip non-printing characters from imported file names.
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[\u0000-\u001f]/g, "").trim();
  return (base || "Sample").slice(0, 60);
}

/**
 * Validate, decode and register audio bytes. Throws SampleError with a message fit for the UI.
 * Importing the same bytes again returns the existing entry.
 */
export async function importSample(bytes: ArrayBuffer, fileName: string, decode: Decoder = browserDecoder, library: SampleLibrary = sampleLibrary): Promise<SampleInfo> {
  if (bytes.byteLength === 0) throw new SampleError("That file is empty.");
  if (bytes.byteLength > MAX_SAMPLE_BYTES) throw new SampleError(`That file is ${(bytes.byteLength / 1048576).toFixed(0)} MB; samples are limited to ${MAX_SAMPLE_BYTES / 1048576} MB.`);

  const id = await sampleIdForBytes(bytes);
  const existing = library.get(id);
  if (existing) return existing;

  let buffer: AudioBuffer;
  try {
    buffer = await decode(bytes.slice(0)); // decodeAudioData detaches its input, so give it a copy
  } catch {
    throw new SampleError("Couldn't read that audio file. Try WAV, MP3, OGG or M4A.");
  }
  if (!(buffer.duration > 0)) throw new SampleError("That audio file has no sound in it.");
  if (buffer.duration > MAX_SAMPLE_SECONDS) throw new SampleError(`That sample is ${Math.round(buffer.duration)} s long; the limit is ${MAX_SAMPLE_SECONDS} s.`);

  const info: SampleInfo = { id, name: sampleDisplayName(fileName), buffer, bytes };
  library.register(info);
  return info;
}
