import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../services/prisma";
import { requireUser } from "../services/currentUser";
import { storage } from "../services/storage";

const uploadUrlSchema = z.object({
  hash: z.string().length(64), // sha256 hex
  sizeBytes: z.number().positive(),
  mimeType: z.string(),
  originalFilename: z.string(),
});

export async function assetRoutes(app: FastifyInstance) {
  /**
   * Client computes SHA-256 of the file locally, then asks for an upload URL.
   * If an asset with that hash already exists, we skip the upload entirely —
   * this is the content-addressed dedup described in ARCHITECTURE.md §4.5/§4.7:
   * two projects sharing the same sample never store it twice.
   */
  app.post("/upload-url", async (req) => {
    const body = uploadUrlSchema.parse(req.body);
    const userId = await requireUser(req);

    const existing = await prisma.asset.findUnique({ where: { hash: body.hash } });
    if (existing) {
      return { alreadyExists: true, hash: existing.hash };
    }

    const key = `assets/${body.hash.slice(0, 2)}/${body.hash.slice(2, 4)}/${body.hash}`;
    const uploadUrl = await storage.signUploadUrl(key, body.mimeType);

    await prisma.asset.create({
      data: {
        hash: body.hash,
        sizeBytes: body.sizeBytes,
        mimeType: body.mimeType,
        storageUrl: key,
        originalFilename: body.originalFilename,
        uploadedBy: userId,
      },
    });

    return { alreadyExists: false, uploadUrl, hash: body.hash };
  });

  app.get("/:hash", async (req) => {
    const { hash } = req.params as { hash: string };
    const asset = await prisma.asset.findUniqueOrThrow({ where: { hash } });
    const downloadUrl = await storage.signDownloadUrl(asset.storageUrl);
    return { ...asset, downloadUrl };
  });
}
