import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type AdsLaunch } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import {
  adSetEndTime,
  parseLaunchSpec,
  type AdsLaunchSpec,
} from "@/lib/ads/launch-spec";
import { normalizeAdAccountId } from "@/lib/ads/account-id";
import { creativeCards, imageSlots } from "@/lib/ads/launch-images";
import { taggedName } from "@/lib/ads/operation-tag";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, zonedDateTimeToUtc } from "@/lib/timezone";
import { AdsAccounts } from "@/server/ads/accounts";
import { AdsOperations, type OperationKind } from "@/server/ads/operations";
import { coverUrl, ensureVideos, type VideoStep } from "./video";
import {
  fetchPageAccessToken,
  findMetaObjectsByTag,
  MetaApiError,
  uploadMetaAdImage,
} from "@/server/integrations/meta-client";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import {
  classifyMetaError,
  metaUserMessage,
} from "@/server/integrations/meta/error-catalog";
import { MetaRateLimitedError } from "@/server/integrations/meta/governor";
import {
  lifetimeImpressions,
  postAd,
  postAdSet,
  setCampaignBidStrategy,
  postCampaign,
  postCreative,
  postLeadForm,
  readBack,
  setObjectStatus,
} from "@/server/integrations/meta/launch-writes";
import { readAsset } from "@/server/storage/asset-storage";

import {
  AdsLaunches,
  progressOf,
  type LaunchError,
  type LaunchProgress,
} from "./store";

// Lansmanın asenkron adım makinesi (docs/meta-ads-plan.md §3.4). META_LAUNCH
// görevinin her yoklamasında governor'ın izin verdiği kadar (en çok 3 yazma)
// ilerler; her yazma niyet günlüğüne (AdsOperation.launchId + stepKey) düşer,
// başarılı adım bir daha gönderilmez. Sıra: görseller → kreatifler → kampanya
// (PAUSED, spend_cap) → ad set'ler (ACTIVE, end_time) → reklamlar (ACTIVE) →
// geri okuma → aktifleştirme (kampanya ACTIVE, tek yazma). Kampanya kapalı
// kaldıkça teslimat başlamaz: yarıda kesilen lansman harcama yapmaz.

export type LaunchMode = "create" | "activate" | "discard";

export type AdvanceResult = {
  status: "RUNNING" | "COMPLETED" | "FAILED";
  errorMessage?: string;
  errorCode?: string;
  rawResult?: unknown;
};

const MAX_WRITES = 3;
// Yanıtı kaybolan yazma bu kadar beklenir, sonra etiketle aranır ve
// bulunamazsa bir kez daha gönderilir.
const UNKNOWN_GRACE_MS = 60_000;

type Ctx = {
  launch: AdsLaunch;
  spec: AdsLaunchSpec;
  progress: LaunchProgress;
  accessToken: string;
  adAccountId: string;
  actorType: "USER" | "SYSTEM";
  now: Date;
  writes: number;
};

type StepOutcome =
  | { kind: "done"; id: string }
  | { kind: "pending" }
  | { kind: "failed"; error: LaunchError };

function launchError(step: string, error: unknown): LaunchError {
  const { class: klass } = classifyMetaError(error);
  const meta = error instanceof MetaApiError ? error : null;
  const blame = meta?.details.blameFieldSpecs as unknown;
  const field =
    Array.isArray(blame) && Array.isArray(blame[0])
      ? (blame[0] as unknown[]).join(".")
      : null;
  return {
    step,
    class: klass,
    code: meta?.metaErrorCode ?? null,
    subcode: meta?.metaErrorSubcode ?? null,
    message: metaUserMessage(error),
    field,
    fbtraceId: meta?.details.fbtraceId ?? null,
  };
}

// Meta isteği hiç almadı ya da almadan reddetti: adım yeniden gönderilebilir.
function notCreated(error: unknown): boolean {
  if (error instanceof MetaRateLimitedError) return true;
  return classifyMetaError(error).class === "RATE_LIMIT";
}

