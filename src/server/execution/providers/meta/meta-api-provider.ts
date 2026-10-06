import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  readAsset,
  resolveDirectPublicUrl,
} from "@/server/storage/asset-storage";
import {
  META_PROVIDER,
  META_SERVICE_LABEL,
  checkMetaVideoStatus,
  createMetaAd,
  createMetaAdCreative,
  createMetaAdSet,
  createMetaCampaign,
  createMetaCarouselAdCreative,
  createMetaVideoAdCreative,
  fetchMetaObjectAccountId,
  fetchPageAccessToken,
  findMetaObjectsByTag,
  listMetaCampaigns,
  MetaApiError,
  normalizeAdAccountId,
  publishFacebookPagePost,
  publishInstagramPost,
  updateMetaAd,
  updateMetaAdSet,
  updateMetaCampaign,
  uploadMetaAdImage,
  uploadMetaAdVideo,
  type MetaAdSetTargeting,
  type MetaAdsMetadata,
  type MetaFacebookMetadata,
  type MetaInstagramMetadata,
  type MetaService,
} from "@/server/integrations/meta-client";
import {
  instagramAccessFor,
  instagramLoginExpired,
  resolveInstagramTarget,
} from "@/server/integrations/instagram-target";
import {
  DATE_PRESETS,
  DEFAULT_DATE_PRESET,
  isDatePreset,
  MetaAdsQuery,
} from "@/server/integrations/meta-ads-query";
import {
  isExpiredTokenError,
  markMetaCredentialExpiredOn,
} from "@/server/integrations/meta-credential-health";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import {
  classifyMetaError,
  metaErrorCode,
  metaUserMessage,
} from "@/server/integrations/meta/error-catalog";
import { AdsOperations } from "@/server/ads/operations";
import { LaunchExecutor } from "@/server/ads/launch/executor";
import { readBack } from "@/server/integrations/meta/launch-writes";
import { taggedName } from "@/lib/ads/operation-tag";
import {
  loadProviderResult,
  saveProviderResult,
  type ProviderResult,
} from "./provider-results";
import { buildAdsAnalysisText } from "./meta-ads-analysis-text";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// The real Meta Graph/Marketing API — used instead of OpenClawProvider's
// browser automation whenever the project has a Meta account connected via
// OAuth. Registered before OpenClawProvider in provider-registry.ts: the
// real API is always preferred over screen scraping.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "INSTAGRAM_PUBLISH",
  "FACEBOOK_PUBLISH",
  "META_ADS_ANALYSIS",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_AD_CREATE",
  "META_AD_UPDATE",
  "META_SAFETY_ACTION",
  "META_LAUNCH",
]);

// Sonuçlar süreç belleğinde değil ExecutionJob.rawResult'ta tutulur
// (provider-results.ts; docs/meta-ads-plan.md F1).
type StoredResult = ProviderResult;

// Bir yazmanın niyet günlüğü bağlamı (AdsOperation).
type IntentContext = {
  executionJobId: string;
  workspaceId: string;
  projectId: string;
  actorType: "USER" | "SYSTEM";
};

// Yanıtı kaybolan oluşturma: 30 sn sonra etiketle aranır, 150 sn'de
// bulunmazsa kör tekrar yapılmadan kapatılır.
const RECONCILE_AFTER_MS = 30_000;
const RECONCILE_GIVE_UP_MS = 150_000;

// A META_AD_CREATE or META_AD_UPDATE with format "VIDEO" can't resolve
// synchronously like every other capability here — Meta's own video
// processing can take minutes (see checkMetaVideoStatus in meta-client.ts).
// Following OpenClawProvider's pattern (src/server/execution/providers/
// openclaw/openclaw-provider.ts): execute() only starts the upload and
// returns immediately; getStatus() is polled repeatedly by
// ExecutionWorker.pollRunningJobs() across ticks and finishes the ad
// creative/ad creation (or ad update) the first time it observes the video
// is ready. `projectId` (not a cached credential) is stored so each poll
// re-resolves the Meta credential fresh, the same way runCapability()
// always does — no decrypted access token is held in memory between polls.
// `mode` distinguishes the two finish actions (create a new Ad vs point an
// EXISTING Ad at the new creative) pollVideoAd takes once the video is
// ready — see updateAd's non-video branches for the same create/update
// split applied to the single-image and carousel formats.
type PendingVideoAd =
  | {
      mode: "create";
      projectId: string;
      videoId: string;
      thumbnailUrl: string;
      adSetId: string;
      name: string;
      message: string;
      link: string;
      callToActionType: string;
      status: "ACTIVE" | "PAUSED";
    }
  | {
      mode: "update";
      projectId: string;
      videoId: string;
      thumbnailUrl: string;
      adId: string;
      name?: string;
      message: string;
      link: string;
      callToActionType: string;
      status?: "ACTIVE" | "PAUSED";
    };

const pendingVideoAds = new Map<string, PendingVideoAd>();

// Durability for the video-ad async path — same shape as
// openclaw-provider.ts's persistRunToRawResult/recoverRunFromRawResult
// (read-merge-write into ExecutionJob.rawResult, best-effort, errors
// swallowed since the upload itself has already happened regardless).
// Without this, a restart between "video uploaded" and "creative/ad
// created" wiped `pendingVideoAds` and the next poll returned a permanent,
// misleading "Unknown Meta API execution reference" FAILED — even though
// the video had already uploaded successfully to the ad account.
async function persistPendingVideoAdToRawResult(
  executionJobId: string,
  record: PendingVideoAd,
): Promise<void> {
  try {
    const existing = await prisma.executionJob.findUnique({
      where: { id: executionJobId },
      select: { rawResult: true },
    });
    const base =
      existing?.rawResult && typeof existing.rawResult === "object"
        ? (existing.rawResult as Record<string, unknown>)
        : {};
    await prisma.executionJob.update({
      where: { id: executionJobId },
      data: { rawResult: { ...base, pendingVideoAd: record } as never },
    });
  } catch (error) {
    console.error(
      "[meta-api-provider] failed to persist pending video ad to rawResult:",
      error,
    );
  }
}

function isPendingVideoAd(value: unknown): value is PendingVideoAd {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.projectId !== "string" ||
    typeof v.videoId !== "string" ||
    typeof v.thumbnailUrl !== "string" ||
    typeof v.message !== "string" ||
    typeof v.link !== "string" ||
    typeof v.callToActionType !== "string"
  ) {
    return false;
  }
  if (v.mode === "create") {
    return typeof v.adSetId === "string" && typeof v.name === "string";
  }
  if (v.mode === "update") {
    return typeof v.adId === "string";
  }
  return false;
}

// Clears the persisted record at the same moment pendingVideoAds.delete() is
// called, right before the (non-idempotent) ad-creation calls — see
// pollVideoAd. Without this, a crash between "video confirmed ready" and
// "ad-creation call acknowledged" would, on the recovered process's next
// poll, replay checkMetaVideoStatus -> ready -> createMetaVideoAdCreative/
// createMetaAd a SECOND time (Meta's ad-creation calls here carry no
// client-supplied idempotency key), risking a duplicate live ad with real
// spend. Clearing first means that crash window degrades to today's safe
// "Unknown execution reference" FAILED instead.
async function clearPendingVideoAdFromRawResult(
  executionReference: string,
): Promise<void> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { correlationId: executionReference },
      select: { id: true, rawResult: true },
    });
    if (!job || !job.rawResult || typeof job.rawResult !== "object") return;
    const rest = { ...(job.rawResult as Record<string, unknown>) };
    delete rest.pendingVideoAd;
    await prisma.executionJob.update({
      where: { id: job.id },
      data: { rawResult: rest as never },
    });
  } catch (error) {
    console.error(
      "[meta-api-provider] failed to clear pending video ad from rawResult:",
      error,
    );
  }
}

async function recoverPendingVideoAdFromRawResult(
  executionReference: string,
): Promise<PendingVideoAd | undefined> {
  try {
    const job = await prisma.executionJob.findUnique({
      where: { correlationId: executionReference },
      select: { rawResult: true },
    });
    const raw = job?.rawResult;
    if (!raw || typeof raw !== "object") return undefined;
    const candidate = (raw as Record<string, unknown>).pendingVideoAd;
    if (!isPendingVideoAd(candidate)) return undefined;
    pendingVideoAds.set(executionReference, candidate);
    return candidate;
  } catch (error) {
    console.error(
      "[meta-api-provider] failed to recover pending video ad from rawResult:",
      error,
    );
    return undefined;
  }
}

// Instagram, Facebook and Meta Ads are separate integrations with separate
// credentials: INSTAGRAM_PUBLISH reads the "instagram" one, FACEBOOK_PUBLISH
// the "facebook" one, every other capability here (campaigns/adsets/ads/
// analysis) reads "meta_ads".
async function findActiveMetaCredential(
  projectId: string,
  service: MetaService,
) {
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: META_PROVIDER[service] },
    },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

function serviceFor(capability: CapabilityKey): MetaService {
  if (capability === "INSTAGRAM_PUBLISH") return "instagram";
  if (capability === "FACEBOOK_PUBLISH") return "facebook";
  return "ads";
}

// The Page a FACEBOOK_PUBLISH posts to: the one selected in the Facebook
// integration, and only while it is still in that connection's Page list.
function selectedFacebookPage(metadata: Partial<MetaFacebookMetadata> | null) {
  if (!metadata?.selectedPageId) return null;
  return (
    metadata.pages?.find((p) => p.pageId === metadata.selectedPageId) ?? null
  );
}

