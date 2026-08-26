import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import { readAsset } from "@/server/storage/asset-storage";
import {
  createMetaAd,
  createMetaAdCreative,
  createMetaAdSet,
  createMetaCampaign,
  fetchPageAccessToken,
  publishInstagramPost,
  updateMetaAdSet,
  updateMetaCampaign,
  uploadMetaAdImage,
  type MetaAdSetTargeting,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";
import {
  DATE_PRESETS,
  DEFAULT_DATE_PRESET,
  isDatePreset,
  MetaAdsQuery,
} from "@/server/integrations/meta-ads-query";
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
  "META_ADS_ANALYSIS",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_AD_CREATE",
]);

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveMetaCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
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

export class MetaApiProvider implements ExecutionProvider {
  readonly key = "meta-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("META");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;

    const credential = await findActiveMetaCredential(context.projectId);
    if (!credential) return false;

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    if (capability === "INSTAGRAM_PUBLISH") {
      const page = metadata.pages?.find(
        (p) => p.pageId === metadata.selectedPageId,
      );
      return Boolean(page?.instagramBusinessAccountId);
    }
    if (capability === "META_AD_CREATE") {
      // createAd() also needs a selected Facebook Page to build the
      // AdCreative's object_story_spec — unlike INSTAGRAM_PUBLISH, it
      // doesn't need that page to have a linked Instagram account.
      const page = metadata.pages?.find(
        (p) => p.pageId === metadata.selectedPageId,
      );
      return Boolean(metadata.selectedAdAccountId) && Boolean(page);
    }
    return Boolean(metadata.selectedAdAccountId);
  }

  // Meta Graph/Marketing API calls are synchronous and return within
  // seconds — we follow OpenClawProvider's "run synchronously, cache the
  // result" pattern: execute() runs the operation start-to-finish here,
  // storing a FAILED result instead of throwing on error; getStatus() just
  // reads it back.
  async execute(request: ExecutionRequest): Promise<ExecutionAcceptedResult> {
    const result = await this.runCapability(request);
    store.set(request.correlationId, result);
    return { executionReference: request.correlationId, isMock: false };
  }

  async getStatus(
    executionReference: string,
  ): Promise<ProviderExecutionStatus> {
    const record = store.get(executionReference);
    if (!record) {
      return {
        status: "FAILED",
        errorMessage: "Unknown Meta API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveMetaCredential(
      request.context.projectId,
    );
    if (!credential) {
      return { status: "FAILED", errorMessage: "Meta connection not found" };
    }
    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    const accessToken = decryptSecret(credential.encryptedSecret);
    const payload = payloadRecord(request.payload);

    try {
      switch (request.capability) {
        case "INSTAGRAM_PUBLISH":
          return await this.publishInstagram(metadata, accessToken, payload);
        case "META_ADS_ANALYSIS":
          return await this.analyzeAds(metadata, accessToken, payload);
        case "META_CAMPAIGN_CREATE":
          return await this.createCampaign(metadata, accessToken, payload);
        case "META_CAMPAIGN_UPDATE":
          return await this.updateCampaign(accessToken, payload);
        case "META_ADSET_CREATE":
          return await this.createAdSet(metadata, accessToken, payload);
        case "META_ADSET_UPDATE":
          return await this.updateAdSet(accessToken, payload);
        case "META_AD_CREATE":
          return await this.createAd(metadata, accessToken, payload);
        default:
          return {
            status: "FAILED",
            errorMessage: `MetaApiProvider does not support capability ${request.capability}`,
          };
      }
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async publishInstagram(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    const page = metadata.pages?.find(
      (p) => p.pageId === metadata.selectedPageId,
    );
    if (!page?.instagramBusinessAccountId) {
      return {
        status: "FAILED",
        errorMessage: "The selected Page has no connected Instagram account",
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

    const pageAccessToken = await fetchPageAccessToken(
      page.pageId,
      accessToken,
    );
    const { postId } = await publishInstagramPost({
      instagramBusinessAccountId: page.instagramBusinessAccountId,
      pageAccessToken,
      imageUrl,
      caption,
      mediaType,
    });
    return {
      status: "COMPLETED",
      // requestedMediaType: lets us later verify which media_type was
      // actually sent to Meta in production (see the targetFormat flow) —
      // for observability, permanently useful.
      rawResult: { postId, requestedMediaType: mediaType ?? "FEED" },
    };
  }

  // Campaign-level (and, when a specific campaign is asked about, adset-
  // level) analysis — replaces the old account-level single-row summary.
  // Reuses MetaAdsQuery (the same listing+insights join the /ads page
  // uses) so this and the page can never drift out of sync on what
  // "performance" means.
  private async analyzeAds(
    metadata: MetaCredentialMetadata,
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

  private async createCampaign(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "No ad account selected" };
    }
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

    const { campaignId } = await createMetaCampaign({
      adAccountId: metadata.selectedAdAccountId,
      accessToken,
      name,
      objective,
      status,
      dailyBudgetCents,
    });
    return { status: "COMPLETED", rawResult: { campaignId } };
  }

  private async updateCampaign(
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
    // See the identical fallback comment in updateCampaign above —
    // PerformanceOptimizer.proposeAdSetAction writes proposedStatus/
    // proposedDailyBudgetCents, not status/dailyBudgetCents.
    const status = readCampaignStatus(payload.status ?? payload.proposedStatus);
    const dailyBudgetCents = readBudgetCents(
      payload.dailyBudgetCents ?? payload.proposedDailyBudgetCents,
    );

    await updateMetaAdSet({
      adSetId,
      accessToken,
      status,
      dailyBudgetCents,
    });
    return { status: "COMPLETED", rawResult: { adSetId } };
  }

  private async createAdSet(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
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

    const { adSetId } = await createMetaAdSet({
      adAccountId: metadata.selectedAdAccountId,
      accessToken,
      campaignId,
      name,
      dailyBudgetCents,
      billingEvent,
      optimizationGoal,
      targeting,
      status,
    });
    return { status: "COMPLETED", rawResult: { adSetId } };
  }

  // Three sequential Marketing API calls: upload the image (if given) ->
  // create the AdCreative -> create the Ad. If a later step fails, the
  // resource created by an earlier step is left orphaned on Meta's side
  // (not cleaned up) — the error message below names which step failed so
  // this is at least visible, not silent.
  private async createAd(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
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

    const asset = await prisma.asset.findUnique({
      where: { id: imageAssetId },
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

    try {
      const { adId } = await createMetaAd({
        adAccountId: metadata.selectedAdAccountId,
        accessToken,
        adSetId,
        name,
        creativeId,
        status,
      });
      return {
        status: "COMPLETED",
        rawResult: { adId, creativeId, imageHash },
      };
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: `Ad creation step failed (creative ${creativeId} was created): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
