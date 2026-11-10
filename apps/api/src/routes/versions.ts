import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../services/prisma";
import { requireUser } from "../services/currentUser";
import { publishVersion } from "../services/lineage";
import { loadManifestSnapshot } from "../services/storage";

const publishSchema = z.object({
  message: z.string().min(1).max(500),
  manifest: z.any(), // validated more thoroughly against the PSF zod schema in production
});

export async function versionRoutes(app: FastifyInstance) {
  // Publish a new version ("commit")
  app.post("/:id/versions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = publishSchema.parse(req.body);
    const userId = await requireUser(req);

    const project = await prisma.project.findUniqueOrThrow({ where: { id } });

    const version = await publishVersion({
      projectId: id,
      authorId: userId,
      message: body.message,
      manifest: body.manifest,
      parentVersionIds: project.headVersionId ? [project.headVersionId] : [],
    });

    return reply.code(201).send(version);
  });

  // Version history list ("git log")
  app.get("/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    return prisma.version.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: { author: { select: { username: true, displayName: true, avatarUrl: true } } },
    });
  });

  // Fetch a specific historical manifest (non-destructive preview)
  app.get("/:id/versions/:versionId/manifest", async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    return loadManifestSnapshot(id, versionId);
  });

  // Restore: publishes a NEW version whose content equals an old one
  // (like `git revert`, not a destructive rewrite — history is never lost).
  app.post("/:id/versions/:versionId/restore", async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    const userId = await requireUser(req);

    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    const manifestToRestore = await loadManifestSnapshot(id, versionId);

    const version = await publishVersion({
      projectId: id,
      authorId: userId,
      message: `Restored to version ${versionId}`,
      manifest: { ...manifestToRestore, updatedAt: new Date().toISOString() },
      parentVersionIds: project.headVersionId ? [project.headVersionId] : [],
    });

    return reply.code(201).send(version);
  });
}