async function step(
  ctx: Ctx,
  input: {
    kind: OperationKind;
    stepKey: string;
    edge?: "campaigns" | "adsets" | "ads";
    parentExternalId?: string;
    request: Record<string, unknown>;
    send: (tagged: (name: string) => string) => Promise<string>;
  },
): Promise<StepOutcome> {
  const { op, resumed } = await AdsOperations.beginStep({
    workspaceId: ctx.launch.workspaceId,
    projectId: ctx.launch.projectId,
    kind: input.kind,
    actorType: ctx.actorType,
    adAccountExternalId: ctx.adAccountId,
    parentExternalId: input.parentExternalId,
    request: input.request,
    launchId: ctx.launch.id,
    stepKey: input.stepKey,
  });
  if (resumed) {
    if (
      (op.status === "SUCCEEDED" || op.status === "RECONCILED") &&
      op.resultExternalId
    ) {
      return { kind: "done", id: op.resultExternalId };
    }
    if (op.status === "SENT" || op.status === "UNKNOWN") {
      const sentAt = op.sentAt ?? op.createdAt;
      if (input.edge) {
        const found = await findMetaObjectsByTag({
          adAccountId: ctx.adAccountId,
          accessToken: ctx.accessToken,
          edge: input.edge,
          tag: op.tag,
          createdSince: sentAt,
        });
        if (found[0]) {
          await AdsOperations.reconciled(op.id, found[0]);
          return { kind: "done", id: found[0] };
        }
      }
      if (ctx.now.getTime() - sentAt.getTime() < UNKNOWN_GRACE_MS) {
        return { kind: "pending" };
      }
      await AdsOperations.fail(
        op.id,
        new Error("Meta did not confirm the write"),
      );
      const failures = await AdsOperations.failedAttempts(
        ctx.launch.id,
        input.kind,
        input.stepKey,
      );
      if (failures >= 2) {
        return {
          kind: "failed",
          error: {
            step: input.stepKey,
            class: "TRANSIENT",
            message:
              "Meta didn't confirm a step twice. Try again in a few minutes.",
          },
        };
      }
      // Bir sonraki tur yeni bir kayıtla bir kez daha gönderir.
      return { kind: "pending" };
    }
    // PENDING: kayıt açılmış ama gönderilmemiş.
  }
  if (ctx.writes >= MAX_WRITES) return { kind: "pending" };
  await AdsOperations.markSent(op.id);
  ctx.writes += 1;
  try {
    const id = await input.send((name) => taggedName(name, op.tag));
    await AdsOperations.succeed(op.id, id);
    return { kind: "done", id };
  } catch (error) {
    if (notCreated(error)) {
      await prisma.adsOperation.update({
        where: { id: op.id },
        data: { status: "PENDING" },
      });
      return { kind: "pending" };
    }
    if (classifyMetaError(error).class === "TRANSIENT") {
      await AdsOperations.unknown(op.id, error);
      return { kind: "pending" };
    }
    await AdsOperations.fail(op.id, error);
    return { kind: "failed", error: launchError(input.stepKey, error) };
  }
}

// Ad set "teklif tutarı gerekli" diyorsa (100/1815857): kampanyada açık strateji
// yoktur, Meta hesabın varsayılanını uygular. Kampanyaya en düşük maliyet
// stratejisi yazılıp ad set bir kez daha denenir (kampanya kapalı: harcama yok).
function bidAmountRequired(error: unknown): boolean {
  return (
    error instanceof MetaApiError &&
    error.metaErrorCode === 100 &&
    error.metaErrorSubcode === 1815857
  );
}

function featuresRejected(error: unknown): boolean {
  if (!(error instanceof MetaApiError)) return false;
  const text = `${error.message} ${JSON.stringify(error.details.blameFieldSpecs ?? "")}`;
  return /degrees_of_freedom|creative_features|contextual_multi_ads/i.test(
    text,
  );
}

