"use server";

import { revalidatePath } from "next/cache";

import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { TaskPlanner } from "@/server/commands/task-planner";
import { putAsset } from "@/server/storage/asset-storage";
import type { MetaAdSetTargeting } from "@/server/integrations/meta-client";
import { loadAdsAccount } from "@/server/modules/ads/account";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { toMinorUnits } from "@/lib/ads/money";
import { zonedDateTimeToUtc } from "@/lib/timezone";
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

// Seçili reklam hesabı ve para birimi: tutarlar hesabın minor unit'ine
// buradan çevrilir (sabit ×100 JPY/HUF gibi hesaplarda 100 kat yanlış
// gidiyordu) ve görev onay anının hesabını taşır (docs/meta-ads-plan.md F0b).
async function accountContext(
  projectId: string,
): Promise<{ adAccountId?: string; currency?: string }> {
  const account = await loadAdsAccount(projectId);
  return {
    ...(account.adAccountId ? { adAccountId: account.adAccountId } : {}),
    ...(account.currency ? { currency: account.currency } : {}),
  };
}

export async function createMetaCampaignAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const name = String(formData.get("name") ?? "").trim();
    const objective = String(formData.get("objective") ?? "").trim();
    if (!name || !objective) {
      return { ok: false, message: "Name and objective are required" };
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
      // Bütçe kampanyada değil ad set'tedir (ABO; Meta ikisini birden
      // almaz) ve bitiş tarihiyle birlikte ad set'te sorulur.
      payloadExtra: {
        name,
        objective,
        status: "PAUSED",
        ...(await accountContext(projectId)),
      },
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Manual, user-triggered edit of an EXISTING campaign — distinct from
// PerformanceOptimizer's automated proposals (performance-optimizer.ts),
// which write `proposedStatus`/`proposedDailyBudgetCents` instead of these
// direct field names; MetaApiProvider.updateCampaign's fallback already
// reads both. Meta doesn't allow changing a campaign's `objective` or
// `name` after creation, so budget + status are the only editable fields.
export async function updateMetaCampaignAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const campaignId = String(formData.get("campaignId") ?? "").trim();
    // Bütçe yalnız kampanya bütçeli (CBO) ise gönderilir: ad set bütçeli
    // (ABO) kampanyaya daily_budget yazmak yapıyı bozar.
    const dailyBudget = Number(formData.get("dailyBudget") ?? 0);
    const status = String(formData.get("status") ?? "").trim();
    if (!campaignId || (status !== "ACTIVE" && status !== "PAUSED")) {
      return {
        ok: false,
        message: "Campaign and status are required",
      };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_CAMPAIGN_UPDATE",
      request: `Update Meta campaign budget/status: ${campaignId}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: await (async () => {
        const account = await accountContext(projectId);
        return {
          campaignId,
          status,
          ...account,
          ...(dailyBudget > 0
            ? { dailyBudgetCents: toMinorUnits(dailyBudget, account.currency) }
            : {}),
        };
      })(),
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Meta's adimages cap.
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // App-level cap for a short-form ad video. Kept well under Meta's own (much larger) limit — every upload is fully buffered into memory (see createVideoAsset below, and MetaApiProvider.uploadMetaAdVideo later re-reading + re-buffering the same bytes to send to Meta), and this action has no per-user/concurrency throttle, so a large per-request cap directly translates to worst-case server memory pressure. Also bounds next.config.ts's serverActions.bodySizeLimit.
const MIN_CAROUSEL_CARDS = 2;
const MAX_CAROUSEL_CARDS = 10; // Meta's own ceiling — enforced here too so a bad request fails before any upload work starts.

type ActionOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

async function createImageAsset(
  image: File,
  access: { workspaceId: string; defaultBrandId: string },
  projectId: string,
): Promise<ActionOutcome<string>> {
  if (image.size === 0) return { ok: false, message: "An image is required" };
  if (!ALLOWED_IMAGE_TYPES.has(image.type)) {
    return { ok: false, message: "Image must be JPEG, PNG or WebP" };
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: "Image must be 8MB or smaller" };
  }

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
      source: "CUSTOMER_UPLOAD",
      filename: image.name || `ad-image.${ext}`,
      mimeType: image.type,
      storageKey,
      size: buffer.byteLength,
    },
  });
  return { ok: true, value: asset.id };
}

async function createVideoAsset(
  video: File,
  access: { workspaceId: string; defaultBrandId: string },
  projectId: string,
): Promise<ActionOutcome<string>> {
  if (video.size === 0) return { ok: false, message: "A video is required" };
  if (!ALLOWED_VIDEO_TYPES.has(video.type)) {
    return { ok: false, message: "Video must be MP4, MOV or WebM" };
  }
  if (video.size > MAX_VIDEO_BYTES) {
    return { ok: false, message: "Video must be 50MB or smaller" };
  }

  const buffer = Buffer.from(await video.arrayBuffer());
  const ext =
    video.type === "video/quicktime"
      ? "mov"
      : video.type === "video/webm"
        ? "webm"
        : "mp4";
  const { storageKey } = await putAsset(buffer, ext, video.type);

  const { prisma } = await import("@/lib/prisma");
  const asset = await prisma.asset.create({
    data: {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      type: "VIDEO",
      source: "CUSTOMER_UPLOAD",
      filename: video.name || `ad-video.${ext}`,
      mimeType: video.type,
      storageKey,
      size: buffer.byteLength,
    },
  });
  return { ok: true, value: asset.id };
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

// Same JSON-encoded-pairs shape as parseCitiesField, for the locale chips
// LocaleSearchCommand collects (a live Meta search result, not a hardcoded
// table — see searchMetaAdLocales in meta-client.ts).
function parseLocalesField(
  value: FormDataEntryValue | null,
): { id: number; label?: string }[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l): l is { id: number; label?: string } =>
        typeof l === "object" &&
        l !== null &&
        typeof (l as { id?: unknown }).id === "number",
    );
  } catch {
    return [];
  }
}

type CarouselCardField = { link: string; name: string; description?: string };

function parseCardsField(
  value: FormDataEntryValue | null,
): CarouselCardField[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is CarouselCardField =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { link?: unknown }).link === "string" &&
        typeof (c as { name?: unknown }).name === "string" &&
        (typeof (c as { description?: unknown }).description === "string" ||
          (c as { description?: unknown }).description === undefined),
    );
  } catch {
    return [];
  }
}

// Shared by createMetaAdSetWithAdAction and updateMetaAdSetAction — same
// countries/cities/age/gender/locales fields, same FormData field names
// (repeated `countries`/`locales` via getAll, JSON-encoded `cities`),
// whether the ad set is being created or edited.
function parseTargetingFromFormData(formData: FormData): MetaAdSetTargeting {
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
  const locales = parseLocalesField(formData.get("locales"));

  return {
    countries,
    cities: cities.length ? cities : undefined,
    ageMin,
    ageMax,
    genders,
    locales: locales.length ? locales : undefined,
  };
}

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
//
// `format` (SINGLE_IMAGE | CAROUSEL | VIDEO, default SINGLE_IMAGE) decides
// which creative fields are read from formData — see the wizard's
// discriminated `ad` schema, which only ever sends the fields for the
// format actually selected.
export async function createMetaAdSetWithAdAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const campaignId = String(formData.get("campaignId") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    const dailyBudget = Number(formData.get("dailyBudget") ?? 0);
    const endDate = String(formData.get("endDate") ?? "").trim();
    const billingEvent = String(formData.get("billingEvent") ?? "").trim();
    const optimizationGoal = String(
      formData.get("optimizationGoal") ?? "",
    ).trim();
    const targetingFields = parseTargetingFromFormData(formData);
    const countries = targetingFields.countries;

    const format = String(formData.get("format") ?? "SINGLE_IMAGE").trim();
    const adName = String(formData.get("adName") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const callToActionType = String(
      formData.get("callToActionType") ?? "LEARN_MORE",
    ).trim();

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
    if (!adName || !message) {
      return {
        ok: false,
        message: "Ad name and primary text are required",
      };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    // Zorunlu bitiş: seçilen günün sonu, projenin saat diliminde
    // (docs/meta-ads-plan.md F0b). Geçmiş ya da boş gün kabul edilmez.
    const endTime = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ? zonedDateTimeToUtc(
          `${endDate}T23:59`,
          await getProjectTimezone(projectId),
        )
      : null;
    if (!endTime || endTime.getTime() <= Date.now() + 60 * 60_000) {
      return { ok: false, message: "Pick a future end date for the ad set" };
    }

    let pendingAd: Record<string, unknown>;

    if (format === "CAROUSEL") {
      const cardMeta = parseCardsField(formData.get("cards"));
      const cardImages = formData.getAll("cardImage");
      if (
        cardMeta.length < MIN_CAROUSEL_CARDS ||
        cardMeta.length > MAX_CAROUSEL_CARDS ||
        cardImages.length !== cardMeta.length
      ) {
        return {
          ok: false,
          message: `A carousel needs ${MIN_CAROUSEL_CARDS}-${MAX_CAROUSEL_CARDS} cards, each with an image`,
        };
      }
      const cards: {
        link: string;
        name: string;
        description?: string;
        imageAssetId: string;
      }[] = [];
      for (let i = 0; i < cardMeta.length; i++) {
        const cardImage = cardImages[i];
        if (!(cardImage instanceof File)) {
          return { ok: false, message: `Card ${i + 1} is missing its image` };
        }
        const uploaded = await createImageAsset(cardImage, access, projectId);
        if (!uploaded.ok) {
          return { ok: false, message: `Card ${i + 1}: ${uploaded.message}` };
        }
        cards.push({ ...cardMeta[i]!, imageAssetId: uploaded.value });
      }
      pendingAd = {
        name: adName,
        message,
        callToActionType,
        status: "PAUSED",
        format: "CAROUSEL",
        cards,
      };
    } else if (format === "VIDEO") {
      const link = String(formData.get("link") ?? "").trim();
      const video = formData.get("video");
      const thumbnail = formData.get("thumbnail");
      if (!link) {
        return { ok: false, message: "Destination link is required" };
      }
      if (!(video instanceof File)) {
        return { ok: false, message: "A video is required" };
      }
      if (!(thumbnail instanceof File)) {
        return { ok: false, message: "A thumbnail image is required" };
      }
      const uploadedVideo = await createVideoAsset(video, access, projectId);
      if (!uploadedVideo.ok)
        return { ok: false, message: uploadedVideo.message };
      const uploadedThumbnail = await createImageAsset(
        thumbnail,
        access,
        projectId,
      );
      if (!uploadedThumbnail.ok) {
        return {
          ok: false,
          message: `Thumbnail: ${uploadedThumbnail.message}`,
        };
      }
      pendingAd = {
        name: adName,
        message,
        link,
        callToActionType,
        status: "PAUSED",
        format: "VIDEO",
        videoAssetId: uploadedVideo.value,
        thumbnailAssetId: uploadedThumbnail.value,
      };
    } else {
      const link = String(formData.get("link") ?? "").trim();
      const image = formData.get("image");
      if (!link) {
        return { ok: false, message: "Destination link is required" };
      }
      if (!(image instanceof File)) {
        return { ok: false, message: "An image is required" };
      }
      const uploaded = await createImageAsset(image, access, projectId);
      if (!uploaded.ok) return { ok: false, message: uploaded.message };
      pendingAd = {
        name: adName,
        message,
        link,
        callToActionType,
        status: "PAUSED",
        format: "SINGLE_IMAGE",
        imageAssetId: uploaded.value,
      };
    }

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_ADSET_CREATE",
      request: `Create Meta ad set: ${name}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: await (async () => {
        const account = await accountContext(projectId);
        return {
          campaignId,
          name,
          dailyBudgetCents: toMinorUnits(dailyBudget, account.currency),
          endTime: endTime.toISOString(),
          billingEvent,
          optimizationGoal,
          targeting: targetingFields,
          status: "PAUSED",
          pendingAd,
          ...account,
        };
      })(),
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Manual, user-triggered edit of an EXISTING ad set — budget/status/status
// share the same META_ADSET_UPDATE capability PerformanceOptimizer already
// uses (see the identical fallback comment on updateMetaCampaignAction
// above), `targeting` is new: only this manual path ever sets it.
export async function updateMetaAdSetAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const adSetId = String(formData.get("adSetId") ?? "").trim();
    const dailyBudget = Number(formData.get("dailyBudget") ?? 0);
    const status = String(formData.get("status") ?? "").trim();
    const targeting = parseTargetingFromFormData(formData);
    // Hedefleme yalnız formda değiştiyse gönderilir: her seferinde tüm
    // targeting'i yeniden yazmak Ads Manager'da eklenen ilgi alanlarını,
    // özel kitleleri ve Advantage+ ayarlarını sessizce siliyordu.
    const targetingChanged = formData.get("targetingChanged") === "1";
    if (
      !adSetId ||
      !dailyBudget ||
      (status !== "ACTIVE" && status !== "PAUSED") ||
      (targetingChanged && targeting.countries.length === 0)
    ) {
      return {
        ok: false,
        message:
          "Ad set, a valid daily budget, status and at least one country are required",
      };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_ADSET_UPDATE",
      request: `Update Meta ad set: ${adSetId}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: await (async () => {
        const account = await accountContext(projectId);
        return {
          adSetId,
          dailyBudgetCents: toMinorUnits(dailyBudget, account.currency),
          status,
          ...(targetingChanged ? { targeting } : {}),
          ...account,
        };
      })(),
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
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
        source: "CUSTOMER_UPLOAD",
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

type EditCardField = CarouselCardField & {
  hasNewImage: boolean;
  existingImageHash?: string;
};

function parseEditCardsField(
  value: FormDataEntryValue | null,
): EditCardField[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is EditCardField =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { link?: unknown }).link === "string" &&
        typeof (c as { name?: unknown }).name === "string" &&
        typeof (c as { hasNewImage?: unknown }).hasNewImage === "boolean",
    );
  } catch {
    return [];
  }
}

// Manual, user-triggered edit of an EXISTING ad — the one capability that
// can change EVERYTHING about a live ad, including its creative (see the
// plan's "Creative dahil herşey" scope decision). Meta's AdCreative content
// is immutable once created (see updateMetaAd's comment in meta-client.ts),
// so any format/content change here always means building a brand-new
// creative and pointing the ad at it — MetaApiProvider.updateAd does the
// actual Meta-side work; this action's job is just turning the edit
// wizard's FormData into the right payload shape, format by format.
//
// `format` absent means a pure name/status edit — no creative fields are
// read at all. When present, each image slot (the single image, or a
// carousel card, or a video's thumbnail-carrying video slot) is EITHER a
// freshly uploaded File (`image`/`cardImage`/`video`) OR a pass-through
// reference to what's already on Meta's creative (`existingImageHash`/
// each card's `existingImageHash`/`existingVideoId`) — the wizard sends
// whichever the user actually changed, so editing only the message never
// forces a redundant re-upload of an untouched picture.
export async function updateMetaAdAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const adId = String(formData.get("adId") ?? "").trim();
    const nameRaw = String(formData.get("name") ?? "").trim();
    const statusRaw = String(formData.get("status") ?? "").trim();
    const format = String(formData.get("format") ?? "").trim();
    if (!adId) {
      return { ok: false, message: "Ad is required" };
    }
    const name = nameRaw || undefined;
    const status =
      statusRaw === "ACTIVE" || statusRaw === "PAUSED" ? statusRaw : undefined;

    if (!format) {
      if (!name && !status) {
        return { ok: false, message: "Nothing to update" };
      }
      const { userId } = await requireUser();
      const access = await requireProjectAccess(userId, projectId);
      await TaskPlanner.planForCapability({
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
        capability: "META_AD_UPDATE",
        request: `Update Meta ad: ${adId}`,
        createdByType: "USER",
        createdByUserId: userId,
        departmentKey: "PERFORMANCE_MARKETING",
        payloadExtra: { adId, name, status },
      });
      revalidatePath(`/projects/${projectId}/ads`);
      return { ok: true };
    }

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    let payloadExtra: Record<string, unknown>;

    if (format === "CAROUSEL") {
      const message = String(formData.get("message") ?? "").trim();
      const callToActionType = String(
        formData.get("callToActionType") ?? "LEARN_MORE",
      ).trim();
      const cardMeta = parseEditCardsField(formData.get("cards"));
      const newImages = formData
        .getAll("cardImage")
        .filter((f): f is File => f instanceof File);
      if (
        !message ||
        cardMeta.length < MIN_CAROUSEL_CARDS ||
        cardMeta.length > MAX_CAROUSEL_CARDS
      ) {
        return {
          ok: false,
          message: `Primary text and ${MIN_CAROUSEL_CARDS}-${MAX_CAROUSEL_CARDS} cards are required`,
        };
      }
      let nextNewImage = 0;
      const cards: (
        | {
            link: string;
            name: string;
            description?: string;
            imageAssetId: string;
          }
        | {
            link: string;
            name: string;
            description?: string;
            existingImageHash: string;
          }
      )[] = [];
      for (const card of cardMeta) {
        if (card.hasNewImage) {
          const file = newImages[nextNewImage++];
          if (!file) {
            return {
              ok: false,
              message: `Card "${card.name}" is missing its new image`,
            };
          }
          const uploaded = await createImageAsset(file, access, projectId);
          if (!uploaded.ok) {
            return {
              ok: false,
              message: `Card "${card.name}": ${uploaded.message}`,
            };
          }
          cards.push({
            link: card.link,
            name: card.name,
            description: card.description,
            imageAssetId: uploaded.value,
          });
        } else {
          if (!card.existingImageHash) {
            return { ok: false, message: `Card "${card.name}" needs an image` };
          }
          cards.push({
            link: card.link,
            name: card.name,
            description: card.description,
            existingImageHash: card.existingImageHash,
          });
        }
      }
      payloadExtra = { format: "CAROUSEL", message, callToActionType, cards };
    } else if (format === "VIDEO") {
      const message = String(formData.get("message") ?? "").trim();
      const link = String(formData.get("link") ?? "").trim();
      const callToActionType = String(
        formData.get("callToActionType") ?? "LEARN_MORE",
      ).trim();
      const video = formData.get("video");
      const existingVideoId = String(
        formData.get("existingVideoId") ?? "",
      ).trim();
      const thumbnail = formData.get("thumbnail");
      if (!message || !link) {
        return {
          ok: false,
          message: "Primary text and destination link are required",
        };
      }
      if (!(thumbnail instanceof File) || thumbnail.size === 0) {
        return { ok: false, message: "A thumbnail image is required" };
      }
      const uploadedThumbnail = await createImageAsset(
        thumbnail,
        access,
        projectId,
      );
      if (!uploadedThumbnail.ok) {
        return {
          ok: false,
          message: `Thumbnail: ${uploadedThumbnail.message}`,
        };
      }
      if (video instanceof File && video.size > 0) {
        const uploadedVideo = await createVideoAsset(video, access, projectId);
        if (!uploadedVideo.ok)
          return { ok: false, message: uploadedVideo.message };
        payloadExtra = {
          format: "VIDEO",
          message,
          link,
          callToActionType,
          videoAssetId: uploadedVideo.value,
          thumbnailAssetId: uploadedThumbnail.value,
        };
      } else if (existingVideoId) {
        payloadExtra = {
          format: "VIDEO",
          message,
          link,
          callToActionType,
          existingVideoId,
          thumbnailAssetId: uploadedThumbnail.value,
        };
      } else {
        return { ok: false, message: "A video is required" };
      }
    } else {
      const message = String(formData.get("message") ?? "").trim();
      const link = String(formData.get("link") ?? "").trim();
      const callToActionType = String(
        formData.get("callToActionType") ?? "LEARN_MORE",
      ).trim();
      const image = formData.get("image");
      const existingImageHash = String(
        formData.get("existingImageHash") ?? "",
      ).trim();
      if (!message || !link) {
        return {
          ok: false,
          message: "Primary text and destination link are required",
        };
      }
      if (image instanceof File && image.size > 0) {
        const uploaded = await createImageAsset(image, access, projectId);
        if (!uploaded.ok) return { ok: false, message: uploaded.message };
        payloadExtra = {
          format: "SINGLE_IMAGE",
          message,
          link,
          callToActionType,
          imageAssetId: uploaded.value,
        };
      } else if (existingImageHash) {
        payloadExtra = {
          format: "SINGLE_IMAGE",
          message,
          link,
          callToActionType,
          existingImageHash,
        };
      } else {
        return { ok: false, message: "An image is required" };
      }
    }

    await TaskPlanner.planForCapability({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      capability: "META_AD_UPDATE",
      request: `Update Meta ad: ${adId}`,
      createdByType: "USER",
      createdByUserId: userId,
      departmentKey: "PERFORMANCE_MARKETING",
      payloadExtra: { adId, name, status, ...payloadExtra },
    });

    revalidatePath(`/projects/${projectId}/ads`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
