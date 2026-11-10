import type { ProjectManifest } from "@sonora/schema";
import { LocalDb, type ProjectMeta } from "./localDb";

/**
 * Repository for browser-local project manifests.
 *
 * LocalDb handles IndexedDB transactions.
 * This class handles ProjectManifest mapping and metadata.
 */
export class LocalProjectRepository {
  constructor(private readonly db: LocalDb) {}

  /**
   * Save a project manifest and update its listing metadata.
   */
  async save(manifest: ProjectManifest): Promise<void> {
    const now = new Date().toISOString();

    const record: ProjectMeta & { manifest: ProjectManifest } = {
      id: manifest.projectId,
      title: manifest.title,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt || now,
      trackCount: manifest.tracks.length,
      manifest,
    };

    await this.db.putProject(record);
  }

  /**
   * Load a project by ID.
   */
  async load(projectId: string): Promise<ProjectManifest | null> {
    const record = await this.db.getProject(projectId);

    if (!record) return null;

    return record.manifest as ProjectManifest;
  }

  /**
   * List project metadata without loading complete manifests.
   */
  async list(): Promise<ProjectMeta[]> {
    return this.db.listProjects();
  }

  /**
   * Delete a project.
   */
  async delete(projectId: string): Promise<void> {
    await this.db.deleteProject(projectId);
  }

  /**
   * Check whether a project exists.
   */
  async exists(projectId: string): Promise<boolean> {
    const record = await this.db.getProject(projectId);
    return record !== null;
  }
}