async function resolveToken(
  launch: AdsLaunch,
): Promise<{ accessToken: string } | { error: string }> {
  const account = await AdsAccounts.resolveWithToken(launch.projectId);
  if (!("accessToken" in account) || !account.adAccountId) {
    return { error: "Reconnect Meta Ads to continue this launch." };
  }
  if (
    normalizeAdAccountId(account.adAccountId) !==
    normalizeAdAccountId(launch.adAccountExternalId)
  ) {
    return {
      error:
        "The Meta ad account changed since this launch was approved. Launch it again from the card.",
    };
  }
  return { accessToken: account.accessToken };
}

function completedResult(
  launch: AdsLaunch,
  progress: LaunchProgress,
  status: string,
): AdvanceResult {
  return {
    status: "COMPLETED",
    rawResult: {
      launchId: launch.id,
      status,
      campaignId: progress.campaign ?? launch.campaignExternalId ?? null,
      adSetIds: Object.values(progress.adSets ?? {}),
      adIds: Object.values(progress.ads ?? {}),
    },
  };
}

async function failLaunch(
  launch: AdsLaunch,
  error: LaunchError,
): Promise<AdvanceResult> {
  await AdsLaunches.fail(launch.id, error);
  // Teşhis için (token ve harcama yok): hangi adım, hangi Meta kodu, hangi alan.
  console.error(
    `[ads-launch] ${launch.id} failed at ${error.step}: ${error.class} ${error.code ?? "net"}/${error.subcode ?? "-"} field=${error.field ?? "-"} trace=${error.fbtraceId ?? "-"}`,
  );
  return {
    status: "FAILED",
    errorMessage: error.message,
    errorCode: `META:${error.class}:${error.code ?? "net"}${error.subcode ? `/${error.subcode}` : ""}`,
    rawResult: { launchId: launch.id, failedStep: error.step },
  };
}

async function save(
  ctx: Ctx,
  extra: Parameters<typeof AdsLaunches.saveProgress>[2] = {},
) {
  ctx.launch = await AdsLaunches.saveProgress(
    ctx.launch.id,
    ctx.progress,
    extra,
  );
}