// Exported so callers deciding WHETHER to even propose Meta ads work (e.g.
// the autonomous campaign-proposal trigger in approval-decisions.ts) share
// the exact same "is an ad account actually connected" check canExecute()
// uses below for META_CAMPAIGN_CREATE/META_ADSET_CREATE, instead of
// re-deriving it and risking drift. Deliberately narrower than
// getPublishTargets (meta-connection-status.ts), which only checks the
// Page/Instagram side used for organic publishing — an ad ACCOUNT is a
// separate prerequisite Meta requires for any paid campaign/adset/ad write.
export async function hasActiveMetaAdsAccount(
  projectId: string,
): Promise<boolean> {
  const credential = await findActiveMetaCredential(projectId, "ads");
  if (!credential) return false;
  const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
  return Boolean(metadata.selectedAdAccountId);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

function readCampaignStatus(value: unknown): "ACTIVE" | "PAUSED" | undefined {
  return value === "ACTIVE" || value === "PAUSED" ? value : undefined;
}

function readBudgetCents(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Resolves the image_hash for ONE creative image slot (the single-image ad
// itself, or one carousel card): either uploads a freshly provided local
// asset, or — edit-only — reuses an already-uploaded hash carried over from
// the ad's CURRENT creative when the user didn't replace that image. Meta's
// adimages library lets a brand-new creative reference an existing hash
// without re-uploading, which is what makes "edit only the message, leave
// the picture alone" possible without forcing a redundant re-upload.
async function resolveImageHash(
  adAccountId: string,
  accessToken: string,
  projectId: string,
  ref: { assetId?: string; existingHash?: string },
): Promise<{ ok: true; imageHash: string } | { ok: false; error: string }> {
  if (ref.assetId) {
    const asset = await prisma.asset.findFirst({
      where: { id: ref.assetId, projectId },
      select: { storageKey: true },
    });
    if (!asset) return { ok: false, error: "Image asset not found" };
    try {
      const buffer = await readAsset(asset.storageKey);
      const uploaded = await uploadMetaAdImage({
        adAccountId,
        accessToken,
        imageBuffer: buffer,
      });
      return { ok: true, imageHash: uploaded.imageHash };
    } catch (error) {
      return {
        ok: false,
        error: `Image upload failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (ref.existingHash) return { ok: true, imageHash: ref.existingHash };
  return { ok: false, error: "An image is required" };
}

// Görevin yükü onay anındaki reklam hesabını taşır. Seçim o zamandan beri
// değiştiyse yazma yapılmaz: kampanya bir hesapta, ad set başka hesapta
// kurulamaz (docs/meta-ads-plan.md F0b).
function accountChangedSinceApproval(
  metadata: MetaAdsMetadata,
  payload: Record<string, unknown>,
): string | null {
  const pinned =
    typeof payload.adAccountId === "string" ? payload.adAccountId : undefined;
  if (!pinned || !metadata.selectedAdAccountId) return null;
  return normalizeAdAccountId(pinned) ===
    normalizeAdAccountId(metadata.selectedAdAccountId)
    ? null
    : "Ad account changed since approval";
}

// Güncellenecek nesnenin hesabı (10 dk önbellek): aynı ajans token'ıyla başka
// bir müşterinin kampanyası değiştirilemez.
const objectAccountCache = new Map<string, { accountId: string; at: number }>();
const OBJECT_ACCOUNT_TTL_MS = 10 * 60_000;

async function objectOutsideAccount(
  objectId: string,
  accessToken: string,
  metadata: MetaAdsMetadata,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const changed = accountChangedSinceApproval(metadata, payload);
  if (changed) return changed;
  const expected =
    typeof payload.adAccountId === "string"
      ? payload.adAccountId
      : metadata.selectedAdAccountId;
  if (!expected) return "No ad account selected";
  const cached = objectAccountCache.get(objectId);
  let accountId: string;
  if (cached && Date.now() - cached.at < OBJECT_ACCOUNT_TTL_MS) {
    accountId = cached.accountId;
  } else {
    accountId = await fetchMetaObjectAccountId({ objectId, accessToken });
    objectAccountCache.set(objectId, { accountId, at: Date.now() });
  }
  return accountId === normalizeAdAccountId(expected)
    ? null
    : "Ad account mismatch: this object belongs to another ad account";
}

// Ad set'in çalışma penceresi (UNIX saniyesi): eski sihirbazın mutlak
// `endTime`'ı (ISO, gelecekte olmalı) ya da modül akışının `durationDays`'i
// (şimdi + gün). İkisi de yoksa pencere yok: o tarihten önce açılmış eski
// görevler bugünkü gibi bitişsiz kurulur.
export function adSetTimeWindow(
  payload: Record<string, unknown>,
  now: Date,
): { start: number; end: number } | null {
  const start = Math.floor(now.getTime() / 1000);
  if (typeof payload.endTime === "string") {
    const end = Date.parse(payload.endTime);
    if (Number.isFinite(end) && end > now.getTime()) {
      return { start, end: Math.floor(end / 1000) };
    }
  }
  const days = payload.durationDays;
  if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
    return null;
  }
  return { start, end: start + Math.round(days * 24 * 3600) };
}

function readDsa(value: unknown): { beneficiary: string; payor: string } | null {
  if (!value || typeof value !== "object") return null;
  const { beneficiary, payor } = value as Record<string, unknown>;
  if (typeof beneficiary !== "string" || typeof payor !== "string") return null;
  if (!beneficiary.trim() || !payor.trim()) return null;
  return { beneficiary: beneficiary.trim(), payor: payor.trim() };
}

// Görevi kimin açtığı (niyet günlüğü aktörü).
async function taskActor(taskId: string): Promise<"USER" | "SYSTEM"> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { createdByType: true },
    });
    return task?.createdByType === "USER" ? "USER" : "SYSTEM";
  } catch {
    return "SYSTEM";
  }
}

// Meta hatası -> başarısız sonuç: kullanıcıya Meta'nın kendi metni, işe
// yapısal kod (META:SINIF:kod) — sağlayıcı sağlığı yalnız geçici Meta
// arızalarında düşer (docs/meta-ads-plan.md F1).
function failedResult(error: unknown, prefix = ""): StoredResult {
  const message =
    error instanceof MetaApiError && error.details.userMessage
      ? error.details.userMessage
      : error instanceof Error
        ? error.message
        : String(error);
  const classification = classifyMetaError(error);
  return {
    status: "FAILED",
    errorMessage: `${prefix}${message}`,
    errorCode: metaErrorCode(error),
    retryable: classification.class === "TRANSIENT",
  };
}

function operationErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { userMessage?: unknown; message?: unknown };
    if (typeof record.userMessage === "string" && record.userMessage) {
      return record.userMessage;
    }
    if (typeof record.message === "string" && record.message) {
      return record.message;
    }
  }
  return "Meta didn't accept it.";
}

// Yalnız durdurma isteyen güncelleme (acil durdurmada geçer).
function isPauseOnly(payload: Record<string, unknown>): boolean {
  const status = payload.status ?? payload.proposedStatus;
  return (
    status === "PAUSED" &&
    payload.dailyBudgetCents === undefined &&
    payload.proposedDailyBudgetCents === undefined &&
    payload.targeting === undefined &&
    payload.creativeId === undefined
  );
}

// Güncelleme isteğinin token'sız özeti (niyet kaydı).
const UPDATE_REQUEST_KEYS = [
  "status",
  "proposedStatus",
  "dailyBudgetCents",
  "proposedDailyBudgetCents",
  "name",
  "targeting",
  "endTime",
  "creativeId",
] as const;

function updateRequestSummary(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of UPDATE_REQUEST_KEYS) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }
  return summary;
}

// F4 CAS: kararın beklediği değer (bütçe ya da durum) Meta'da hâlâ öyle mi?
// Beklenen alan yoksa (elle düzenleme, eski öneri) kontrol yapılmaz.
async function decisionSuperseded(
  objectId: string,
  payload: Record<string, unknown>,
  accessToken: string,
): Promise<StoredResult | null> {
  const expectedBudget =
    typeof payload.expectedDailyBudgetCents === "number" ? payload.expectedDailyBudgetCents : null;
  const expectedStatus = typeof payload.expectedStatus === "string" ? payload.expectedStatus : null;
  if (expectedBudget === null && expectedStatus === null) return null;
  const fields = [
    ...(expectedBudget !== null ? ["daily_budget"] : []),
    ...(expectedStatus !== null ? ["configured_status"] : []),
  ].join(",");
  const read = await readBack<{ daily_budget?: string; configured_status?: string }>(
    objectId,
    accessToken,
    fields,
  );
  const budgetMoved = expectedBudget !== null && Number(read.daily_budget ?? NaN) !== expectedBudget;
  const statusMoved = expectedStatus !== null && read.configured_status !== expectedStatus;
  if (!budgetMoved && !statusMoved) return null;
  return {
    status: "FAILED",
    errorMessage: "This changed in Meta since it was suggested, so it wasn't applied.",
    errorCode: "META:STATE:superseded",
  };
}

export class MetaApiProvider implements ExecutionProvider {
  readonly key = "meta-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    // Instagram Login has its own app credentials, so a project connected that
    // way can publish even where only those are set.
    return (
      isIntegrationConfigured("META") ||
      isIntegrationConfigured("INSTAGRAM_LOGIN")
    );
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;

    const credential = await findActiveMetaCredential(
      context.projectId,
      serviceFor(capability),
    );
    if (!credential) return false;

    if (capability === "FACEBOOK_PUBLISH") {
      return (
        selectedFacebookPage(
          credential.metadata as Partial<MetaFacebookMetadata> | null,
        ) !== null
      );
    }
    if (capability === "INSTAGRAM_PUBLISH") {
      const igMetadata = credential.metadata as Partial<MetaInstagramMetadata> | null;
      // Past its 60 days an Instagram Login token is dead: do not even try.
      return (
        !instagramLoginExpired(igMetadata) &&
        resolveInstagramTarget(igMetadata) !== null
      );
    }
    const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
    if (capability === "META_AD_CREATE") {
      // createAd() always needs a selected Facebook Page to build the
      // AdCreative's object_story_spec — unlike INSTAGRAM_PUBLISH, it
      // doesn't need that page to have a linked Instagram account.
      const page = metadata.pages?.find(
        (p) => p.pageId === metadata.selectedPageId,
      );
      return Boolean(metadata.selectedAdAccountId) && Boolean(page);
    }
    // META_AD_UPDATE is deliberately NOT checked for a Page here (unlike
    // META_AD_CREATE) — canExecute has no access to the Task payload
    // (ExecutionPolicyContext carries no payload field), so it can't tell a
    // pure name/status edit (updateAd's `!format` branch, which never
    // touches a Page at all — see updateMetaAd in meta-client.ts) apart
    // from a creative-content edit (which does need one). Requiring a Page
    // unconditionally here would make even a status toggle un-executable
    // for a project that has an ad account selected but no Page selected.
    // A creative edit that genuinely needs a Page and doesn't have one
    // still fails, just one layer down, inside updateAd's own per-branch
    // check, with a clear "No Facebook Page selected" error.
    return Boolean(metadata.selectedAdAccountId);
  }

  // Meta Graph/Marketing API calls are synchronous and return within
  // seconds — we follow OpenClawProvider's "run synchronously, cache the
  // result" pattern: execute() runs the operation start-to-finish here,
  // storing a FAILED result instead of throwing on error; getStatus() just
  // reads it back. The one exception is a video-format META_AD_CREATE — see
  // startVideoAd/pollVideoAd below — which genuinely can't resolve within a
  // single tick, so it's routed to the async pendingVideoAds path instead.
  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const payload = payloadRecord(request.payload);
    if (request.capability === "META_LAUNCH") {
      await this.startLaunch(request, payload);
      return { executionReference: request.correlationId, isMock: false };
    }
    const isVideoFormat = payload.format === "VIDEO";
    // A NEW video file (create always requires one; an update requiring one
    // is signaled by `videoAssetId`) needs uploading + Meta's async
    // processing wait — see startVideoAd (whose own validation reports a
    // missing videoAssetId, so create's video path always routes here
    // regardless of whether the field is actually present). An UPDATE that
    // instead sends `existingVideoId` (keeping the current, already-
    // processed video) skips this entirely and resolves synchronously
    // inside updateAd's video branch below, since there's nothing left to
    // wait for.
    const needsAsyncVideoUpload =
      isVideoFormat &&
      (request.capability === "META_AD_CREATE" ||
        (request.capability === "META_AD_UPDATE" &&
          typeof payload.videoAssetId === "string"));
    if (needsAsyncVideoUpload) {
      await this.startVideoAd(request);
      return { executionReference: request.correlationId, isMock: false };
    }
    const result = await this.runCapability(request);
    await saveProviderResult(request.correlationId, result);
    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const pending =
      pendingVideoAds.get(executionReference) ??
      (await recoverPendingVideoAdFromRawResult(executionReference));
    if (pending) {
      return this.pollVideoAd(executionReference, pending);
    }
    const record = await loadProviderResult(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown Meta API execution reference",
        isMock: false,
      };
    }
    if (record.status === "RUNNING" && record.pendingOperationId) {
      return this.pollOperation(executionReference, record);
    }
    if (record.status === "RUNNING" && record.launchId) {
      return this.pollLaunch(executionReference, record);
    }
    return {
      status: record.status,
      rawResult: record.rawResult,
      errorMessage: record.errorMessage,
      errorCode: record.errorCode,
      retryable: record.retryable,
      isMock: false,
    };
  }

  // Uploads the video (bounded, synchronous — same class of wait as an
  // image upload) and stores just enough to finish the job later; never
  // throws — same "store a FAILED result instead" convention as
  // runCapability(), just via pendingVideoAds' sibling `store` map so a
  // failed start is indistinguishable from any other failed capability to
  // the very next getStatus() call. Handles BOTH META_AD_CREATE (new ad)
  // and META_AD_UPDATE (existing ad, new creative) — see PendingVideoAd's
  // `mode` field.
  private async startVideoAd(request: ExecutionRequest): Promise<void> {
    const fail = (errorMessage: string): Promise<void> =>
      saveProviderResult(request.correlationId, {
        status: "FAILED",
        errorMessage,
      });
    const isUpdate = request.capability === "META_AD_UPDATE";

    const credential = await findActiveMetaCredential(
      request.context.projectId,
      "ads",
    );
    if (!credential) return fail("Meta Ads connection not found");
    const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
    if (!metadata.selectedAdAccountId) return fail("No ad account selected");
    const accessToken = decryptSecret(credential.encryptedSecret);

    const payload = payloadRecord(request.payload);
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const link = typeof payload.link === "string" ? payload.link : undefined;
    const callToActionType =
      typeof payload.callToActionType === "string"
        ? payload.callToActionType
        : "LEARN_MORE";
    const videoAssetId =
      typeof payload.videoAssetId === "string"
        ? payload.videoAssetId
        : undefined;
    const thumbnailAssetId =
      typeof payload.thumbnailAssetId === "string"
        ? payload.thumbnailAssetId
        : undefined;
    const status =
      payload.status === "ACTIVE" || payload.status === "PAUSED"
        ? payload.status
        : undefined;
    if (!message || !link || !videoAssetId || !thumbnailAssetId) {
      return fail(
        `${request.capability} (video) requires \`message\`, \`link\`, \`videoAssetId\` and \`thumbnailAssetId\``,
      );
    }

    const adSetId =
      typeof payload.adSetId === "string" ? payload.adSetId : undefined;
    const adId = typeof payload.adId === "string" ? payload.adId : undefined;
    if (isUpdate) {
      if (!adId) return fail("META_AD_UPDATE (video) requires `adId`");
    } else if (!adSetId || !name) {
      return fail(
        "META_AD_CREATE (video) requires `adSetId`, `name`, `message`, `link`, `videoAssetId` and `thumbnailAssetId`",
      );
    }

    // Scoped by projectId, not just id — Task.payload is untyped JSON, and
    // an unscoped lookup would let a mis-sourced assetId from any project
    // have its bytes read and uploaded to THIS project's Meta ad account.
    const [videoAsset, thumbnailAsset] = await Promise.all([
      prisma.asset.findFirst({
        where: { id: videoAssetId, projectId: request.context.projectId },
        select: { storageKey: true, mimeType: true },
      }),
      prisma.asset.findFirst({
        where: { id: thumbnailAssetId, projectId: request.context.projectId },
        select: { storageKey: true },
      }),
    ]);
    if (!videoAsset) return fail("Ad video asset not found");
    const thumbnailUrl = thumbnailAsset
      ? resolveDirectPublicUrl(thumbnailAsset.storageKey)
      : null;
    if (!thumbnailUrl) {
      return fail(
        "Ad video thumbnail has no public URL (R2 storage is required for video ads)",
      );
    }

    try {
      const buffer = await readAsset(videoAsset.storageKey);
      const { videoId } = await uploadMetaAdVideo({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        videoBuffer: buffer,
        mimeType: videoAsset.mimeType,
      });
      if (isUpdate) {
        const record: PendingVideoAd = {
          mode: "update",
          projectId: request.context.projectId,
          videoId,
          thumbnailUrl,
          adId: adId!,
          name,
          message,
          link,
          callToActionType,
          status,
        };
        pendingVideoAds.set(request.correlationId, record);
        await persistPendingVideoAdToRawResult(request.executionJobId, record);
      } else {
        const record: PendingVideoAd = {
          mode: "create",
          projectId: request.context.projectId,
          videoId,
          thumbnailUrl,
          adSetId: adSetId!,
          name: name!,
          message,
          link,
          callToActionType,
          status: status ?? "PAUSED",
        };
        pendingVideoAds.set(request.correlationId, record);
        await persistPendingVideoAdToRawResult(request.executionJobId, record);
      }
    } catch (error) {
      await fail(
        `Video upload step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Called by getStatus() on every poll while a video ad is pending.
  // Credentials are re-resolved fresh each time (never cached across
  // polls) — same reasoning as the projectId-only PendingVideoAd comment
  // above.
  private async pollVideoAd(
    executionReference: string,
    pending: PendingVideoAd,
  ): Promise<ProviderExecutionStatus> {
    // Unlike every other getStatus() in this codebase (a pure in-memory
    // Map read), this one does live DB + decryption I/O on every single
    // poll — a transient DB error or a malformed secret here must not
    // propagate: it isn't an AgentelseError, so ExecutionWorker.
    // pollRunningJobs()'s per-job catch (`if (!isAgentelseError(error))
    // throw error;`) would otherwise rethrow it, aborting the WHOLE tick's
    // poll loop (every other RUNNING job that tick, plus every later stage
    // — resolvePendingVerifications, the Agency OS loop — since
    // pollRunningJobs() isn't wrapped in tick()'s isolate() helper the way
    // the earlier stages are).
    let metadata: MetaAdsMetadata;
    let accessToken: string;
    try {
      const credential = await findActiveMetaCredential(
        pending.projectId,
        "ads",
      );
      if (!credential) {
        pendingVideoAds.delete(executionReference);
        return {
          status: "FAILED",
          errorMessage: "Meta Ads connection not found",
          isMock: false,
        };
      }
      metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
      accessToken = decryptSecret(credential.encryptedSecret);
    } catch (error) {
      pendingVideoAds.delete(executionReference);
      return {
        status: "FAILED",
        errorMessage: `Could not resolve Meta credentials: ${error instanceof Error ? error.message : String(error)}`,
        isMock: false,
      };
    }

    let ready: boolean;
    try {
      ready = await checkMetaVideoStatus({
        videoId: pending.videoId,
        accessToken,
      });
    } catch (error) {
      pendingVideoAds.delete(executionReference);
      return {
        status: "FAILED",
        errorMessage: `Video processing check failed: ${error instanceof Error ? error.message : String(error)}`,
        isMock: false,
      };
    }
    if (!ready) {
      return { status: "RUNNING", isMock: false };
    }

    pendingVideoAds.delete(executionReference);
    // Best-effort, before the non-idempotent ad-creation calls below — see
    // clearPendingVideoAdFromRawResult's comment. A crash after this point
    // degrades to a safe "Unknown execution reference" FAILED on the next
    // poll instead of a replayed, potentially duplicate ad creation.
    await clearPendingVideoAdFromRawResult(executionReference);
    if (!metadata.selectedAdAccountId) {
      return {
        status: "FAILED",
        errorMessage: "No ad account selected",
        isMock: false,
      };
    }
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page) {
      return {
        status: "FAILED",
        errorMessage: "No Facebook Page selected for the ad creative",
        isMock: false,
      };
    }

    try {
      const created = await createMetaVideoAdCreative({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        pageId: page.pageId,
        videoId: pending.videoId,
        thumbnailUrl: pending.thumbnailUrl,
        message: pending.message,
        link: pending.link,
        callToActionType: pending.callToActionType,
      });
      if (pending.mode === "update") {
        await updateMetaAd({
          adId: pending.adId,
          accessToken,
          name: pending.name,
          status: pending.status,
          creativeId: created.creativeId,
        });
        return {
          status: "COMPLETED",
          isMock: false,
          rawResult: {
            adId: pending.adId,
            creativeId: created.creativeId,
            videoId: pending.videoId,
          },
        };
      }
      const { adId } = await createMetaAd({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        adSetId: pending.adSetId,
        name: pending.name,
        creativeId: created.creativeId,
        status: pending.status,
      });
      return {
        status: "COMPLETED",
        isMock: false,
        rawResult: {
          adId,
          creativeId: created.creativeId,
          videoId: pending.videoId,
        },
      };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Video ad creative/ad ${pending.mode === "update" ? "update" : "creation"} failed (video ${pending.videoId} was processed): ${error instanceof Error ? error.message : String(error)}`,
        isMock: false,
      };
    }
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const service = serviceFor(request.capability);
    const credential = await findActiveMetaCredential(
      request.context.projectId,
      service,
    );
    if (!credential) {
      return {
        status: "FAILED",
        errorMessage: `${META_SERVICE_LABEL[service]} connection not found`,
      };
    }
    const metadata = (credential.metadata ?? {}) as MetaAdsMetadata;
    const accessToken = decryptSecret(credential.encryptedSecret);
    const payload = payloadRecord(request.payload);
    const intent: IntentContext = {
      executionJobId: request.executionJobId,
      workspaceId: request.context.workspaceId,
      projectId: request.context.projectId,
      actorType: await taskActor(request.context.taskId),
    };
    // Reklam çağrıları hesabın kotasını harcar: governor bu bağlamdan okur
    // (meta/call-context.ts). Yayın çağrıları yalnız çağrı noktası taşır.
    const callContext =
      service === "ads"
        ? {
            account:
              typeof payload.adAccountId === "string"
                ? payload.adAccountId
                : metadata.selectedAdAccountId,
            // Duraklatma güvenlik şeridindedir: yerel kesiciye takılmaz.
            lane:
              request.capability === "META_SAFETY_ACTION"
                ? ("P0_SAFETY" as const)
                : ("P1_USER" as const),
            family:
              request.capability === "META_ADS_ANALYSIS"
                ? ("ads_insights" as const)
                : ("ads_management" as const),
            callSite: `provider.${request.capability}`,
          }
        : { callSite: `provider.${request.capability}` };

    // Acil durdurma (docs/meta-ads-plan.md §3.9): reklam yazmaları durur,
    // yalnız duraklatma ve okumalar geçer.
    if (
      service === "ads" &&
      AdsFlags.writesDisabled() &&
      request.capability !== "META_SAFETY_ACTION" &&
      request.capability !== "META_ADS_ANALYSIS" &&
      !isPauseOnly(payload)
    ) {
      return {
        status: "FAILED",
        errorMessage:
          "Ad changes are paused by Agentelse for now. Pausing ads still works.",
      };
    }

    try {
      return await withMetaCallContext(callContext, async () => {
      switch (request.capability) {
        case "INSTAGRAM_PUBLISH":
          return await this.publishInstagram(
            credential.metadata as MetaInstagramMetadata,
            accessToken,
            payload,
          );
        case "FACEBOOK_PUBLISH":
          return await this.publishFacebook(
            credential.metadata as MetaFacebookMetadata,
            accessToken,
            payload,
          );
        case "META_ADS_ANALYSIS":
          return await this.analyzeAds(metadata, accessToken, payload);
        case "META_CAMPAIGN_CREATE":
          return await this.createCampaign(
            metadata,
            accessToken,
            payload,
            intent,
          );
        case "META_CAMPAIGN_UPDATE":
          return await this.updateWithIntent(
            intent,
            "UPDATE_CAMPAIGN",
            payload.campaignId,
            callContext.account,
            payload,
            accessToken,
            () => this.updateCampaign(metadata, accessToken, payload),
          );
        case "META_ADSET_CREATE":
          return await this.createAdSet(metadata, accessToken, payload, intent);
        case "META_ADSET_UPDATE":
          return await this.updateWithIntent(
            intent,
            "UPDATE_ADSET",
            payload.adSetId,
            callContext.account,
            payload,
            accessToken,
            () => this.updateAdSet(metadata, accessToken, payload),
          );
        case "META_AD_CREATE":
          return await this.createAd(
            metadata,
            accessToken,
            payload,
            request.context.projectId,
            intent,
          );
        case "META_SAFETY_ACTION":
          return await this.safetyAction(metadata, accessToken, payload, intent);
        case "META_AD_UPDATE":
          // Video never reaches here — see execute()'s special case above.
          return await this.updateWithIntent(
            intent,
            "UPDATE_AD",
            payload.adId,
            callContext.account,
            payload,
            accessToken,
            () =>
              this.updateAd(
                metadata,
                accessToken,
                payload,
                request.context.projectId,
              ),
          );
        default:
          return {
            status: "FAILED",
            errorMessage: `MetaApiProvider does not support capability ${request.capability}`,
          } satisfies StoredResult;
      }
      });
    } catch (error) {
      // Meta answers code 190 when the token expired or was revoked. Flag the
      // connection (the Test button already does) so the Connectors tile asks for a
      // reconnect, instead of every later publish failing while it still says Connected.
      // 190/492 (the Page token owner lost the Page role) only stops that
      // Page's feature and is left out (meta-credential-health.ts).
      await markMetaCredentialExpiredOn(error, credential.id);
      return failedResult(error);
    }
  }

  private async publishInstagram(
    metadata: MetaInstagramMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    const target = resolveInstagramTarget(metadata);
    if (!target) {
      return {
        status: "FAILED",
        errorMessage:
          metadata.login === "instagram"
            ? "No Instagram account is connected"
            : "The selected Page has no connected Instagram account",
      };
    }
    const imageUrl =
      typeof payload.imageUrl === "string" ? payload.imageUrl : undefined;
    const caption = typeof payload.caption === "string" ? payload.caption : "";
    if (!imageUrl) {
      return {
        status: "FAILED",
        errorMessage: "INSTAGRAM_PUBLISH requires `imageUrl`",
      };
    }

    const mediaType =
      payload.targetFormat === "STORIES" ? "STORIES" : undefined;

    const access = await instagramAccessFor(target, accessToken);
    const { postId } = await publishInstagramPost({
      instagramBusinessAccountId: target.igUserId,
      pageAccessToken: access.accessToken,
      imageUrl,
      caption,
      mediaType,
      api: access.api,
    });
    return {
      status: "COMPLETED",
      // requestedMediaType: lets us later verify which media_type was
      // actually sent to Meta in production (see the targetFormat flow) —
      // for observability, permanently useful.
      rawResult: { postId, requestedMediaType: mediaType ?? "FEED" },
    };
  }

  // A post on the Page selected in the Facebook integration: a photo post when
  // the creative has an image, otherwise a text post. The Page token is
  // derived from the stored user token right here and never persisted.
  private async publishFacebook(
    metadata: MetaFacebookMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    const page = selectedFacebookPage(metadata);
    if (!page) {
      return { status: "FAILED", errorMessage: "No Facebook Page selected" };
    }
    const imageUrl =
      typeof payload.imageUrl === "string" && payload.imageUrl
        ? payload.imageUrl
        : undefined;
    const caption = typeof payload.caption === "string" ? payload.caption : "";
    if (!imageUrl && !caption.trim()) {
      return {
        status: "FAILED",
        errorMessage: "FACEBOOK_PUBLISH requires `caption` or `imageUrl`",
      };
    }

    const pageAccessToken = await fetchPageAccessToken(page.pageId, accessToken);
    const { postId } = await publishFacebookPagePost({
      pageId: page.pageId,
      pageAccessToken,
      message: caption,
      imageUrl,
    });
    return {
      status: "COMPLETED",
      rawResult: { postId, pageId: page.pageId, withImage: Boolean(imageUrl) },
    };
  }

  // Campaign-level (and, when a specific campaign is asked about, adset-
  // level) analysis — replaces the old account-level single-row summary.
  // Reuses MetaAdsQuery (the same listing+insights join the /ads page
  // uses) so this and the page can never drift out of sync on what
  // "performance" means.
  private async analyzeAds(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const datePreset =
      typeof payload.datePreset === "string" && isDatePreset(payload.datePreset)
        ? payload.datePreset
        : DEFAULT_DATE_PRESET;
    const datePresetLabel =
      DATE_PRESETS.find((p) => p.value === datePreset)?.label ?? datePreset;
    const currency =
      metadata.adAccounts?.find(
        (a) => a.adAccountId === metadata.selectedAdAccountId,
      )?.currency ?? "USD";
    const conn = {
      status: "READY" as const,
      accessToken,
      adAccountId: metadata.selectedAdAccountId,
    };

    const campaigns = await MetaAdsQuery.campaigns(conn, datePreset);
    const campaignId =
      typeof payload.campaignId === "string" ? payload.campaignId : undefined;
    const targetCampaign = campaignId
      ? campaigns.find((c) => c.campaignId === campaignId)
      : undefined;
    const adSets = targetCampaign
      ? await MetaAdsQuery.adSets(conn, targetCampaign.campaignId, datePreset)
      : undefined;

    const text = buildAdsAnalysisText(
      campaigns,
      currency,
      datePresetLabel,
      targetCampaign && adSets
        ? { campaignName: targetCampaign.name, adSets }
        : undefined,
    );
    return {
      status: "COMPLETED",
      rawResult: {
        text,
        summary: { datePreset, currency, campaigns, adSets },
      },
    };
  }

  // Bir oluşturma yazması niyet günlüğüyle (docs/meta-ads-plan.md §3.1):
  // önce AdsOperation açılır ve adın sonuna [agx:…] etiketi eklenir. Aynı iş
  // yazmayı daha önce göndermişse yeniden göndermez, kaldığı yerden devam
  // eder. Yanıt kaybolursa (ağ, zaman aşımı, 5xx) iş RUNNING kalır ve
  // pollOperation etiketle Meta'da arar; kör tekrar yapılmaz.
  private async createWithIntent(input: {
    intent: IntentContext;
    kind: "CREATE_CAMPAIGN" | "CREATE_ADSET" | "CREATE_AD";
    edge: "campaigns" | "adsets" | "ads";
    adAccountId: string;
    accessToken: string;
    parentExternalId?: string;
    resultKey: string;
    extraResult?: Record<string, unknown>;
    failurePrefix?: string;
    request: Record<string, unknown>;
    send: (tagged: (name: string) => string) => Promise<string>;
  }): Promise<StoredResult> {
    const { op, resumed } = await AdsOperations.begin({
      workspaceId: input.intent.workspaceId,
      projectId: input.intent.projectId,
      kind: input.kind,
      actorType: input.intent.actorType,
      executionJobId: input.intent.executionJobId,
      adAccountExternalId: input.adAccountId,
      parentExternalId: input.parentExternalId,
      request: input.request,
    });
    const completed = (externalId: string): StoredResult => ({
      status: "COMPLETED",
      rawResult: {
        [input.resultKey]: externalId,
        ...(input.extraResult ?? {}),
        operationTag: op.tag,
      },
    });
    const pending: StoredResult = {
      status: "RUNNING",
      pendingOperationId: op.id,
      resultKey: input.resultKey,
      ...(input.extraResult ? { extraResult: input.extraResult } : {}),
    };

    if (resumed) {
      if (
        (op.status === "SUCCEEDED" || op.status === "RECONCILED") &&
        op.resultExternalId
      ) {
        return completed(op.resultExternalId);
      }
      if (op.status === "SENT" || op.status === "UNKNOWN") return pending;
      if (op.status === "FAILED") {
        return {
          status: "FAILED",
          errorMessage: operationErrorMessage(op.error),
        };
      }
      // PENDING: kayıt açılmış ama gönderilmemiş — göndermek güvenli.
    }

    await AdsOperations.markSent(op.id);
    try {
      const externalId = await input.send((name) => taggedName(name, op.tag));
      await AdsOperations.succeed(op.id, externalId);
      return completed(externalId);
    } catch (error) {
      if (classifyMetaError(error).class === "TRANSIENT") {
        // Meta nesneyi kurmuş ama yanıt kaybolmuş olabilir.
        await AdsOperations.unknown(op.id, error);
        return pending;
      }
      await AdsOperations.fail(op.id, error);
      return failedResult(error, input.failurePrefix);
    }
  }

  // META_LAUNCH (docs/meta-ads-plan.md §3.4): execute() yalnız lansmanı işe
  // bağlar ve döner; her getStatus() adım makinesini en çok 3 yazma ilerletir.
  // Dev kovasındaki kota beklemesi tick'i ya da isteği bloklamaz.
  private async startLaunch(
    request: ExecutionRequest,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const launchId = typeof payload.launchId === "string" ? payload.launchId : null;
    const mode =
      payload.mode === "activate" || payload.mode === "discard" ? payload.mode : "create";
    const launch = launchId
      ? await prisma.adsLaunch.findFirst({
          where: { id: launchId, projectId: request.context.projectId },
          select: { id: true },
        })
      : null;
    if (!launch) {
      await saveProviderResult(request.correlationId, {
        status: "FAILED",
        errorMessage: "META_LAUNCH requires the launch of this project",
      });
      return;
    }
    await prisma.adsLaunch.update({
      where: { id: launch.id },
      data: { currentTaskId: request.context.taskId ?? null, mode },
    });
    await saveProviderResult(request.correlationId, {
      status: "RUNNING",
      launchId: launch.id,
      launchMode: mode,
      actorType: await taskActor(request.context.taskId),
    });
  }

  private async pollLaunch(
    executionReference: string,
    record: StoredResult,
  ): Promise<ProviderExecutionStatus> {
    const result = await LaunchExecutor.advance(
      record.launchId!,
      record.launchMode ?? "create",
      { actorType: record.actorType ?? "USER" },
    );
    if (result.status === "RUNNING") {
      return { status: "RUNNING", isMock: false };
    }
    const final: StoredResult = {
      status: result.status,
      rawResult: result.rawResult,
      errorMessage: result.errorMessage,
      errorCode: result.errorCode,
      retryable: false,
    };
    await saveProviderResult(executionReference, final);
    return {
      status: final.status,
      rawResult: final.rawResult,
      errorMessage: final.errorMessage,
      errorCode: final.errorCode,
      retryable: false,
      isMock: false,
    };
  }

  // Güvenlik eylemi (docs/meta-ads-plan.md §3.9): duraklatma her zaman
  // denenir; hesap engeli, yazma kapısı ve acil durdurma bayrağı onu
  // durdurmaz. "PAUSE_ALL" hesaptaki açık her kampanyayı tek yazmayla durdurur
  // (alt nesneler durumu miras alır); "PAUSE" verilen nesneleri durdurur.
  // Her yazma niyet günlüğüne SET_STATUS olarak düşer (drift sayılmaz).
  private async safetyAction(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    intent: IntentContext,
  ): Promise<StoredResult> {
    const rawAccount =
      typeof payload.adAccountId === "string"
        ? payload.adAccountId
        : metadata.selectedAdAccountId;
    // Yarım lansmanın temizliği ("Discard", §3.4 telafi): riski azaltır.
    if (payload.action === "DISCARD_LAUNCH" && typeof payload.launchId === "string") {
      const launch = await prisma.adsLaunch.findFirst({
        where: { id: payload.launchId, projectId: intent.projectId },
        select: { id: true },
      });
      if (!launch) return { status: "FAILED", errorMessage: "Launch not found" };
      const result = await LaunchExecutor.advance(launch.id, "discard", {
        actorType: intent.actorType,
      });
      return result.status === "COMPLETED"
        ? { status: "COMPLETED", rawResult: result.rawResult }
        : result.status === "FAILED"
          ? { status: "FAILED", errorMessage: result.errorMessage ?? "Couldn't discard it." }
          : { status: "FAILED", errorMessage: "Meta is busy. Try discarding again in a minute.", retryable: true };
    }
    if (!rawAccount) {
      return { status: "FAILED", errorMessage: "No ad account is selected" };
    }
    const adAccountId = normalizeAdAccountId(rawAccount);
    let targets: { level: "CAMPAIGN" | "ADSET" | "AD"; id: string }[] = [];
    if (payload.action === "PAUSE_ALL") {
      const campaigns = await listMetaCampaigns({ adAccountId, accessToken });
      targets = campaigns
        .filter((campaign) => campaign.status === "ACTIVE")
        .map((campaign) => ({ level: "CAMPAIGN" as const, id: campaign.campaignId }));
    } else if (Array.isArray(payload.targets)) {
      for (const raw of payload.targets) {
        const target = raw as { level?: unknown; id?: unknown };
        if (
          typeof target.id === "string" &&
          (target.level === "CAMPAIGN" || target.level === "ADSET" || target.level === "AD")
        ) {
          targets.push({ level: target.level, id: target.id });
        }
      }
    }
    const paused: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const target of targets) {
      // Bir iş birden çok nesneyi durdurur: işe bağlı tekil anahtar
      // (executionJobId, kind) kullanılmaz, iş kimliği istekte durur.
      const { op } = await AdsOperations.begin({
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        kind: "SET_STATUS",
        actorType: intent.actorType,
        adAccountExternalId: adAccountId,
        targetExternalId: target.id,
        request: {
          status: "PAUSED",
          level: target.level,
          executionJobId: intent.executionJobId,
          ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        },
        ...(typeof payload.decisionId === "string" ? { decisionId: payload.decisionId } : {}),
      });
      await AdsOperations.markSent(op.id);
      try {
        if (target.level === "CAMPAIGN") {
          await updateMetaCampaign({ campaignId: target.id, accessToken, status: "PAUSED" });
        } else if (target.level === "ADSET") {
          await updateMetaAdSet({ adSetId: target.id, accessToken, status: "PAUSED" });
        } else {
          await updateMetaAd({ adId: target.id, accessToken, status: "PAUSED" });
        }
        await AdsOperations.succeed(op.id, target.id);
        paused.push(target.id);
      } catch (error) {
        await AdsOperations.fail(op.id, error);
        // 190: dış katman bağlantıyı EXPIRED yapar; kalan hedefler de düşer.
        if (isExpiredTokenError(error)) throw error;
        failed.push({ id: target.id, message: metaUserMessage(error) });
      }
    }
    // Ayna hemen güncellenir; sonraki yapı senkronu doğrular.
    if (paused.length > 0) {
      await prisma.adsObject
        .updateMany({
          where: { externalId: { in: paused } },
          data: { configuredStatus: "PAUSED", effectiveStatus: "PAUSED" },
        })
        .catch(() => undefined);
    }
    if (failed.length > 0 && paused.length === 0) {
      return {
        status: "FAILED",
        errorMessage: failed[0]!.message,
        rawResult: { paused, failed },
      };
    }
    return { status: "COMPLETED", rawResult: { paused, failed } };
  }

  // Güncelleme yazmasının niyet kaydı (docs/meta-ads-plan.md §3.1, §3.2):
  // güncellemeler idempotenttir, kör tekrar riski yoktur; kayıt denetim ve
  // drift açıklaması içindir (ayna bizim değişikliğimizi "Changed in Ads
  // Manager" saymaz). Kayıt yazılamazsa yazma yine yapılır.
  private async updateWithIntent(
    intent: IntentContext,
    kind: "UPDATE_CAMPAIGN" | "UPDATE_ADSET" | "UPDATE_AD",
    target: unknown,
    adAccountId: string | undefined,
    payload: Record<string, unknown>,
    accessToken: string,
    run: () => Promise<StoredResult>,
  ): Promise<StoredResult> {
    // Optimizasyon kararı (F4) CAS'le uygulanır: önerildiği andaki değer
    // Meta'da değiştiyse yazılmaz; karar SUPERSEDED olur.
    if (typeof target === "string") {
      const superseded = await decisionSuperseded(target, payload, accessToken);
      if (superseded) return superseded;
    }
    let opId: string | null = null;
    try {
      const { op } = await AdsOperations.begin({
        workspaceId: intent.workspaceId,
        projectId: intent.projectId,
        kind,
        actorType: intent.actorType,
        executionJobId: intent.executionJobId,
        adAccountExternalId: adAccountId,
        targetExternalId: typeof target === "string" ? target : undefined,
        request: updateRequestSummary(payload),
      });
      opId = op.id;
      await AdsOperations.markSent(op.id);
    } catch (error) {
      console.error(
        "[meta-api-provider] update intent could not be recorded:",
        error instanceof Error ? error.message : error,
      );
    }
    try {
      const result = await run();
      if (opId) {
        await (result.status === "COMPLETED"
          ? AdsOperations.succeed(opId, typeof target === "string" ? target : undefined)
          : AdsOperations.fail(opId, new Error(result.errorMessage ?? "failed"))
        ).catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (opId) await AdsOperations.fail(opId, error).catch(() => undefined);
      throw error;
    }
  }

  // Yanıtı kaybolan oluşturmanın uzlaştırılması: 30 sn sonra etiketle aranır;
  // bulunursa iş tamamlanır, 150 sn'de bulunmazsa kör tekrar yapılmadan
  // kapatılır ("Fix and retry" / yeniden başlatma kullanıcıdadır).
  private async pollOperation(
    executionReference: string,
    record: StoredResult,
  ): Promise<ProviderExecutionStatus> {
    const op = record.pendingOperationId
      ? await AdsOperations.find(record.pendingOperationId)
      : null;
    if (!op) {
      return {
        status: "FAILED",
        errorMessage: "The Meta write could not be traced",
        isMock: false,
      };
    }
    const finish = async (result: StoredResult) => {
      await saveProviderResult(executionReference, result);
      return { ...result, isMock: false } as ProviderExecutionStatus;
    };
    const completedWith = (externalId: string) =>
      finish({
        status: "COMPLETED",
        rawResult: {
          [record.resultKey ?? "externalId"]: externalId,
          ...(record.extraResult ?? {}),
          operationTag: op.tag,
        },
      });

    if (
      (op.status === "SUCCEEDED" || op.status === "RECONCILED") &&
      op.resultExternalId
    ) {
      return completedWith(op.resultExternalId);
    }
    if (op.status === "FAILED") {
      return finish({
        status: "FAILED",
        errorMessage: operationErrorMessage(op.error),
      });
    }
    const sentAt = op.sentAt?.getTime() ?? op.createdAt.getTime();
    const age = Date.now() - sentAt;
    if (age < RECONCILE_AFTER_MS) return { status: "RUNNING", isMock: false };

    const edge =
      op.kind === "CREATE_CAMPAIGN"
        ? "campaigns"
        : op.kind === "CREATE_ADSET"
          ? "adsets"
          : "ads";
    let found: string[] = [];
    try {
      const credential = await findActiveMetaCredential(op.projectId, "ads");
      if (credential && op.adAccountExternalId) {
        found = await withMetaCallContext(
          {
            account: op.adAccountExternalId,
            lane: "P1_USER",
            callSite: "provider.reconcile",
          },
          () =>
            findMetaObjectsByTag({
              adAccountId: op.adAccountExternalId!,
              accessToken: decryptSecret(credential.encryptedSecret),
              edge,
              tag: op.tag,
              createdSince: op.sentAt ?? op.createdAt,
            }),
        );
      }
    } catch (error) {
      console.error(
        `[meta-api-provider] reconcile search for ${op.tag} failed:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (found.length > 0) {
      // Birden fazla eşleşme: en eskisi alınır (liste en yeni önce gelebilir;
      // kimlikler sayısal olarak büyür).
      const [first] = [...found].sort((a, b) =>
        a.length === b.length ? a.localeCompare(b) : a.length - b.length,
      );
      if (found.length > 1) {
        console.warn(
          `[meta-api-provider] ${found.length} objects carry ${op.tag}; kept ${first}`,
        );
      }
      await AdsOperations.reconciled(op.id, first!);
      return completedWith(first!);
    }
    if (age < RECONCILE_GIVE_UP_MS) return { status: "RUNNING", isMock: false };

    const error = new Error(
      "Meta did not confirm this write and nothing carrying its tag was found. Nothing was created: launch again.",
    );
    await AdsOperations.fail(op.id, error);
    return finish({ status: "FAILED", errorMessage: error.message });
  }

  private async createCampaign(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    intent: IntentContext,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const changed = accountChangedSinceApproval(metadata, payload);
    if (changed) return { status: "FAILED", errorMessage: changed };
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const objective =
      typeof payload.objective === "string" ? payload.objective : undefined;
    if (!name || !objective) {
      return {
        status: "FAILED",
        errorMessage: "META_CAMPAIGN_CREATE requires `name` and `objective`",
      };
    }
    const status = payload.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
    const dailyBudgetCents =
      typeof payload.dailyBudgetCents === "number"
        ? payload.dailyBudgetCents
        : undefined;

    const adAccountId = metadata.selectedAdAccountId;
    return this.createWithIntent({
      intent,
      kind: "CREATE_CAMPAIGN",
      edge: "campaigns",
      adAccountId,
      accessToken,
      resultKey: "campaignId",
      request: { name, objective, status, dailyBudgetCents },
      send: async (tagged) =>
        (
          await createMetaCampaign({
            adAccountId,
            accessToken,
            name: tagged(name),
            objective,
            status,
            dailyBudgetCents,
          })
        ).campaignId,
    });
  }

  private async updateCampaign(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    const campaignId =
      typeof payload.campaignId === "string" ? payload.campaignId : undefined;
    if (!campaignId) {
      return {
        status: "FAILED",
        errorMessage: "META_CAMPAIGN_UPDATE requires `campaignId`",
      };
    }
    const foreign = await objectOutsideAccount(
      campaignId,
      accessToken,
      metadata,
      payload,
    );
    if (foreign) return { status: "FAILED", errorMessage: foreign };
    // Accepts BOTH `status`/`dailyBudgetCents` (a direct, e.g. future
    // chat-triggered, update request) AND `proposedStatus`/
    // `proposedDailyBudgetCents` (PerformanceOptimizer.proposeCampaignAction
    // — see performance-optimizer.ts — writes the "proposed" names so
    // approval-details.ts can show "current -> proposed" on the approval
    // card). Without this fallback, an approved performance proposal would
    // call updateMetaCampaign with both fields undefined — a no-op POST
    // that still reports COMPLETED, silently not changing anything on Meta.
    const status = readCampaignStatus(payload.status ?? payload.proposedStatus);
    const dailyBudgetCents = readBudgetCents(
      payload.dailyBudgetCents ?? payload.proposedDailyBudgetCents,
    );

    await updateMetaCampaign({
      campaignId,
      accessToken,
      status,
      dailyBudgetCents,
    });
    return { status: "COMPLETED", rawResult: { campaignId } };
  }

  private async updateAdSet(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    const adSetId =
      typeof payload.adSetId === "string" ? payload.adSetId : undefined;
    if (!adSetId) {
      return {
        status: "FAILED",
        errorMessage: "META_ADSET_UPDATE requires `adSetId`",
      };
    }
    const foreign = await objectOutsideAccount(
      adSetId,
      accessToken,
      metadata,
      payload,
    );
    if (foreign) return { status: "FAILED", errorMessage: foreign };
    // See the identical fallback comment in updateCampaign above —
    // PerformanceOptimizer.proposeAdSetAction writes proposedStatus/
    // proposedDailyBudgetCents, not status/dailyBudgetCents.
    const status = readCampaignStatus(payload.status ?? payload.proposedStatus);
    const dailyBudgetCents = readBudgetCents(
      payload.dailyBudgetCents ?? payload.proposedDailyBudgetCents,
    );
    // Only the user-triggered manual edit path (updateMetaAdSetAction) ever
    // sets `targeting` — PerformanceOptimizer's proposals never touch it.
    const targeting = payload.targeting as MetaAdSetTargeting | undefined;

    await updateMetaAdSet({
      adSetId,
      accessToken,
      status,
      dailyBudgetCents,
      targeting,
    });
    return { status: "COMPLETED", rawResult: { adSetId } };
  }

  private async createAdSet(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    intent: IntentContext,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const campaignId =
      typeof payload.campaignId === "string" ? payload.campaignId : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const dailyBudgetCents =
      typeof payload.dailyBudgetCents === "number"
        ? payload.dailyBudgetCents
        : undefined;
    const billingEvent =
      typeof payload.billingEvent === "string"
        ? payload.billingEvent
        : undefined;
    const optimizationGoal =
      typeof payload.optimizationGoal === "string"
        ? payload.optimizationGoal
        : undefined;
    const targeting = payload.targeting as MetaAdSetTargeting | undefined;
    if (
      !campaignId ||
      !name ||
      !dailyBudgetCents ||
      !billingEvent ||
      !optimizationGoal ||
      !targeting?.countries?.length
    ) {
      return {
        status: "FAILED",
        errorMessage:
          "META_ADSET_CREATE requires `campaignId`, `name`, `dailyBudgetCents`, `billingEvent`, `optimizationGoal` and `targeting.countries`",
      };
    }
    const status = payload.status === "ACTIVE" ? "ACTIVE" : "PAUSED";
    const changed = accountChangedSinceApproval(metadata, payload);
    if (changed) return { status: "FAILED", errorMessage: changed };

    // Bitiş, Launch anında değil ad set kurulurken hesaplanır: zincir üç ayrı
    // onay bekleyebilir (docs/meta-ads-plan.md F0b). Sonradan açmak bitişi
    // ertelemez ("Turning it on later does not move the end date").
    const window = adSetTimeWindow(payload, new Date());
    // Açık değer: 0 = Brief'teki yaş/cinsiyet sert sınırdır (bugünkü
    // davranış); 1 ve "Suggest / Limit to" ayrımı F5b'de gelir.
    const advantageAudience = payload.advantageAudience === 1 ? 1 : 0;
    const dsa = readDsa(payload.dsa);

    const adAccountId = metadata.selectedAdAccountId;
    return this.createWithIntent({
      intent,
      kind: "CREATE_ADSET",
      edge: "adsets",
      adAccountId,
      accessToken,
      parentExternalId: campaignId,
      resultKey: "adSetId",
      extraResult: window
        ? { endTime: new Date(window.end * 1000).toISOString() }
        : undefined,
      request: {
        campaignId,
        name,
        dailyBudgetCents,
        billingEvent,
        optimizationGoal,
        advantageAudience,
        ...(window ? { startTime: window.start, endTime: window.end } : {}),
        ...(dsa ? { dsa } : {}),
      },
      send: async (tagged) =>
        (
          await createMetaAdSet({
            adAccountId,
            accessToken,
            campaignId,
            name: tagged(name),
            dailyBudgetCents,
            billingEvent,
            optimizationGoal,
            targeting,
            status,
            advantageAudience,
            ...(window ? { startTime: window.start, endTime: window.end } : {}),
            ...(dsa ? { dsa } : {}),
          })
        ).adSetId,
    });
  }

  // Three sequential Marketing API calls: upload the image (if given) ->
  // create the AdCreative -> create the Ad. If a later step fails, the
  // resource created by an earlier step is left orphaned on Meta's side
  // (not cleaned up) — the error message below names which step failed so
  // this is at least visible, not silent. `format` defaults to
  // SINGLE_IMAGE for backward compatibility with every ad created before
  // the wizard supported multiple formats — this is the only branch point;
  // VIDEO never reaches here (see execute()'s special case above, since a
  // video ad can't resolve synchronously).
  private async createAd(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    projectId: string,
    intent: IntentContext,
  ): Promise<StoredResult> {
    if (payload.format === "CAROUSEL") {
      return this.createCarouselAd(
        metadata,
        accessToken,
        payload,
        projectId,
        intent,
      );
    }
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page) {
      return {
        status: "FAILED",
        errorMessage: "No Facebook Page selected for the ad creative",
      };
    }
    const adSetId =
      typeof payload.adSetId === "string" ? payload.adSetId : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const link = typeof payload.link === "string" ? payload.link : undefined;
    const callToActionType =
      typeof payload.callToActionType === "string"
        ? payload.callToActionType
        : "LEARN_MORE";
    const imageAssetId =
      typeof payload.imageAssetId === "string"
        ? payload.imageAssetId
        : undefined;
    if (!adSetId || !name || !message || !link || !imageAssetId) {
      return {
        status: "FAILED",
        errorMessage:
          "META_AD_CREATE requires `adSetId`, `name`, `message`, `link` and `imageAssetId`",
      };
    }
    const status = payload.status === "ACTIVE" ? "ACTIVE" : "PAUSED";

    // Scoped by projectId, not just id — see the same comment on
    // startVideoAd's asset reads above.
    const asset = await prisma.asset.findFirst({
      where: { id: imageAssetId, projectId },
      select: { storageKey: true },
    });
    if (!asset) {
      return { status: "FAILED", errorMessage: "Ad image asset not found" };
    }

    let imageHash: string;
    try {
      const buffer = await readAsset(asset.storageKey);
      const uploaded = await uploadMetaAdImage({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        imageBuffer: buffer,
      });
      imageHash = uploaded.imageHash;
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Image upload step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let creativeId: string;
    try {
      const created = await createMetaAdCreative({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        pageId: page.pageId,
        imageHash,
        message,
        link,
        callToActionType,
      });
      creativeId = created.creativeId;
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad creative step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const adAccountId = metadata.selectedAdAccountId;
    return this.createWithIntent({
      intent,
      kind: "CREATE_AD",
      edge: "ads",
      adAccountId,
      accessToken,
      parentExternalId: adSetId,
      resultKey: "adId",
      extraResult: { creativeId, imageHash },
      failurePrefix: `Ad creation step failed (creative ${creativeId} was created): `,
      request: { adSetId, name, creativeId, status },
      send: async (tagged) =>
        (
          await createMetaAd({
            adAccountId,
            accessToken,
            adSetId,
            name: tagged(name),
            creativeId,
            status,
          })
        ).adId,
    });
  }

  // Same three-step shape as createAd's single-image path, except step one
  // uploads one image PER CARD (sequential, not parallel — Meta's adimages
  // endpoint is per-account rate limited, and a carousel is capped at 10
  // cards, so the extra latency here is bounded and not worth the added
  // complexity of a bounded-concurrency helper for this one call site).
  private async createCarouselAd(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    projectId: string,
    intent: IntentContext,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page) {
      return {
        status: "FAILED",
        errorMessage: "No Facebook Page selected for the ad creative",
      };
    }
    const adSetId =
      typeof payload.adSetId === "string" ? payload.adSetId : undefined;
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const callToActionType =
      typeof payload.callToActionType === "string"
        ? payload.callToActionType
        : "LEARN_MORE";
    const rawCards = Array.isArray(payload.cards) ? payload.cards : [];
    const cards = rawCards.filter(
      (
        c,
      ): c is {
        link: string;
        name: string;
        description?: string;
        imageAssetId: string;
      } =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { link?: unknown }).link === "string" &&
        typeof (c as { name?: unknown }).name === "string" &&
        typeof (c as { imageAssetId?: unknown }).imageAssetId === "string",
    );
    if (!adSetId || !name || !message || cards.length < 2) {
      return {
        status: "FAILED",
        errorMessage:
          "META_AD_CREATE (carousel) requires `adSetId`, `name`, `message` and at least 2 valid `cards` (each with `link`, `name`, `imageAssetId`)",
      };
    }
    const status = payload.status === "ACTIVE" ? "ACTIVE" : "PAUSED";

    const uploadedCards: {
      link: string;
      name: string;
      description?: string;
      imageHash: string;
    }[] = [];
    try {
      for (const card of cards) {
        // Scoped by projectId, not just id — see the same comment on
        // startVideoAd's asset reads above.
        const asset = await prisma.asset.findFirst({
          where: { id: card.imageAssetId, projectId },
          select: { storageKey: true },
        });
        if (!asset) {
          throw new Error(`Card image asset ${card.imageAssetId} not found`);
        }
        const buffer = await readAsset(asset.storageKey);
        const uploaded = await uploadMetaAdImage({
          adAccountId: metadata.selectedAdAccountId,
          accessToken,
          imageBuffer: buffer,
        });
        uploadedCards.push({
          link: card.link,
          name: card.name,
          description: card.description,
          imageHash: uploaded.imageHash,
        });
      }
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Card image upload step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let creativeId: string;
    try {
      const created = await createMetaCarouselAdCreative({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        pageId: page.pageId,
        message,
        cards: uploadedCards,
        callToActionType,
      });
      creativeId = created.creativeId;
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad creative step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const adAccountId = metadata.selectedAdAccountId;
    return this.createWithIntent({
      intent,
      kind: "CREATE_AD",
      edge: "ads",
      adAccountId,
      accessToken,
      parentExternalId: adSetId,
      resultKey: "adId",
      extraResult: { creativeId, cardCount: uploadedCards.length },
      failurePrefix: `Ad creation step failed (creative ${creativeId} was created): `,
      request: { adSetId, name, creativeId, status, format: "CAROUSEL" },
      send: async (tagged) =>
        (
          await createMetaAd({
            adAccountId,
            accessToken,
            adSetId,
            name: tagged(name),
            creativeId,
            status,
          })
        ).adId,
    });
  }

  // Updates an EXISTING ad. A pure name/status edit (no `format` in the
  // payload — the wizard always sends one when the creative itself was
  // touched) skips creative rebuilding entirely and goes straight to
  // updateMetaAd. Otherwise a BRAND NEW creative is built (AdCreative
  // content is immutable on Meta's side — see updateMetaAd's comment in
  // meta-client.ts) and the ad is pointed at it; VIDEO never reaches here
  // (see execute()'s special case above).
  private async updateAd(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    projectId: string,
  ): Promise<StoredResult> {
    const adId = typeof payload.adId === "string" ? payload.adId : undefined;
    if (!adId) {
      return {
        status: "FAILED",
        errorMessage: "META_AD_UPDATE requires `adId`",
      };
    }
    const foreign = await objectOutsideAccount(
      adId,
      accessToken,
      metadata,
      payload,
    );
    if (foreign) return { status: "FAILED", errorMessage: foreign };
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const status =
      payload.status === "ACTIVE" || payload.status === "PAUSED"
        ? payload.status
        : undefined;
    const format =
      typeof payload.format === "string" ? payload.format : undefined;

    if (!format) {
      if (!name && !status) {
        return {
          status: "FAILED",
          errorMessage:
            "META_AD_UPDATE requires at least `name`, `status` or a creative `format`",
        };
      }
      await updateMetaAd({ adId, accessToken, name, status });
      return { status: "COMPLETED", rawResult: { adId } };
    }

    if (format === "CAROUSEL") {
      return this.updateCarouselAd(
        metadata,
        accessToken,
        payload,
        projectId,
        adId,
        name,
        status,
      );
    }

    // `existingVideoId` means the user kept the current video and only
    // changed message/link/CTA/status — Meta's already-processed video
    // needs no re-upload and no wait, so this stays fully synchronous
    // (unlike a NEW video file, which execute() routes to the async
    // pendingVideoAds path via startVideoAd instead of reaching here at
    // all). A thumbnail is still required fresh every time: nothing here
    // tracks the OLD thumbnail's underlying asset to reuse it the way
    // resolveImageHash reuses an image_hash.
    if (format === "VIDEO") {
      const existingVideoId =
        typeof payload.existingVideoId === "string"
          ? payload.existingVideoId
          : undefined;
      if (!existingVideoId) {
        return {
          status: "FAILED",
          errorMessage:
            "META_AD_UPDATE (video) requires either a new video upload or `existingVideoId`",
        };
      }
      if (!metadata.selectedAdAccountId) {
        return { status: "FAILED", errorMessage: "No ad account selected" };
      }
      const videoPage = metadata.pages?.find(
        (p) => p.pageId === metadata.selectedPageId,
      );
      if (!videoPage) {
        return {
          status: "FAILED",
          errorMessage: "No Facebook Page selected for the ad creative",
        };
      }
      const videoMessage =
        typeof payload.message === "string" ? payload.message : undefined;
      const videoLink =
        typeof payload.link === "string" ? payload.link : undefined;
      const videoCallToActionType =
        typeof payload.callToActionType === "string"
          ? payload.callToActionType
          : "LEARN_MORE";
      const thumbnailAssetId =
        typeof payload.thumbnailAssetId === "string"
          ? payload.thumbnailAssetId
          : undefined;
      if (!videoMessage || !videoLink || !thumbnailAssetId) {
        return {
          status: "FAILED",
          errorMessage:
            "META_AD_UPDATE (video) requires `message`, `link` and `thumbnailAssetId`",
        };
      }
      const thumbnailAsset = await prisma.asset.findFirst({
        where: { id: thumbnailAssetId, projectId },
        select: { storageKey: true },
      });
      const thumbnailUrl = thumbnailAsset
        ? resolveDirectPublicUrl(thumbnailAsset.storageKey)
        : null;
      if (!thumbnailUrl) {
        return {
          status: "FAILED",
          errorMessage:
            "Ad video thumbnail has no public URL (R2 storage is required for video ads)",
        };
      }
      try {
        const created = await createMetaVideoAdCreative({
          adAccountId: metadata.selectedAdAccountId,
          accessToken,
          pageId: videoPage.pageId,
          videoId: existingVideoId,
          thumbnailUrl,
          message: videoMessage,
          link: videoLink,
          callToActionType: videoCallToActionType,
        });
        await updateMetaAd({
          adId,
          accessToken,
          name,
          status,
          creativeId: created.creativeId,
        });
        return {
          status: "COMPLETED",
          rawResult: {
            adId,
            creativeId: created.creativeId,
            videoId: existingVideoId,
          },
        };
      } catch (error) {
        return {
          status: "FAILED",
          errorMessage: `Ad creative/update step failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page) {
      return {
        status: "FAILED",
        errorMessage: "No Facebook Page selected for the ad creative",
      };
    }
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const link = typeof payload.link === "string" ? payload.link : undefined;
    const callToActionType =
      typeof payload.callToActionType === "string"
        ? payload.callToActionType
        : "LEARN_MORE";
    const imageAssetId =
      typeof payload.imageAssetId === "string"
        ? payload.imageAssetId
        : undefined;
    const existingImageHash =
      typeof payload.existingImageHash === "string"
        ? payload.existingImageHash
        : undefined;
    if (!message || !link) {
      return {
        status: "FAILED",
        errorMessage:
          "META_AD_UPDATE (single image) requires `message` and `link`",
      };
    }

    const resolved = await resolveImageHash(
      metadata.selectedAdAccountId,
      accessToken,
      projectId,
      { assetId: imageAssetId, existingHash: existingImageHash },
    );
    if (!resolved.ok) {
      return { status: "FAILED", errorMessage: resolved.error };
    }

    let creativeId: string;
    try {
      const created = await createMetaAdCreative({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        pageId: page.pageId,
        imageHash: resolved.imageHash,
        message,
        link,
        callToActionType,
      });
      creativeId = created.creativeId;
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad creative step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      await updateMetaAd({ adId, accessToken, name, status, creativeId });
      return {
        status: "COMPLETED",
        rawResult: { adId, creativeId, imageHash: resolved.imageHash },
      };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad update step failed (creative ${creativeId} was created): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Same shape as updateAd's single-image branch, one image resolution
  // (new upload or reused hash) per card — mirrors createCarouselAd's
  // sequential-not-parallel reasoning above.
  private async updateCarouselAd(
    metadata: MetaAdsMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
    projectId: string,
    adId: string,
    name: string | undefined,
    status: "ACTIVE" | "PAUSED" | undefined,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page) {
      return {
        status: "FAILED",
        errorMessage: "No Facebook Page selected for the ad creative",
      };
    }
    const message =
      typeof payload.message === "string" ? payload.message : undefined;
    const callToActionType =
      typeof payload.callToActionType === "string"
        ? payload.callToActionType
        : "LEARN_MORE";
    const rawCards = Array.isArray(payload.cards) ? payload.cards : [];
    const cards = rawCards.filter(
      (
        c,
      ): c is {
        link: string;
        name: string;
        description?: string;
        imageAssetId?: string;
        existingImageHash?: string;
      } =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as { link?: unknown }).link === "string" &&
        typeof (c as { name?: unknown }).name === "string",
    );
    if (!message || cards.length < 2) {
      return {
        status: "FAILED",
        errorMessage:
          "META_AD_UPDATE (carousel) requires `message` and at least 2 valid `cards` (each with `link`, `name`)",
      };
    }

    const uploadedCards: {
      link: string;
      name: string;
      description?: string;
      imageHash: string;
    }[] = [];
    for (const card of cards) {
      const resolved = await resolveImageHash(
        metadata.selectedAdAccountId,
        accessToken,
        projectId,
        { assetId: card.imageAssetId, existingHash: card.existingImageHash },
      );
      if (!resolved.ok) {
        return {
          status: "FAILED",
          errorMessage: `Card "${card.name}": ${resolved.error}`,
        };
      }
      uploadedCards.push({
        link: card.link,
        name: card.name,
        description: card.description,
        imageHash: resolved.imageHash,
      });
    }

    let creativeId: string;
    try {
      const created = await createMetaCarouselAdCreative({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        pageId: page.pageId,
        message,
        cards: uploadedCards,
        callToActionType,
      });
      creativeId = created.creativeId;
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad creative step failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      await updateMetaAd({ adId, accessToken, name, status, creativeId });
      return {
        status: "COMPLETED",
        rawResult: { adId, creativeId, cardCount: uploadedCards.length },
      };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad update step failed (creative ${creativeId} was created): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
