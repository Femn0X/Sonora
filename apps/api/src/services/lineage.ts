import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { loadManifestSnapshot, saveManifestSnapshot } from "./storage";
import {
  forkManifest,
  diffManifests,
  type ProjectManifest,
  type ProjectOriginType,
} from "@sonora/schema";

/**
 * This module is the implementation of ARCHITECTURE.md §5: forking, versioning,
 * and automatic attribution. It's the single most important piece of business
 * logic in the product — every "fork/remix/edit/bootleg/alt-version" action in
 * the UI funnels through `forkProject`, and every "publish" funnels through
 * `publishVersion`.
 */

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") +
    "-" +
    randomUUID().slice(0, 6)
  );
}

/**
 * Publishes a new immutable Version for an existing project: snapshots the
 * current manifest to object storage, records the commit in Postgres, and
 * advances the project's headVersionId. Analogous to `git commit`.
 */
export async function publishVersion(params: {
  projectId: string;
  authorId: string;
  message: string;
  manifest: ProjectManifest;
  parentVersionIds: string[];
}) {
  const versionId = randomUUID();
  const manifestUrl = await saveManifestSnapshot(params.projectId, versionId, params.manifest);

  let diffSummary: unknown = null;
  if (params.parentVersionIds[0]) {
    try {
      const parentManifest = await loadManifestSnapshot(params.projectId, params.parentVersionIds[0]);
      diffSummary = diffManifests(parentManifest, params.manifest);
    } catch {
      // First version ever, or parent snapshot unavailable — no diff, that's fine.
    }
  }

  const version = await prisma.version.create({
    data: {
      id: versionId,
      projectId: params.projectId,
      parentVersionIds: params.parentVersionIds,
      authorId: params.authorId,
      message: params.message,
      manifestUrl,
      diffSummary: diffSummary as any,
    },
  });

  await prisma.project.update({
    where: { id: params.projectId },
    data: { headVersionId: versionId, updatedAt: new Date() },
  });

  return version;
}

/**
 * The "Remix this project" / "Fork" / "Create an edit" / "Create a bootleg"
 * action. Architecturally identical regardless of which button the user
 * clicked — `originType` is purely a semantic/social label (ARCHITECTURE §4.4).
 *
 * Steps:
 *  1. Enforce the parent project's license (no_remix blocks this entirely).
 *  2. Deep-copy the manifest with a fresh projectId (copy-on-write; underlying
 *     assets are NOT duplicated — they stay content-addressed and shared).
 *  3. Create the new Project row with origin pointers back to the parent.
 *  4. Publish version 1 of the new project.
 *  5. Auto-populate credits by walking the parent's existing credit chain
 *     plus adding the parent's owner as `original_creator`/`remixer`.
 *  6. Increment the parent's remixCount.
 */
export async function forkProject(params: {
  parentProjectId: string;
  requestingUserId: string;
  originType: ProjectOriginType;
  newTitleOverride?: string;
}) {
  const parent = await prisma.project.findUniqueOrThrow({
    where: { id: params.parentProjectId },
  });

  if (parent.license === "no_remix") {
    throw new Error("This project's license does not permit remixing.");
  }
  if (!parent.headVersionId) {
    throw new Error("Parent project has no published version to fork from.");
  }

  const parentManifest = await loadManifestSnapshot(parent.id, parent.headVersionId);

  const labelSuffix: Record<ProjectOriginType, string> = {
    original: "",
    fork: "Fork",
    remix: "Remix",
    edit: "Edit",
    bootleg: "Bootleg",
    alt_version: "Alt Version",
  };

  const newProjectId = randomUUID();
  const newTitle =
    params.newTitleOverride ?? `${parent.title} — ${labelSuffix[params.originType] || "Copy"}`;

  const newManifest = forkManifest(parentManifest, {
    newProjectId,
    parentVersionId: parent.headVersionId,
    originType: params.originType,
    newTitle,
  });

  const newProject = await prisma.project.create({
    data: {
      id: newProjectId,
      ownerId: params.requestingUserId,
      title: newTitle,
      slug: slugify(newTitle),
      bpm: parent.bpm,
      keySignature: parent.keySignature,
      visibility: "private", // remixer decides when to publish it publicly
      // Copyleft-style licenses propagate forward; enforced here, not just client-side.
      license: parent.license === "cc_by_sa" ? "cc_by_sa" : "remix_with_attribution",
      originProjectId: parent.id,
      originVersionId: parent.headVersionId,
      originType: params.originType,
    },
  });

  await publishVersion({
    projectId: newProject.id,
    authorId: params.requestingUserId,
    message: `Initial ${params.originType} of "${parent.title}"`,
    manifest: newManifest,
    parentVersionIds: [], // new project's own history starts fresh; lineage lives on Project.origin*
  });

  await autoPopulateCredits(newProject.id, parent.id);

  await prisma.project.update({
    where: { id: parent.id },
    data: { remixCount: { increment: 1 } },
  });

  return newProject;
}

/**
 * Walks the ancestor chain of `sourceProjectId` and copies every existing
 * credit forward into `newProjectId`, then adds the immediate parent's owner
 * as a credited creator. This is what makes attribution automatic and
 * tamper-resistant — a downstream remixer never has to (and cannot) manually
 * re-type or omit the original creator's name.
 */
async function autoPopulateCredits(newProjectId: string, sourceProjectId: string) {
  const parent = await prisma.project.findUniqueOrThrow({ where: { id: sourceProjectId } });
  const existingCredits = await prisma.credit.findMany({ where: { projectId: sourceProjectId } });

  const creditRole = parent.originProjectId ? "remixer" : "original_creator";

  await prisma.credit.create({
    data: {
      projectId: newProjectId,
      userId: parent.ownerId,
      role: creditRole,
      sourceProjectId: parent.id,
    },
  });

  for (const credit of existingCredits) {
    await prisma.credit.create({
      data: {
        projectId: newProjectId,
        userId: credit.userId,
        role: credit.role,
        sourceProjectId: credit.sourceProjectId,
      },
    });
  }
}

/**
 * Returns the full lineage graph (ancestors + immediate descendants) for the
 * "family tree" UI (ARCHITECTURE §5.1, §14 screen 4). Ancestors walked via
 * a bounded loop (cheap in Postgres via recursive CTE in production; this
 * simple version is fine for MVP depth).
 */
export async function getProjectLineage(projectId: string) {
  const ancestors = [];
  let current = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  while (current.originProjectId) {
    const parent = await prisma.project.findUnique({
      where: { id: current.originProjectId },
      include: { owner: { select: { username: true, displayName: true } } },
    });
    if (!parent) break;
    ancestors.unshift({
      id: parent.id,
      title: parent.title,
      originType: current.originType,
      owner: parent.owner,
    });
    current = parent;
  }

  const descendants = await prisma.project.findMany({
    where: { originProjectId: projectId },
    select: {
      id: true,
      title: true,
      originType: true,
      createdAt: true,
      owner: { select: { username: true, displayName: true } },
    },
  });

  return { ancestors, descendants };
}
