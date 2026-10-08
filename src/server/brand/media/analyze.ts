import "server-only";

import { MEDIA_ANALYSES_PER_DAY, MEDIA_ANALYSIS_VERSION, orientationOf } from "@/lib/brand-media";
import { prisma } from "@/lib/prisma";
import { prepareVisionImage } from "@/server/brand/site-scan/image-colors";
import { brandMediaDef } from "@/server/reasoning/prompts/brand-media";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AgentelseError } from "@/server/security/errors";
import { readAsset } from "@/server/storage/asset-storage";

// Reads one library photo (brand.media.analyze) and writes what it sees onto
// its BrandMedia row. Never throws: a photo that cannot be read waits and is
// tried again a few times, then is marked FAILED (the owner can retry it).

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 10 * 60_000;
const BUDGET_RETRY_MS = 60 * 60_000;

export type AnalyzeOutcome = "ok" | "failed" | "deferred" | "missing";

function startOfUtcDay(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export async function analyzeBrandMedia(
  mediaId: string,
  now = new Date(),
): Promise<AnalyzeOutcome> {
  const media = await prisma.brandMedia.findUnique({ where: { id: mediaId } });
  if (!media) return "missing";

  // Video is understood later (poster frames need ffmpeg): kept, not analysed.
  if (media.kind === "VIDEO") {
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: { status: "SKIPPED" },
    });
    return "deferred";
  }

  // This project's share of the day's analyses is used up: wait.
  const today = await prisma.brandMedia.count({
    where: { projectId: media.projectId, analyzedAt: { gte: startOfUtcDay(now) } },
  });
  if (today >= MEDIA_ANALYSES_PER_DAY) {
    await prisma.brandMedia.update({
      where: { id: media.id },
      data: { nextAttemptAt: new Date(now.getTime() + BUDGET_RETRY_MS) },
    });
    return "deferred";
  }

  const fail = async (reason: string): Promise<AnalyzeOutcome> => {
    const attempts = media.attempts + 1;
    console.error(`[brand-media] analysis of ${media.id} failed: ${reason}`);
    await prisma.brandMedia.update({
      where: { id: media.id },
      data:
        attempts >= MAX_ATTEMPTS
          ? { status: "FAILED", attempts, nextAttemptAt: null }
          : {
              status: "PENDING",
              attempts,
              nextAttemptAt: new Date(now.getTime() + RETRY_BASE_MS * attempts),
            },
    });
    return "failed";
  };

  try {
    const asset = await prisma.asset.findUnique({
      where: { id: media.assetId },
      select: { storageKey: true, filename: true, width: true, height: true },
    });
    if (!asset) return fail("the file is gone");

    const prepared = await prepareVisionImage(await readAsset(asset.storageKey));
    if (!prepared) return fail("the picture could not be prepared");

    const result = await ReasoningService.run(brandMediaDef, {
      workspaceId: media.workspaceId,
      projectId: media.projectId,
      brandId: media.brandId,
      context: { filename: asset.filename },
      attachments: [{ mimeType: "image/jpeg", data: prepared.toString("base64") }],
    });
    const out = result.output;

    await prisma.brandMedia.update({
      where: { id: media.id },
      data: {
        status: "OK",
        version: MEDIA_ANALYSIS_VERSION,
        attempts: 0,
        nextAttemptAt: null,
        analyzedAt: now,
        description: out.description || null,
        // A person's own tags are kept through a re-analysis.
        ...(media.tagsEdited ? {} : { tags: out.tags }),
        subjects: out.subjects,
        setting: out.setting || null,
        mood: out.mood || null,
        shotType: out.shotType,
        orientation: orientationOf(asset.width, asset.height) ?? media.orientation,
        hasPeople: out.hasPeople,
        quality: out.quality,
        dominantColors: out.dominantColors,
        focalX: out.focalX ?? null,
        focalY: out.focalY ?? null,
      },
    });
    return "ok";
  } catch (error) {
    // The day's AI budget: not the photo's fault, wait for it.
    if (error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED") {
      await prisma.brandMedia.update({
        where: { id: media.id },
        data: { nextAttemptAt: new Date(now.getTime() + BUDGET_RETRY_MS) },
      });
      return "deferred";
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}
