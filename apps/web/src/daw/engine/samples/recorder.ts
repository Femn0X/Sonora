/**
 * Microphone recording for voice samples. All browser APIs are injectable, so the logic is testable without a
 * microphone. Permission, "no microphone" and "recording unsupported" are reported as readable errors.
 */

export class RecordError extends Error {}

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorderCtor?: typeof MediaRecorder;
}

export interface ActiveRecording {
  /** Stop recording and resolve with the audio. */
  stop(): Promise<Blob>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

export async function startRecording(deps: RecorderDeps = {}): Promise<ActiveRecording> {
  const getUserMedia = deps.getUserMedia ?? (typeof navigator !== "undefined" ? navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices) : undefined);
  const Recorder = deps.MediaRecorderCtor ?? (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!getUserMedia || !Recorder) throw new RecordError("Recording isn't supported in this browser (it needs HTTPS or localhost).");

  let stream: MediaStream;
  try {
    // Raw voice: the browser's speech processing would colour a sample you want to play as an instrument.
    stream = await getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new RecordError("Microphone access was blocked. Allow it in the browser's site settings and try again.");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new RecordError("No microphone was found.");
    throw new RecordError("Couldn't start the microphone.");
  }

  const recorder = new Recorder(stream);
  const chunks: Blob[] = [];
  let finished = false;
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const release = () => stream.getTracks().forEach((t) => t.stop()); // turn the microphone light off
  recorder.start();

  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        if (finished) return reject(new RecordError("Already stopped."));
        finished = true;
        recorder.onstop = () => {
          release();
          if (chunks.length === 0) reject(new RecordError("Nothing was recorded."));
          else resolve(new Blob(chunks, { type: recorder.mimeType || chunks[0].type || "audio/webm" }));
        };
        recorder.onerror = () => {
          release();
          reject(new RecordError("Recording failed."));
        };
        recorder.stop();
      }),
    cancel: () => {
      if (finished) return;
      finished = true;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* already inactive */
      }
      release();
    },
  };
}