async function runCreate(ctx: Ctx): Promise<AdvanceResult> {
  const { spec } = ctx;
  if (
    ["VALIDATED", "AWAITING_APPROVAL", "FAILED", "DRAFT"].includes(
      ctx.launch.status,
    )
  ) {
    await AdsLaunches.transition(
      ctx.launch.id,
      ["VALIDATED", "AWAITING_APPROVAL", "FAILED", "DRAFT"],
      "CREATING",
      { error: Prisma.DbNull },
    );
  }

  // 1) Görseller (hash idempotent; niyet kaydı gerekmez).
  ctx.progress.images = ctx.progress.images ?? {};
  for (const slot of imageSlots(spec.ads)) {
    if (ctx.progress.images[slot.key]) continue;
    if (ctx.writes >= MAX_WRITES) return { status: "RUNNING" };
    const asset = await prisma.asset.findFirst({
      where: { id: slot.assetId, projectId: ctx.launch.projectId },
      select: { storageKey: true },
    });
    if (!asset) {
      return failLaunch(ctx.launch, {
        step: `image:${slot.key}`,
        class: "VALIDATION",
        message: "The ad's picture is gone. Pick the post again.",
      });
    }
    ctx.writes += 1;
    try {
      const uploaded = await uploadMetaAdImage({
        adAccountId: ctx.adAccountId,
        accessToken: ctx.accessToken,
        imageBuffer: await readAsset(asset.storageKey),
      });
      ctx.progress.images[slot.key] = uploaded.imageHash;
      await save(ctx);
    } catch (error) {
      if (notCreated(error) || classifyMetaError(error).class === "TRANSIENT") {
        return { status: "RUNNING" };
      }
      return failLaunch(ctx.launch, launchError(`image:${slot.key}`, error));
    }
  }

  // 1a) Video reklam: Library videosu yüklenir ve Meta'nın işlemesi beklenir
  // (çağrılar arasında; hiçbir yerde uyunmaz).
  if (spec.ads.some((ad) => ad.creative.video)) {
    if (ctx.writes >= MAX_WRITES) return { status: "RUNNING" };
    ctx.writes += 1;
    let step: VideoStep;
    try {
      step = await ensureVideos({
        spec,
        progress: ctx.progress,
        projectId: ctx.launch.projectId,
        adAccountId: ctx.adAccountId,
        accessToken: ctx.accessToken,
      });
    } catch (error) {
      if (notCreated(error) || classifyMetaError(error).class === "TRANSIENT") {
        return { status: "RUNNING" };
      }
      return failLaunch(ctx.launch, launchError("video", error));
    }
    await save(ctx);
    if (step.state === "processing") return { status: "RUNNING" };
    if (step.state === "failed") {
      return failLaunch(ctx.launch, {
        step: "video",
        class: "VALIDATION",
        message: step.message,
      });
    }
  }

  // 1b) Anında form (Leads): Sayfa token'ıyla, kreatiflerden önce.
  if (spec.leadForm && !ctx.progress.leadForm) {
    const form = spec.leadForm;
    const outcome = await step(ctx, {
      kind: "CREATE_CREATIVE",
      stepKey: "leadform",
      request: { name: form.name, higherIntent: form.higherIntent },
      send: async () => {
        const pageToken = await fetchPageAccessToken(spec.pageId, ctx.accessToken);
        const created = await postLeadForm({
          pageId: spec.pageId,
          pageAccessToken: pageToken,
          name: form.name,
          privacyUrl: form.privacyUrl,
          higherIntent: form.higherIntent,
          followUpUrl: spec.ads[0]?.creative.link,
        });
        if (!created.id) throw new MetaApiError("Meta did not return the form id");
        return created.id;
      },
    });
    if (outcome.kind === "pending") return { status: "RUNNING" };
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    ctx.progress.leadForm = outcome.id;
    await save(ctx);
  }

  // 2) Kreatifler.
  ctx.progress.creatives = ctx.progress.creatives ?? {};
  for (const [index, ad] of spec.ads.entries()) {
    if (ctx.progress.creatives[index]) continue;
    const outcome = await step(ctx, {
      kind: "CREATE_CREATIVE",
      stepKey: `creative:${index}`,
      request: {
        name: ad.name,
        link: ad.creative.link,
        ...(ad.creative.cards ? { cards: ad.creative.cards.length } : {}),
      },
      send: async (tagged) => {
        const cards = creativeCards(ad, index, ctx.progress.images);
        if (cards === null) {
          throw new MetaApiError("A carousel card's picture isn't uploaded yet");
        }
        let video: { videoId: string; thumbnailUrl: string } | undefined;
        if (ad.creative.video) {
          const videoId = ctx.progress.videos?.[String(index)];
          const thumbnailUrl = await coverUrl(
            ctx.launch.projectId,
            ad.creative.imageAssetId,
          );
          if (!videoId || !ctx.progress.videoReady?.[String(index)]) {
            throw new MetaApiError("The video isn't ready yet");
          }
          if (!thumbnailUrl) {
            throw new MetaApiError(
              "The cover picture has no public address (cloud storage is off)",
            );
          }
          video = { videoId, thumbnailUrl };
        }
        const base = {
          adAccountId: ctx.adAccountId,
          accessToken: ctx.accessToken,
          name: tagged(ad.name),
          pageId: spec.pageId,
          instagramUserId: spec.instagramUserId,
          imageHash: ctx.progress.images![index]!,
          message: ad.creative.message,
          link: ad.creative.link,
          callToAction: ad.creative.callToAction,
          headline: ad.creative.headline,
          urlTags: ad.urlTags,
          messaging: ad.creative.messaging,
          ...(ctx.progress.leadForm ? { leadFormId: ctx.progress.leadForm } : {}),
          ...(cards ? { cards } : {}),
          ...(video ? { video } : {}),
        };
        const withFeatures =
          spec.creativeFeatures.send && !ctx.progress.featuresFallback;
        try {
          const created = await postCreative({
            ...base,
            features: withFeatures ? spec.creativeFeatures : undefined,
          });
          if (!created.id)
            throw new MetaApiError("Meta did not return the creative id");
          return created.id;
        } catch (error) {
          if (!withFeatures || !featuresRejected(error)) throw error;
          // Özellik listesi bu sürümde kabul edilmedi: onsuz kurulur, not düşülür.
          ctx.progress.featuresFallback = true;
          const created = await postCreative({ ...base, features: undefined });
          if (!created.id)
            throw new MetaApiError("Meta did not return the creative id");
          return created.id;
        }
      },
    });
    if (outcome.kind === "pending") {
      await save(ctx);
      return { status: "RUNNING" };
    }
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    ctx.progress.creatives[index] = outcome.id;
    await save(ctx);
  }

  // F5b: mevcut ad set'e ekleme — kampanya ve ad set kurulmaz; reklamlar o
  // ad set'e eklenir ve incelemeden sonra yayına girer (bütçe değişmez).
  if (spec.existingAdSetId && !ctx.progress.campaign) {
    const parent = await readBack<{ campaign_id?: string }>(
      spec.existingAdSetId,
      ctx.accessToken,
      "campaign_id",
    );
    if (!parent.campaign_id) {
      return failLaunch(ctx.launch, {
        step: "campaign",
        class: "STATE",
        message: "The ad set to add to is gone. Pick another one.",
      });
    }
    ctx.progress.campaign = parent.campaign_id;
    ctx.progress.adSets = { 0: spec.existingAdSetId };
    await save(ctx, { campaignExternalId: parent.campaign_id });
  }

  // 3) Kampanya (PAUSED, spend_cap).
  if (!ctx.progress.campaign) {
    const outcome = await step(ctx, {
      kind: "CREATE_CAMPAIGN",
      stepKey: "campaign",
      edge: "campaigns",
      request: {
        objective: spec.objective,
        spendCapMinor: spec.guards.campaignSpendCapMinor,
      },
      send: async (tagged) => {
        const created = await postCampaign({
          adAccountId: ctx.adAccountId,
          accessToken: ctx.accessToken,
          name: tagged(spec.campaignName),
          objective: spec.objective,
          specialAdCategories: spec.specialAdCategories,
          spendCapMinor: spec.guards.campaignSpendCapMinor,
        });
        if (!created.id)
          throw new MetaApiError("Meta did not return the campaign id");
        return created.id;
      },
    });
    if (outcome.kind === "pending") return { status: "RUNNING" };
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    ctx.progress.campaign = outcome.id;
    await save(ctx, { campaignExternalId: outcome.id });
  }

  // 4) Ad set'ler (ACTIVE; kampanya kapalı olduğu için teslimat yok).
  ctx.progress.adSets = ctx.progress.adSets ?? {};
  if (!ctx.progress.startTime || !ctx.progress.endTime) {
    const start = ctx.now;
    const end = adSetEndTime(
      start,
      spec.budget.durationDays,
      spec.timezone,
      zonedDateTimeToUtc,
      dayKeyInTimezone,
    );
    ctx.progress.startTime = Math.floor(start.getTime() / 1000);
    ctx.progress.endTime = Math.floor(end.getTime() / 1000);
    await save(ctx);
  }
  for (const [index, adSet] of spec.adSets.entries()) {
    if (ctx.progress.adSets[index]) continue;
    const outcome = await step(ctx, {
      kind: "CREATE_ADSET",
      stepKey: `adset:${index}`,
      edge: "adsets",
      parentExternalId: ctx.progress.campaign,
      request: {
        budget: spec.budget,
        endTime: ctx.progress.endTime,
        optimizationGoal: adSet.optimizationGoal,
      },
      send: async (tagged) => {
        const adSetInput = {
          adAccountId: ctx.adAccountId,
          accessToken: ctx.accessToken,
          campaignId: ctx.progress.campaign!,
          name: tagged(adSet.name),
          ...(spec.budget.mode === "FIXED"
            ? { lifetimeBudgetMinor: spec.budget.lifetimeMinor }
            : { dailyBudgetMinor: spec.budget.dailyMinor }),
          startTime: ctx.progress.startTime!,
          endTime: ctx.progress.endTime!,
          optimizationGoal: adSet.optimizationGoal,
          billingEvent: adSet.billingEvent,
          destinationType: adSet.destinationType,
          promotedObject: adSet.promotedObject,
          targeting: adSet.targeting,
          advantageAudience: adSet.advantageAudience,
          dsa: adSet.dsa,
          frequencyControl:
            adSet.optimizationGoal === "REACH"
              ? { maxImpressions: 2, days: 7 }
              : undefined,
          ...(adSet.schedule ? { schedule: adSet.schedule } : {}),
          status: "ACTIVE" as const,
        };
        let created: { id?: string };
        try {
          created = await postAdSet(adSetInput);
        } catch (error) {
          if (!bidAmountRequired(error)) throw error;
          // Reddedilen istek hiçbir şey kurmadı: kampanyaya açık strateji
          // yazılıp bir kez daha denenir. Strateji yazılamazsa asıl hata kalır.
          console.warn(
            "[ads-launch] ad set needs a bid amount (100/1815857); setting the campaign's bid strategy and retrying once",
          );
          try {
            await setCampaignBidStrategy({
              campaignId: ctx.progress.campaign!,
              accessToken: ctx.accessToken,
            });
          } catch (healError) {
            console.warn(
              "[ads-launch] the campaign bid strategy could not be set:",
              healError instanceof Error ? healError.message : healError,
            );
            throw error;
          }
          created = await postAdSet(adSetInput);
        }
        if (!created.id)
          throw new MetaApiError("Meta did not return the ad set id");
        return created.id;
      },
    });
    if (outcome.kind === "pending") return { status: "RUNNING" };
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    ctx.progress.adSets[index] = outcome.id;
    await save(ctx);
  }

  // 5) Reklamlar (ACTIVE).
  ctx.progress.ads = ctx.progress.ads ?? {};
  for (const [index, ad] of spec.ads.entries()) {
    if (ctx.progress.ads[index]) continue;
    const adSetId = ctx.progress.adSets[ad.adSetIndex]!;
    const outcome = await step(ctx, {
      kind: "CREATE_AD",
      stepKey: `ad:${index}`,
      edge: "ads",
      parentExternalId: adSetId,
      request: { name: ad.name, adSetIndex: ad.adSetIndex },
      send: async (tagged) => {
        const created = await postAd({
          adAccountId: ctx.adAccountId,
          accessToken: ctx.accessToken,
          name: tagged(ad.name),
          adSetId,
          creativeId: ctx.progress.creatives![index]!,
          status: "ACTIVE",
        });
        if (!created.id)
          throw new MetaApiError("Meta did not return the ad id");
        return created.id;
      },
    });
    if (outcome.kind === "pending") return { status: "RUNNING" };
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    ctx.progress.ads[index] = outcome.id;
    await save(ctx);
  }

  // Mevcut ad set'e eklenen reklamlar: frenler o ad set'indir; reklamlar
  // ACTIVE kuruldu, kampanyada açma yazması yapılmaz.
  if (spec.existingAdSetId) {
    await AdsLaunches.transition(ctx.launch.id, ["CREATING"], "ACTIVE", { activatedAt: ctx.now });
    return completedResult(ctx.launch, ctx.progress, "ACTIVE");
  }

  // 6) Geri okuma: frenler gerçekten yazıldı mı?
  if (!ctx.progress.verified) {
    const notes: string[] = [];
    let spendCap: number | null = null;
    let endTime: string | null = null;
    try {
      const campaign = await readBack<{ spend_cap?: string; status?: string }>(
        ctx.progress.campaign!,
        ctx.accessToken,
        "spend_cap,status",
      );
      spendCap = campaign.spend_cap ? Number(campaign.spend_cap) : null;
      if (spec.guards.campaignSpendCapMinor && !spendCap)
        notes.push("Campaign spending limit missing");
      if (campaign.status !== "PAUSED")
        notes.push("Campaign is not paused before turning on");
      const firstAdSet = Object.values(ctx.progress.adSets)[0];
      if (firstAdSet) {
        const adSet = await readBack<{ end_time?: string }>(
          firstAdSet,
          ctx.accessToken,
          "end_time",
        );
        endTime = adSet.end_time ?? null;
        if (!endTime) notes.push("Ad set end date missing");
      }
    } catch (error) {
      notes.push(
        `Read-back failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    ctx.progress.verified = {
      at: ctx.now.toISOString(),
      ok: notes.length === 0,
      spendCapMinor: spendCap,
      endTime,
      notes,
    };
    await save(ctx, {
      guards: {
        spendCapMinor: spendCap,
        endTime,
        verifiedAt: ctx.now.toISOString(),
      },
    });
    // Bitiş tarihi yoksa açılmaz: kullanıcı onaylamadığı süresiz harcamaya
    // çıkmasın.
    if (!endTime) {
      return failLaunch(ctx.launch, {
        step: "verify",
        class: "VALIDATION",
        message:
          "Meta didn't keep the end date on the ad set. Nothing was turned on. Try again.",
      });
    }
  }

  // Aynaya: sonraki senkron yapıyı hemen okusun.
  await prisma.adsAccount
    .updateMany({
      where: { externalId: ctx.adAccountId },
      data: { lastStructureAt: new Date(0) },
    })
    .catch(() => undefined);

  if (!ctx.spec.activate) {
    await AdsLaunches.transition(ctx.launch.id, ["CREATING"], "CREATED_PAUSED");
    return completedResult(ctx.launch, ctx.progress, "CREATED_PAUSED");
  }
  return runActivate(ctx);
}

async function runActivate(ctx: Ctx): Promise<AdvanceResult> {
  if (!ctx.progress.campaign) {
    return failLaunch(ctx.launch, {
      step: "activate",
      class: "STATE",
      message: "There is no campaign to turn on yet.",
    });
  }
  await AdsLaunches.transition(
    ctx.launch.id,
    ["CREATING", "CREATED_PAUSED", "FAILED"],
    "ACTIVATING",
  );
  const outcome = await step(ctx, {
    kind: "SET_STATUS",
    stepKey: "activate",
    request: { status: "ACTIVE", level: "CAMPAIGN" },
    send: async () => {
      await setObjectStatus(ctx.progress.campaign!, ctx.accessToken, "ACTIVE");
      return ctx.progress.campaign!;
    },
  });
  if (outcome.kind === "pending") return { status: "RUNNING" };
  if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
  await AdsLaunches.transition(ctx.launch.id, ["ACTIVATING"], "ACTIVE", {
    activatedAt: ctx.now,
  });
  await prisma.adsObject
    .updateMany({
      where: { externalId: ctx.progress.campaign },
      data: { configuredStatus: "ACTIVE" },
    })
    .catch(() => undefined);
  return completedResult(ctx.launch, ctx.progress, "ACTIVE");
}

// "Discard" (§3.4 telafi): kampanya düzeyinde tek yazma; alt nesneler durumu
// miras alır. Hiç gösterim almamış kampanya DELETED, almış olan ARCHIVED
// (silinen nesnenin harcaması yalnız kimlikle okunabilir).
async function runDiscard(ctx: Ctx): Promise<AdvanceResult> {
  await AdsLaunches.transition(
    ctx.launch.id,
    [
      "FAILED",
      "CREATED_PAUSED",
      "CREATING",
      "VALIDATED",
      "AWAITING_APPROVAL",
      "DRAFT",
      "ACTIVE",
    ],
    "DISCARDING",
  );
  const campaign = ctx.progress.campaign ?? ctx.launch.campaignExternalId;
  if (campaign) {
    let target: "DELETED" | "ARCHIVED" = "ARCHIVED";
    try {
      target =
        (await lifetimeImpressions(campaign, ctx.accessToken)) > 0
          ? "ARCHIVED"
          : "DELETED";
    } catch {
      // Okunamazsa güvenli taraf: arşiv (harcama kimlikle okunmaya devam eder).
    }
    const outcome = await step(ctx, {
      kind: "SET_STATUS",
      stepKey: "discard",
      request: { status: target, level: "CAMPAIGN" },
      send: async () => {
        await setObjectStatus(campaign, ctx.accessToken, target);
        return campaign;
      },
    });
    if (outcome.kind === "pending") return { status: "RUNNING" };
    if (outcome.kind === "failed") return failLaunch(ctx.launch, outcome.error);
    await prisma.adsObject
      .updateMany({
        where: { externalId: campaign },
        data: { effectiveStatus: target, goneAt: ctx.now },
      })
      .catch(() => undefined);
  }
  await AdsLaunches.transition(ctx.launch.id, ["DISCARDING"], "DISCARDED");
  return completedResult(ctx.launch, ctx.progress, "DISCARDED");
}

export const LaunchExecutor = {
  async advance(
    launchId: string,
    mode: LaunchMode,
    options: { actorType?: "USER" | "SYSTEM"; now?: Date } = {},
  ): Promise<AdvanceResult> {
    const now = options.now ?? new Date();
    const launch = await AdsLaunches.get(launchId);
    if (!launch) return { status: "FAILED", errorMessage: "Launch not found" };

    // Bu mod için zaten bitmiş durumlar.
    if (
      mode === "create" &&
      (launch.status === "ACTIVE" || launch.status === "CREATED_PAUSED")
    ) {
      return completedResult(launch, progressOf(launch), launch.status);
    }
    if (mode === "activate" && launch.status === "ACTIVE") {
      return completedResult(launch, progressOf(launch), "ACTIVE");
    }
    if (mode === "discard" && launch.status === "DISCARDED") {
      return completedResult(launch, progressOf(launch), "DISCARDED");
    }
    if (
      launch.status === "DISCARDED" ||
      launch.status === "CANCELLED" ||
      launch.status === "EXPIRED"
    ) {
      return { status: "FAILED", errorMessage: "This launch was closed." };
    }
    // Acil durdurma: yeni harcama yolu kapalı; Discard serbest.
    if (mode !== "discard" && AdsFlags.writesDisabled()) {
      return {
        status: "FAILED",
        errorMessage: "Ad changes are paused by Agentelse for now.",
      };
    }
    const spec = parseLaunchSpec(launch.spec);
    if (!spec)
      return failLaunch(launch, {
        step: "spec",
        class: "VALIDATION",
        message: "The launch plan is unreadable. Launch it again.",
      });

    const owner = randomUUID();
    if (!(await AdsLaunches.claim(launchId, owner, now)))
      return { status: "RUNNING" };
    try {
      const token = await resolveToken(launch);
      if ("error" in token) {
        return failLaunch(launch, {
          step: "account",
          class: "AUTH",
          message: token.error,
        });
      }
      const ctx: Ctx = {
        launch,
        spec,
        progress: progressOf(launch),
        accessToken: token.accessToken,
        adAccountId: normalizeAdAccountId(launch.adAccountExternalId),
        actorType: options.actorType ?? "USER",
        now,
        writes: 0,
      };
      return await withMetaCallContext(
        {
          account: ctx.adAccountId,
          // Discard riski azaltır: güvenlik şeridinde koşar.
          lane: mode === "discard" ? "P0_SAFETY" : "P1_USER",
          family: "ads_management",
          callSite: `launch.${mode}`,
        },
        async () => {
          try {
            if (mode === "discard") return await runDiscard(ctx);
            if (mode === "activate") return await runActivate(ctx);
            return await runCreate(ctx);
          } catch (error) {
            if (
              notCreated(error) ||
              classifyMetaError(error).class === "TRANSIENT"
            ) {
              return { status: "RUNNING" as const };
            }
            return failLaunch(ctx.launch, launchError(mode, error));
          }
        },
      );
    } finally {
      await AdsLaunches.release(launchId, owner);
    }
  },
};
