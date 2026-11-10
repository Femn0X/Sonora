import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../services/prisma";
import { requireUser } from "../services/currentUser";
import { forkProject, getProjectLineage, publishVersion } from "../services/lineage";
import { createBlankManifest } from "@sonora/schema";

const createProjectSchema = z.object({
  title: z.string().min(1).max(200),
  bpm: z.number().min(20).max(999).optional(),
});

const forkSchema = z.object({
  originType: z.enum(["fork", "remix", "edit", "bootleg", "alt_version"]),
  newTitle: z.string().min(1).max(200).optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  // Create a new blank project
  app.post("/", async (req, reply) => {
    const body = createProjectSchema.parse(req.body);
    const userId = await requireUser(req);
    const projectId = randomUUID();

    const project = await prisma.project.create({
      data: {
        id: projectId,
        ownerId: userId,
        title: body.title,
        slug: `${body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${projectId.slice(0, 6)}`,
        bpm: body.bpm ?? 120,
        visibility: "private",
        license: "remix_with_attribution",
        originType: "original",
      },
    });

    const manifest = createBlankManifest({ projectId, title: body.title, authorId: userId, bpm: body.bpm });
    const version = await publishVersion({
      projectId,
      authorId: userId,
      message: "Initial project",
      manifest,
      parentVersionIds: [],
    });

    return reply.code(201).send({ project, headVersion: version });
  });

  // Fetch project metadata
  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    return prisma.project.findUniqueOrThrow({
      where: { id },
      include: { owner: { select: { username: true, displayName: true, avatarUrl: true } } },
    });
  });

  // Automatic attribution — see services/lineage.ts autoPopulateCredits.
  // This is what lets the public project page render "Remix of X by Y"
  // and a full credits list without the remixer ever typing anything.
  app.get("/:id/credits", async (req) => {
    const { id } = req.params as { id: string };
    return prisma.credit.findMany({
      where: { projectId: id },
      include: { user: { select: { username: true, displayName: true, avatarUrl: true } } },
    });
  });

  // Fetch the resolved current manifest (for opening in the DAW)
  app.get("/:id/manifest", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await prisma.project.findUniqueOrThrow({ where: { id } });
    if (!project.headVersionId) {
      return reply.code(404).send({ message: "Project has no published version yet", statusCode: 404 });
    }
    const { loadManifestSnapshot } = await import("../services/storage");
    return loadManifestSnapshot(project.id, project.headVersionId);
  });

  // The headline feature: fork / remix / edit / bootleg / alt-version
  app.post("/:id/fork", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = forkSchema.parse(req.body);
    const userId = await requireUser(req);

    const newProject = await forkProject({
      parentProjectId: id,
      requestingUserId: userId,
      originType: body.originType,
      newTitleOverride: body.newTitle,
    });

    return reply.code(201).send(newProject);
  });

  // Family tree / lineage
  app.get("/:id/lineage", async (req) => {
    const { id } = req.params as { id: string };
    return getProjectLineage(id);
  });

  // Public discovery feed (MVP: simplest possible — newest public projects)
  app.get("/", async (_req) => {
    const projects = await prisma.project.findMany({
      where: { visibility: "public" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { owner: { select: { username: true, displayName: true, avatarUrl: true } } },
    });
    return projects;
  });
}
