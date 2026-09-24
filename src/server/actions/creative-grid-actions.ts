"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import type { CreativeContentFormat } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { computeGridSeriesSchedule } from "@/lib/grid-series-schedule";
import { generateCreativeImage } from "@/server/media/creative-image";
import {
  splitImageIntoGridTiles,
  type GridLayout,
} from "@/server/media/creative-grid-split";
import { readAsset } from "@/server/storage/asset-storage";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import type { ActionResult } from "@/server/actions/agency-config-actions";

const LAYOUTS: ReadonlySet<string> = new Set(["3x1", "3x3"]);
const GRID_CONTENT_FORMATS: ReadonlySet<string> = new Set([
  "FEED_SQUARE",
  "FEED_PORTRAIT",
]);
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function tileGrid(layout: GridLayout): { cols: number; rows: number } {
  return layout === "3x3" ? { cols: 3, rows: 3 } : { cols: 3, rows: 1 };
}

// Instagram Grid Studio's split step (spec: izgara). Source is either an
// existing project asset (sourceAssetId) or generated fresh from a prompt
// (via the same instant generateCreativeImage() path the Image Studio
// uses — no Task/Approval queue, a result in seconds) sized directly to
// the full assembled canvas. Every tile becomes its own Creative, fast-
// tracked straight to APPROVED — same precedent as
// createCreativeFromLibraryAssetAction in creative-actions.ts: the user
// deliberately chose this exact source and layout, so there's no
// separate draft to re-review.
export async function splitImageIntoGridAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const layoutRaw = String(formData.get("layout") ?? "");
    const contentFormatRaw =
      String(formData.get("contentFormat") ?? "").trim() || "FEED_SQUARE";
    const sourceAssetId =
      String(formData.get("sourceAssetId") ?? "").trim() || undefined;
    const prompt = String(formData.get("prompt") ?? "").trim() || undefined;

    if (!projectId) return { ok: false, message: "Missing project." };
    if (!LAYOUTS.has(layoutRaw)) {
      return { ok: false, message: "Invalid layout." };
    }
    if (!GRID_CONTENT_FORMATS.has(contentFormatRaw)) {
      return { ok: false, message: "Invalid content format." };
    }
    if (!sourceAssetId && !prompt) {
      return {
        ok: false,
        message: "Pick an image or describe one to generate.",
      };
    }
    const layout = layoutRaw as GridLayout;
    const contentFormat = contentFormatRaw as CreativeContentFormat;

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const format = getCreativePlatformFormat("INSTAGRAM", contentFormat);
    const { cols, rows } = tileGrid(layout);
    const canvasSize = {
      width: format.pixelSize.width * cols,
      height: format.pixelSize.height * rows,
    };

    let sourceBuffer: Buffer;
    if (sourceAssetId) {
      const asset = await prisma.asset.findFirst({
        where: { id: sourceAssetId, projectId },
      });
      if (!asset) {
        return {
          ok: false,
          message: "Source image not found in this project.",
        };
      }
      sourceBuffer = await readAsset(asset.storageKey);
    } else {
      const generated = await generateCreativeImage(prompt!, {
        imageSize: canvasSize,
      });
      if (!generated) {
        return {
          ok: false,
          message:
            "Image generation failed — see the error on the System Health screen",
        };
      }
      sourceBuffer = await readAsset(generated.storageKey);
    }

    const tiles = await splitImageIntoGridTiles(
      sourceBuffer,
      layout,
      format.pixelSize,
    );
    const gridGroupId = randomUUID();

    for (const tile of tiles) {
      const asset = await prisma.asset.create({
        data: {
          workspaceId: access.workspaceId,
          projectId,
          brandId: access.defaultBrandId,
          type: "CREATIVE",
          source: "AI_GENERATED",
          filename: tile.filename,
          mimeType: tile.mimeType,
          storageKey: tile.storageKey,
          size: tile.size,
          width: tile.width,
          height: tile.height,
        },
      });
      const creative = await CreativeRepository.create({
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        type: "SOCIAL_POST",
        platform: "INSTAGRAM",
        title: `Grid ${tile.position}/${tiles.length}`,
        gridGroupId,
        gridPosition: tile.position,
      });
      await CreativeRepository.addVersion(creative.id, projectId, {
        assetId: asset.id,
        contentFormat,
      });
      await CreativeRepository.transition(creative.id, projectId, "IN_REVIEW");
      await CreativeRepository.transition(creative.id, projectId, "APPROVED");
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "creative.grid_split",
      entityType: "Creative",
      entityId: gridGroupId,
    });

    revalidatePath(`/projects/${projectId}/izgara`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// Schedules one split group's tiles as a back-to-back series — one start
// time + one gap, the reverse-order math above works out each tile's
// actual scheduledFor. Reuses the exact same field (Creative.scheduledFor)
// and publish queue (approval-decisions.ts) the Content Calendar already
// drives — nothing about publishing itself changes, this just writes N
// scheduledFor values in the right order instead of one.
export async function scheduleGridSeriesAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId") ?? "");
    const gridGroupId = String(formData.get("gridGroupId") ?? "");
    const startRaw = String(formData.get("start") ?? "").trim();
    const intervalMinutes = Number(formData.get("intervalMinutes") ?? "60");

    if (!projectId || !gridGroupId) {
      return { ok: false, message: "Missing project or grid group." };
    }
    if (!DATETIME_LOCAL_RE.test(startRaw)) {
      return { ok: false, message: "Invalid start time." };
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
      return { ok: false, message: "Invalid interval." };
    }

    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const schedule = await prisma.projectSchedule.findFirst({
      where: { projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { timezone: true },
    });
    const timezone = schedule?.timezone ?? "Europe/Istanbul";
    const startUtc = zonedDateTimeToUtc(startRaw, timezone);

    const tiles = await CreativeRepository.listGridGroup(
      gridGroupId,
      projectId,
    );
    if (tiles.length === 0) {
      return { ok: false, message: "Grid group not found in this project." };
    }

    const plan = computeGridSeriesSchedule(tiles, startUtc, intervalMinutes);
    for (const item of plan) {
      await CreativeRepository.setScheduledFor(
        item.id,
        projectId,
        item.scheduledFor,
      );
    }

    revalidatePath(`/projects/${projectId}/izgara`);
    revalidatePath(`/projects/${projectId}/takvim`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
