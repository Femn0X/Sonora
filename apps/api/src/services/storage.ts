/**
 * Thin abstraction over object storage. Kept deliberately narrow so swapping providers never touches
 * calling code, see ARCHITECTURE.md section 11.
 *
 * Drivers (STORAGE_DRIVER env var):
 *   - "file"   (default) JSON files on local disk under STORAGE_DIR. Survives server restarts, needs no setup.
 *   - "memory" in-process Map. Tests only: everything is lost when the server restarts (including every
 *              `tsx watch` reload), which silently breaks reopening and remixing saved projects.
 * An S3/R2/MinIO driver slots in behind the same interface for production.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ProjectManifest } from "@sonora/schema";

export interface StorageService {
  putJson(key: string, data: unknown): Promise<string /* url */>;
  getJson<T>(key: string): Promise<T>;
  signUploadUrl(key: string, contentType: string): Promise<string>;
  signDownloadUrl(key: string): Promise<string>;
}

export class InMemoryStorageService implements StorageService {
  private store = new Map<string, unknown>();

  async putJson(key: string, data: unknown): Promise<string> {
    this.store.set(key, data);
    return `mem://${key}`;
  }

  async getJson<T>(key: string): Promise<T> {
    const val = this.store.get(key);
    if (val === undefined) throw new Error(`Not found: ${key}`);
    return val as T;
  }

  async signUploadUrl(key: string): Promise<string> {
    return `mem://upload/${key}`;
  }

  async signDownloadUrl(key: string): Promise<string> {
    return `mem://download/${key}`;
  }
}

/** Stores each object as a file under `root`. Writes are atomic (temp file + rename), so a crash mid-write can't leave a half-written snapshot. */
export class FileStorageService implements StorageService {
  private root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Map a storage key to a file path, refusing anything that would escape the storage root. */
  private pathFor(key: string): string {
    if (!key || key.includes("\0") || key.includes("\\") || path.isAbsolute(key)) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    return file;
  }

  async putJson(key: string, data: unknown): Promise<string> {
    const file = this.pathFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(data));
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return `fs://${key}`;
  }

  async getJson<T>(key: string): Promise<T> {
    const file = this.pathFor(key);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Not found: ${key}. The saved data for this version is missing (projects created before persistent storage was added can't be recovered).`);
      }
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Stored data is corrupt: ${key}`);
    }
  }

  // Binary asset upload/download isn't implemented yet (assets route); these stay placeholders.
  async signUploadUrl(key: string): Promise<string> {
    return `fs://upload/${key}`;
  }

  async signDownloadUrl(key: string): Promise<string> {
    return `fs://download/${key}`;
  }
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageService {
  const driver = env.STORAGE_DRIVER ?? "file";
  if (driver === "memory") return new InMemoryStorageService();
  if (driver !== "file") throw new Error(`Unknown STORAGE_DRIVER "${driver}" (expected "file" or "memory")`);
  // Default: apps/api/.data/storage (this file is apps/api/src/services, or apps/api/dist/services once built)
  return new FileStorageService(env.STORAGE_DIR ?? path.resolve(__dirname, "../../.data/storage"));
}

export const storage: StorageService = createStorage();

export function manifestKey(projectId: string, versionId: string): string {
  return `projects/${projectId}/versions/${versionId}/manifest.json`;
}

export async function saveManifestSnapshot(
  projectId: string,
  versionId: string,
  manifest: ProjectManifest
): Promise<string> {
  return storage.putJson(manifestKey(projectId, versionId), manifest);
}

export async function loadManifestSnapshot(
  projectId: string,
  versionId: string
): Promise<ProjectManifest> {
  return storage.getJson<ProjectManifest>(manifestKey(projectId, versionId));
}
