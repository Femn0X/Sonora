import type { ProjectManifest } from "@sonora/schema";

/**
 * Debounced autosave. Changes are coalesced (the latest manifest wins); a save that's already running is never
 * interrupted, and anything that changed meanwhile is saved right after it. A failed save is kept as pending and
 * retried on the next change or flush, so a transient error never silently loses work.
 */
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface AutosaverOptions {
  delayMs?: number;
  onStatus?: (status: SaveStatus, error?: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class Autosaver {
  private pending: ProjectManifest | null = null;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private disposed = false;
  status: SaveStatus = "idle";
  lastError: string | null = null;

  constructor(private save: (m: ProjectManifest) => Promise<void>, private opts: AutosaverOptions = {}) {}

  private set(status: SaveStatus, error?: string) {
    this.status = status;
    this.lastError = error ?? null;
    this.opts.onStatus?.(status, error);
  }

  schedule(manifest: ProjectManifest) {
    if (this.disposed) return;
    this.pending = manifest;
    if (this.status !== "saving") this.set("dirty");
    const clear = this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const start = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    if (this.timer !== null) clear(this.timer);
    this.timer = start(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.delayMs ?? 1200);
  }

  /** Save now. Resolves when everything pending has been written (or has failed). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running; // let the in-flight save finish, then save what changed since
      if (this.pending && !this.disposed) return this.flush();
      return;
    }
    if (!this.pending) return;
    const manifest = this.pending;
    this.pending = null;
    this.set("saving");
    this.running = this.save(manifest)
      .then(() => this.set(this.pending ? "dirty" : "saved"))
      .catch((e: unknown) => {
        if (!this.pending) this.pending = manifest; // keep it for a retry; a newer change would supersede it
        this.set("error", e instanceof Error ? e.message : "Couldn't save.");
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
    if (this.pending && this.status !== "error" && !this.disposed) return this.flush();
  }

  get hasPending() {
    return this.pending !== null;
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) (this.opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}
