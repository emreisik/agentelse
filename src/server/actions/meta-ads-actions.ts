"use server";

import { revalidatePath } from "next/cache";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { TaskPlanner } from "@/server/commands/task-planner";
import { putAsset } from "@/server/storage/asset-storage";
import type { MetaAdSetTargeting } from "@/server/integrations/meta-client";
import type { ActionResult } from "@/server/actions/meta-actions";

// Server actions behind the Ads Manager creation forms (see
// meta-campaign-form.tsx). Deliberately separate from meta-actions.ts,
// which only manages the connection itself (page/ad account selection,
// test, disconnect) — these actions create real Meta objects and always go
// through TaskPlanner.planForCapability, so the existing Approval/
// ExecutionJob pipeline (risk level, human-in-the-loop, audit trail) is
// never bypassed just because the request came from a form instead of chat.

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

export async function createMetaCampaignAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const name = String(formData.get("name") ?? "").trim();
    const objective = String(formData.get("objective") ?? "").trim();
    const dailyBudget = Number(formData.get("dailyBudget") ?? 0);
    if (!name || !objective || !dailyBudget) {
      return { ok: false, message: "Name, objective and budget are required" };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_CAMPAIGN_CREATE",
      request: `Create Meta campaign: ${name}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: {
        name,
        objective,
        dailyBudgetCents: Math.round(dailyBudget * 100),
        status: "PAUSED",
      },
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Meta's adimages cap.

// Behind the combined AdSet+Ad wizard (adset-ad-wizard.tsx) — mirrors real
// Meta Ads Manager's "New ad set or ad" single screen. Only ONE Task is
// planned here (META_ADSET_CREATE); the ad's full data is embedded in its
// payload as `pendingAd`. Once that Task is APPROVED and Meta actually
// returns an adSetId, MetaAdSetChainRelay (see
// src/server/agency/meta-ads/meta-adset-chain-relay.ts, wired into
// agency-wiring.ts's registerTaskCompletedHandler) plans a SECOND Task
// (META_AD_CREATE) automatically — so the existing two-capability/
// two-Approval architecture is preserved even though the user only went
// through one form. If the AdSet is rejected, the relay never fires and
// pendingAd is simply never dispatched.
export async function createMetaAdSetWithAdAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const campaignId = String(formData.get("campaignId") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    const dailyBudget = Number(formData.get("dailyBudget") ?? 0);
    const billingEvent = String(formData.get("billingEvent") ?? "").trim();
    const optimizationGoal = String(
      formData.get("optimizationGoal") ?? "",
    ).trim();
    const countries = formData
      .getAll("countries")
      .map((v) => String(v).trim().toUpperCase())
      .filter(Boolean);
    const cities = parseCitiesField(formData.get("cities"));
    const ageMin = formData.get("ageMin")
      ? Number(formData.get("ageMin"))
      : undefined;
    const ageMax = formData.get("ageMax")
      ? Number(formData.get("ageMax"))
      : undefined;
    const genderRaw = String(formData.get("gender") ?? "").trim();
    const genders =
      genderRaw === "1" || genderRaw === "2"
        ? [Number(genderRaw) as 1 | 2]
        : undefined;
    const locales = formData
      .getAll("locales")
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));

    const adName = String(formData.get("adName") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const link = String(formData.get("link") ?? "").trim();
    const callToActionType = String(
      formData.get("callToActionType") ?? "LEARN_MORE",
    ).trim();
    const image = formData.get("image");

    if (
      !campaignId ||
      !name ||
      !dailyBudget ||
      !billingEvent ||
      !optimizationGoal ||
      countries.length === 0
    ) {
      return {
        ok: false,
        message:
          "Campaign, name, budget, billing event, optimization goal and at least one country are required",
      };
    }
    if (!adName || !message || !link) {
      return {
        ok: false,
        message: "Ad name, primary text and destination link are required",
      };
    }
    if (!(image instanceof File) || image.size === 0) {
      return { ok: false, message: "An image is required" };
    }
    if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
      return { ok: false, message: "Image must be JPEG, PNG or WebP" };
    }
    if (image.size > MAX_IMAGE_BYTES) {
      return { ok: false, message: "Image must be 8MB or smaller" };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const buffer = Buffer.from(await image.arrayBuffer());
    const ext =
      image.type === "image/png"
        ? "png"
        : image.type === "image/webp"
          ? "webp"
          : "jpg";
    const { storageKey } = await putAsset(buffer, ext, image.type);

    const { prisma } = await import("@/lib/prisma");
    const asset = await prisma.asset.create({
      data: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        type: "IMAGE",
        filename: image.name || `ad-image.${ext}`,
        mimeType: image.type,
        storageKey,
        size: buffer.byteLength,
      },
    });

    const targeting: MetaAdSetTargeting = {
      countries,
      cities: cities.length ? cities : undefined,
      ageMin,
      ageMax,
      genders,
      locales: locales.length ? locales : undefined,
    };

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_ADSET_CREATE",
      request: `Create Meta ad set: ${name}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: {
        campaignId,
        name,
        dailyBudgetCents: Math.round(dailyBudget * 100),
        billingEvent,
        optimizationGoal,
        targeting,
        status: "PAUSED",
        pendingAd: {
          name: adName,
          message,
          link,
          callToActionType,
          imageAssetId: asset.id,
          status: "PAUSED",
        },
      },
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

function parseCitiesField(
  value: FormDataEntryValue | null,
): { key: string; name: string }[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is { key: string; name: string } =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { key?: unknown }).key === "string" &&
        typeof (c as { name?: unknown }).name === "string",
    );
  } catch {
    return [];
  }
}

export async function createMetaAdAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const adSetId = String(formData.get("adSetId") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const link = String(formData.get("link") ?? "").trim();
    const callToActionType = String(
      formData.get("callToActionType") ?? "LEARN_MORE",
    ).trim();
    const image = formData.get("image");

    if (!adSetId || !name || !message || !link) {
      return {
        ok: false,
        message: "Ad set, name, message and link are required",
      };
    }
    if (!(image instanceof File) || image.size === 0) {
      return { ok: false, message: "An image is required" };
    }
    if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
      return { ok: false, message: "Image must be JPEG, PNG or WebP" };
    }
    if (image.size > MAX_IMAGE_BYTES) {
      return { ok: false, message: "Image must be 8MB or smaller" };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const buffer = Buffer.from(await image.arrayBuffer());
    const ext =
      image.type === "image/png"
        ? "png"
        : image.type === "image/webp"
          ? "webp"
          : "jpg";
    const { storageKey } = await putAsset(buffer, ext, image.type);

    const { prisma } = await import("@/lib/prisma");
    const asset = await prisma.asset.create({
      data: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        type: "IMAGE",
        filename: image.name || `ad-image.${ext}`,
        mimeType: image.type,
        storageKey,
        size: buffer.byteLength,
      },
    });

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_AD_CREATE",
      request: `Create Meta ad: ${name}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: {
        adSetId,
        name,
        message,
        link,
        callToActionType,
        imageAssetId: asset.id,
        status: "PAUSED",
      },
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
