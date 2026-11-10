import { LocalDb } from "./localDb";
import { LocalProjectRepository } from "./localProjects";

/** The app-wide repository (one IndexedDB connection). Browser only: call from effects/handlers, never during render on the server. */
let repo: LocalProjectRepository | null = null;
export function getLocalRepo(): LocalProjectRepository {
  repo ??= new LocalProjectRepository(new LocalDb());
  return repo;
}
