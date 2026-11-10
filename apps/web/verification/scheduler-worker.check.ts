import { describe, it, expect } from "vitest";
import { Worker as NodeWorker } from "node:worker_threads";
import { createTickTimer, type TimerEnvironment } from "../src/daw/engine/schedulerTimer";

/**
 * Runs the REAL worker script in a REAL separate thread (via worker_threads, adapted to the browser Worker API).
 * This can't reproduce a browser's background-tab throttling, but it does verify the property the fix relies on:
 * the heartbeat is clocked on its own thread, so a busy main thread doesn't delay or merge its ticks.
 */
const sources = new Map<string, string>();
class ShimBlob { text: string; constructor(parts: string[]) { this.text = parts.join(""); } }
class ShimWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private w: NodeWorker;
  constructor(url: string) {
    const prelude = `const { parentPort } = require("node:worker_threads");
      globalThis.self = { postMessage: (m) => parentPort.postMessage(m), onmessage: null };
      parentPort.on("message", (d) => self.onmessage && self.onmessage({ data: d }));\n`;
    this.w = new NodeWorker(prelude + sources.get(url), { eval: true });
    this.w.on("message", (m) => this.onmessage?.({ data: m }));
    this.w.on("error", (e) => this.onerror?.(e));
  }
  postMessage(m: unknown) { this.w.postMessage(m); }
  terminate() { void this.w.terminate(); }
}
let n = 0;
const env = (): TimerEnvironment => ({
  Worker: ShimWorker as unknown as typeof Worker,
  Blob: ShimBlob as unknown as typeof Blob,
  URL: { createObjectURL: (b: any) => { const id = `blob:t${++n}`; sources.set(id, b.text); return id; }, revokeObjectURL: () => {} },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };

describe("tick worker (real thread)", () => {
  it("ticks at the requested cadence", async () => {
    const t = createTickTimer(env());
    let ticks = 0;
    t.start(() => ticks++, 25);
    await sleep(600);
    t.stop();
    console.log(`worker ticks in 600ms at 25ms: ${ticks} (ideal 24)`);
    expect(ticks).toBeGreaterThanOrEqual(15);
    expect(ticks).toBeLessThanOrEqual(26);
    t.dispose();
  });

  it("keeps its own clock while the main thread is blocked; setInterval cannot", async () => {
    const t = createTickTimer(env());
    let worker = 0, plain = 0;
    t.start(() => worker++, 25);
    const iv = setInterval(() => plain++, 25);
    await sleep(100); // let both warm up
    worker = 0; plain = 0;
    block(400); // a busy main thread (heavy render, GC, layout...)
    await sleep(5); // yield: deliver whatever queued up during the block
    clearInterval(iv);
    t.stop();
    console.log(`during a 400ms main-thread block  ->  worker ticks queued: ${worker}   setInterval callbacks: ${plain}`);
    expect(worker).toBeGreaterThanOrEqual(10); // ~16 ticks happened on the worker's own clock
    expect(plain).toBeLessThanOrEqual(2); // setInterval can only fire once, late, after the block
    t.dispose();
  });

  it("stop() really stops, restart works, and dispose ends the thread", async () => {
    const t = createTickTimer(env());
    let ticks = 0;
    t.start(() => ticks++, 20);
    await sleep(120);
    t.stop();
    await sleep(30); // let in-flight messages drain
    const atStop = ticks;
    await sleep(200);
    expect(ticks).toBe(atStop);
    t.start(() => ticks++, 20);
    await sleep(120);
    expect(ticks).toBeGreaterThan(atStop);
    t.dispose();
  });
});
