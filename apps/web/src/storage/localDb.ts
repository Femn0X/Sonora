/**
 * Browser-local storage (IndexedDB): the web app's database. Songs, their audio samples and installed extensions
 * live in the user's browser, so Sonora works with no server, no account and no setup.
 *
 * Stores:
 *   projects   full project manifests              (key: id)
 *   meta       small records for the project list  (key: id), so listing never loads every manifest
 *   samples    imported/recorded audio             (key: content-hash id)
 *   extensions installed extension packages        (key: id)
 *
 * The IndexedDB factory is injectable so the whole layer is tested against fake-indexeddb.
 */

export const DB_NAME = "sonora";
export const DB_VERSION = 1;

export class StorageError extends Error {}

export interface ProjectMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  trackCount: number;
}
export interface ProjectRecord extends ProjectMeta {
  manifest: unknown;
}
export interface SampleRecord {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  addedAt: string;
}
export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  kind: string;
  /** The full package JSON (manifest + code) exactly as installed */
  pkg: unknown;
  installedAt: string;
}

type Store = "projects" | "meta" | "samples" | "extensions";

/** Turn a low-level IndexedDB failure into something a person can act on. */
function friendly(error: unknown): StorageError {
  const name = (error as { name?: string })?.name;
  if (name === "QuotaExceededError") return new StorageError("Your browser's storage is full. Delete some songs or samples and try again.");
  if (name === "InvalidStateError" || name === "SecurityError") return new StorageError("This browser isn't allowing local storage (private mode or blocked site data?). Songs can't be saved here.");
  if (error instanceof StorageError) return error;
  return new StorageError(`Local storage failed: ${(error as Error)?.message ?? "unknown error"}`);
}

export class LocalDb {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new StorageError("This browser doesn't support local storage (IndexedDB)."));
    this.dbPromise ??= new Promise((resolve, reject) => {
      const request = this.factory!.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ["projects", "meta", "samples", "extensions"] as Store[]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          // another tab upgraded the schema: close so it isn't blocked
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(friendly(request.error));
      request.onblocked = () => reject(new StorageError("Close other Sonora tabs and reload."));
    });
    this.dbPromise.catch(() => (this.dbPromise = null)); // allow a retry after a failed open
    return this.dbPromise;
  }

  /** Run `work` inside ONE transaction over `stores`, resolving when the transaction COMMITS (not just when requests finish). */
  private async tx<T>(stores: Store[], mode: IDBTransactionMode, work: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let result: T;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(stores, mode);
      } catch (e) {
        return reject(friendly(e));
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(friendly(transaction.error));
      transaction.onabort = () => reject(friendly(transaction.error));
      Promise.resolve(work(transaction)).then((r) => (result = r), (e) => {
        try { transaction.abort(); } catch { /* already finished */ }
        reject(friendly(e));
      });
    });
  }

  private static req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  // --- projects -------------------------------------------------------------------------------------------

  /** Save the manifest and its list entry atomically (a crash can't leave one without the other). */
  putProject(record: ProjectRecord): Promise<void> {
    const { manifest, ...meta } = record;
    return this.tx(["projects", "meta"], "readwrite", async (t) => {
      await LocalDb.req(t.objectStore("projects").put({ id: record.id, manifest }));
      await LocalDb.req(t.objectStore("meta").put(meta));
    });
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return this.tx(["projects", "meta"], "readonly", async (t) => {
      const body = (await LocalDb.req(t.objectStore("projects").get(id))) as { manifest: unknown } | undefined;
      const meta = (await LocalDb.req(t.objectStore("meta").get(id))) as ProjectMeta | undefined;
      return body && meta ? { ...meta, manifest: body.manifest } : null;
    });
  }

  async listProjects(): Promise<ProjectMeta[]> {
    const all = await this.tx(["meta"], "readonly", (t) => LocalDb.req(t.objectStore("meta").getAll()) as Promise<ProjectMeta[]>);
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  deleteProject(id: string): Promise<void> {
    return this.tx(["projects", "meta"], "readwrite", async (t) => {
      await LocalDb.req(t.objectStore("projects").delete(id));
      await LocalDb.req(t.objectStore("meta").delete(id));
    });
  }

  // --- samples --------------------------------------------------------------------------------------------

  putSample(record: SampleRecord): Promise<void> {
    return this.tx(["samples"], "readwrite", async (t) => void (await LocalDb.req(t.objectStore("samples").put(record))));
  }
  getSample(id: string): Promise<SampleRecord | null> {
    return this.tx(["samples"], "readonly", async (t) => ((await LocalDb.req(t.objectStore("samples").get(id))) as SampleRecord | undefined) ?? null);
  }
  listSamples(): Promise<SampleRecord[]> {
    return this.tx(["samples"], "readonly", (t) => LocalDb.req(t.objectStore("samples").getAll()) as Promise<SampleRecord[]>);
  }
  deleteSample(id: string): Promise<void> {
    return this.tx(["samples"], "readwrite", async (t) => void (await LocalDb.req(t.objectStore("samples").delete(id))));
  }

  // --- extensions -----------------------------------------------------------------------------------------

  putExtension(record: ExtensionRecord): Promise<void> {
    return this.tx(["extensions"], "readwrite", async (t) => void (await LocalDb.req(t.objectStore("extensions").put(record))));
  }
  listExtensions(): Promise<ExtensionRecord[]> {
    return this.tx(["extensions"], "readonly", (t) => LocalDb.req(t.objectStore("extensions").getAll()) as Promise<ExtensionRecord[]>);
  }
  deleteExtension(id: string): Promise<void> {
    return this.tx(["extensions"], "readwrite", async (t) => void (await LocalDb.req(t.objectStore("extensions").delete(id))));
  }

  close() {
    void this.dbPromise?.then((db) => db.close());
    this.dbPromise = null;
  }
}
