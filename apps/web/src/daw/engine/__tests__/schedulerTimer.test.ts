import { describe, it, expect, vi, afterEach } from "vitest";
import { createTickTimer, TICK_WORKER_SOURCE, type TimerEnvironment, type TickTimer } from "../schedulerTimer";
import { Transport } from "../transport";

afterEach(() => vi.useRealTimers());

/** A scriptable stand-in for a browser Worker */
function fakeEnv(opts: { workerThrows?: boolean } = {}) {
  const log = { created: 0, posted: [] as unknown[], terminated: 0, revoked: [] as string[], blobParts: [] as unknown[][] };
  class FakeWorker {
    static instance!: FakeWorker;
    onmessage: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
      if (opts.workerThrows) throw new Error("blocked by CSP");
      log.created++;
      FakeWorker.instance = this;
    }
    postMessage(m: unknown) { log.posted.push(m); }
    terminate() { log.terminated++; }
  }
  class FakeBlob { constructor(parts: unknown[]) { log.blobParts.push(parts); } }
  const env = {
    Worker: FakeWorker as unknown as typeof Worker,
    Blob: FakeBlob as unknown as typeof Blob,
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: (u: string) => log.revoked.push(u) },
  } as TimerEnvironment;
  return {
    env,
    log,
    worker: () => FakeWorker.instance,
    tick: () => FakeWorker.instance.onmessage?.({ data: "tick" }),
  };
}

describe("createTickTimer", () => {
  it("falls back to setInterval when there is no Worker (SSR / tests / old browsers)", () => {
    vi.useFakeTimers();
    const timer = createTickTimer({});
    const cb = vi.fn();
    timer.start(cb, 25);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(4);
    timer.stop();
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(4);
    timer.dispose();
  });

  it("runs the heartbeat in a worker: start/stop are posted, ticks call back, the real script is what gets loaded", () => {
    const f = fakeEnv();
    const timer = createTickTimer(f.env);
    expect(f.log.created).toBe(1);
    expect(f.log.blobParts[0]).toEqual([TICK_WORKER_SOURCE]);
    const cb = vi.fn();
    timer.start(cb, 25);
    expect(f.log.posted).toEqual([{ cmd: "start", interval: 25 }]);
    f.tick(); f.tick(); f.tick();
    expect(cb).toHaveBeenCalledTimes(3);
    timer.stop();
    expect(f.log.posted.at(-1)).toEqual({ cmd: "stop" });
  });

  it("ignores a tick that arrives after stop() (messages already in flight must not schedule audio)", () => {
    const f = fakeEnv();
    const timer = createTickTimer(f.env);
    const cb = vi.fn();
    timer.start(cb, 25);
    f.tick();
    timer.stop();
    f.tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("restarting replaces the callback (no double-ticking)", () => {
    const f = fakeEnv();
    const timer = createTickTimer(f.env);
    const a = vi.fn(), b = vi.fn();
    timer.start(a, 25);
    timer.stop();
    timer.start(b, 25);
    f.tick();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("dispose terminates the worker and releases the blob URL", () => {
    const f = fakeEnv();
    const timer = createTickTimer(f.env);
    timer.start(() => {}, 25);
    timer.dispose();
    expect(f.log.terminated).toBe(1);
    expect(f.log.revoked).toEqual(["blob:fake"]);
  });

  it("falls back to setInterval if the worker can't be created (e.g. strict CSP), and releases the blob URL", () => {
    vi.useFakeTimers();
    const f = fakeEnv({ workerThrows: true });
    const timer = createTickTimer(f.env);
    expect(f.log.revoked).toEqual(["blob:fake"]);
    const cb = vi.fn();
    timer.start(cb, 25);
    vi.advanceTimersByTime(50);
    expect(cb).toHaveBeenCalledTimes(2);
    timer.dispose();
  });

  it("if the worker errors while running, the music keeps playing on the main-thread timer", () => {
    vi.useFakeTimers();
    const f = fakeEnv();
    const timer = createTickTimer(f.env);
    const cb = vi.fn();
    timer.start(cb, 25);
    f.worker().onerror?.({});
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(4);
    timer.stop();
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(4);
    // and a later start() after the failure goes straight to the fallback
    timer.start(cb, 25);
    vi.advanceTimersByTime(50);
    expect(cb).toHaveBeenCalledTimes(6);
    timer.dispose();
  });
});

describe("Transport uses the injected heartbeat", () => {
  function fakeTimer() {
    const t = { cb: null as null | (() => void), starts: 0, stops: 0, disposed: 0, interval: 0 } as {
      cb: null | (() => void); starts: number; stops: number; disposed: number; interval: number;
    };
    const timer: TickTimer = {
      start: (cb, ms) => { t.cb = cb; t.starts++; t.interval = ms; },
      stop: () => { t.stops++; t.cb = null; },
      dispose: () => { t.disposed++; },
    };
    return { t, timer };
  }

  it("ticks at 25ms, stops on pause/stop, reuses ONE timer across plays, and releases it on dispose", () => {
    const { t, timer } = fakeTimer();
    const factory = vi.fn(() => timer);
    const clock = { currentTime: 0 };
    const tr = new Transport(clock, factory);
    const windows: number[] = [];
    tr.play(0, (from) => windows.push(from));
    expect(t.interval).toBe(25);
    clock.currentTime += 0.05;
    t.cb!();
    expect(windows.length).toBeGreaterThan(1);
    tr.pause();
    expect(t.stops).toBe(1);
    tr.play(0, () => {});
    tr.stop();
    expect(factory).toHaveBeenCalledTimes(1); // created lazily, once
    expect(t.starts).toBe(2);
    tr.dispose();
    expect(t.disposed).toBe(1);
    expect(() => tr.dispose()).not.toThrow();
  });

  it("a stray tick after the transport stopped does nothing", () => {
    const { t, timer } = fakeTimer();
    const clock = { currentTime: 0 };
    const tr = new Transport(clock, () => timer);
    const spy = vi.fn();
    tr.play(0, spy);
    const cb = t.cb!;
    tr.stop();
    spy.mockClear();
    clock.currentTime += 1;
    cb(); // an in-flight worker message delivered late
    expect(spy).not.toHaveBeenCalled();
  });
});
