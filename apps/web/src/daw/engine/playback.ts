import { useProjectStore } from "../state/projectStore";
import type { AudioEngine } from "./audioEngine";

/**
 * Playback controller: the single place that bridges the AudioEngine and the
 * UI store (play state, playhead animation). Both the top bar and the clip
 * editors' "play pattern" button call these, so there is exactly one
 * animation loop and one source of truth for "what is playing".
 */

let engine: AudioEngine | null = null;
let raf = 0;

export function setActiveEngine(next: AudioEngine | null) {
  if (engine && engine !== next) stopPlayback();
  engine = next;
}

export function getActiveEngine() {
  return engine;
}

function startPlayheadLoop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!engine) return;
    useProjectStore.getState().setPlayheadBeat(engine.transport.getCurrentBeat());
    if (engine.isPlaying) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

export async function togglePlay() {
  if (!engine) return;
  const store = useProjectStore.getState();
  if (engine.isPlaying) {
    engine.pause();
    cancelAnimationFrame(raf);
    store.setPlayheadBeat(engine.transport.getCurrentBeat());
    store.setPlaying(false);
    store.setPreviewClipId(null);
    return;
  }
  await engine.play();
  store.setPlaying(true);
  store.setPreviewClipId(null);
  startPlayheadLoop();
}

/** Pattern mode: loop one clip alone. Calling again for the same clip stops it. */
export async function togglePatternPlay(clipId: string) {
  if (!engine) return;
  const store = useProjectStore.getState();
  if (engine.isPlaying && engine.previewing === clipId) {
    stopPlayback();
    return;
  }
  await engine.playClip(clipId);
  store.setPlaying(true);
  store.setPreviewClipId(clipId);
  startPlayheadLoop();
}

export function stopPlayback() {
  const store = useProjectStore.getState();
  cancelAnimationFrame(raf);
  engine?.stop();
  store.setPlaying(false);
  store.setPreviewClipId(null);
  store.setPlayheadBeat(0);
}

export function seekTo(beat: number) {
  if (!engine) return;
  engine.seek(beat);
  useProjectStore.getState().setPlayheadBeat(Math.max(0, beat));
}

export function setLoopEnabled(enabled: boolean) {
  engine?.setLoopEnabled(enabled);
}

/** Preview a note (piano roll keys, drum pads, note placement). */
export function auditionNote(trackId: string, pitch: number, velocity = 100) {
  void engine?.auditionNote(trackId, pitch, velocity);
}
