import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { projectRoutes } from "./routes/projects";
import { versionRoutes } from "./routes/versions";
import { assetRoutes } from "./routes/assets";

/**
 * Builds the API server WITHOUT starting it, so tests can drive the real routes, error handler and CORS setup
 * with `app.inject(...)`. server.ts is the thin wrapper that calls this and listens on a port.
 */
export async function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  /**
   * Global error handler. Without this, a plain `throw new Error(...)` from
   * services/lineage.ts (e.g. the no_remix license check) or a Prisma
   * "not found" would surface as an opaque 500. Mapping them here means every
   * thrown Error's `.message` reaches the client as clean JSON — which is
   * exactly what apps/web/src/lib/api.ts's apiFetch already expects and
   * surfaces directly in the UI (see RemixButton's error state).
   */
  app.setErrorHandler((error, _req, reply) => {
    if (error.validation) {
      reply.code(400).send({ message: error.message, error: "Bad Request", statusCode: 400 });
      return;
    }
    // Prisma's "record not found" errors (P2025) and our own findUniqueOrThrow
    // calls map to 404; everything else defaults to 400 rather than a bare 500,
    // since most thrown errors in this codebase are validation/permission
    // errors (e.g. "This project's license does not permit remixing.").
    const isNotFound = (error as any).code === "P2025" || /no .* found|not found/i.test(error.message);
    const status = isNotFound ? 404 : (error.statusCode ?? 400);
    reply.code(status).send({ message: error.message, error: error.name, statusCode: status });
  });

  await app.register(cors, { origin: true });

  app.get("/", async () => ({
    name: "Sonora API",
    status: "ok",
    health: "/health",
    api: "/api/v1",
  }));

  app.get("/health", async () => ({ ok: true }));

  await app.register(projectRoutes, { prefix: "/api/v1/projects" });
  await app.register(versionRoutes, { prefix: "/api/v1/projects" });
  await app.register(assetRoutes, { prefix: "/api/v1/assets" });

  return app;
}
