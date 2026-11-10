/**
 * The scheduler's heartbeat.
 *
 * The transport needs a tick every ~25ms. A plain setInterval on the page is throttled by browsers when
 * the tab is in the background (about once per second), which starves the 100ms lookahead window and makes
 * playback stutter as soon as you switch tabs. Timers inside a Web Worker are not throttled that way, so the
 * tick comes from a tiny worker that just posts a message on an interval.
 *
 * It degrades safely: no Worker support (SSR, tests, old browsers), a worker that can't be created (e.g. a
 * strict Content-Security-Policy), or a worker that errors at runtime all fall back to setInterval.
 */

export interface TickTimer {
  start(callback: () => void, intervalMs: number): void;
  stop(): void;
  dispose(): void;
}

/** The entire worker program. Exported so tests can run the real script. */
export const TICK_WORKER_SOURCE = `
let timer = null;
self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.cmd === "start") {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => self.postMessage("tick"), msg.interval);
  } else if (msg.cmd === "stop") {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
};
`;

class IntervalTimer implements TickTimer {
  private id: ReturnType<typeof setInterval> | null = null;
  start(callback: () => void, intervalMs: number) {
    this.stop();
    this.id = setInterval(callback, intervalMs);
  }
  stop() {
    if (this.id !== null) clearInterval(this.id);
    this.id = null;
  }
  dispose() {
    this.stop();
  }
}

class WorkerTimer implements TickTimer {
  private callback: (() => void) | null = null;
  private intervalMs = 25;
  private fallback: IntervalTimer | null = null;

  constructor(
    private worker: Worker,
    private release: () => void,
  ) {
    worker.onmessage = () => this.callback?.(); // a late tick after stop() has no callback and is ignored
    worker.onerror = () => {
      // The worker died or was blocked: keep the music playing on the main-thread timer instead.
      if (!this.fallback) {
        this.fallback = new IntervalTimer();
        if (this.callback) this.fallback.start(this.callback, this.intervalMs);
      }
    };
  }

  start(callback: () => void, intervalMs: number) {
    this.callback = callback;
    this.intervalMs = intervalMs;
    if (this.fallback) this.fallback.start(callback, intervalMs);
    else this.worker.postMessage({ cmd: "start", interval: intervalMs });
  }

  stop() {
    this.callback = null;
    this.fallback?.stop();
    this.worker.postMessage({ cmd: "stop" });
  }

  dispose() {
    this.stop();
    this.worker.terminate();
    this.release();
  }
}

export interface TimerEnvironment {
  Worker?: typeof Worker;
  Blob?: typeof Blob;
  URL?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
}

export function createTickTimer(env: TimerEnvironment = globalThis as unknown as TimerEnvironment): TickTimer {
  if (typeof env.Worker !== "function" || typeof env.Blob !== "function" || !env.URL?.createObjectURL) return new IntervalTimer();
  let url: string | null = null;
  try {
    url = env.URL.createObjectURL(new env.Blob([TICK_WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new env.Worker(url);
    const created = url;
    return new WorkerTimer(worker, () => env.URL!.revokeObjectURL(created));
  } catch {
    if (url) env.URL.revokeObjectURL(url);
    return new IntervalTimer();
  }
}
