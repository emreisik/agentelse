import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/server/security/crypto";
import {
  createMetaCampaign,
  fetchMetaAdsInsights,
  fetchPageAccessToken,
  publishInstagramPost,
  updateMetaCampaign,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Gerçek Meta Graph/Marketing API — OpenClawProvider'ın tarayıcı otomasyonu
// yerine, projede bir OAuth ile bağlanmış Meta hesabı varsa onu kullanır.
// provider-registry.ts'de OpenClawProvider'dan önce kayıtlı: gerçek API her
// zaman ekran kazımaya tercih edilir.
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "INSTAGRAM_PUBLISH",
  "META_ADS_ANALYSIS",
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
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
    return Boolean(metadata.selectedAdAccountId);
  }

  // Meta Graph/Marketing API çağrıları senkron ve saniyeler içinde döner —
  // OpenClawProvider'ın "senkron çalıştır, sonucu önbelleğe al" desenini
  // izliyoruz: execute() işlemi baştan sona burada yürütür, hata durumunda
  // fırlatmak yerine FAILED sonucu saklar; getStatus() sadece geri okur.
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
      return { status: "FAILED", errorMessage: "Meta bağlantısı bulunamadı" };
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
        default:
          return {
            status: "FAILED",
            errorMessage: `MetaApiProvider capability ${request.capability} desteklemiyor`,
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
        errorMessage: "Seçili Page'in bağlı Instagram hesabı yok",
      };
    }
    const imageUrl =
      typeof payload.imageUrl === "string" ? payload.imageUrl : undefined;
    const caption = typeof payload.caption === "string" ? payload.caption : "";
    if (!imageUrl) {
      return {
        status: "FAILED",
        errorMessage: "INSTAGRAM_PUBLISH için `imageUrl` gerekli",
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
      // requestedMediaType: canlıda gerçekten hangi media_type'ın Meta'ya
      // gönderildiğini sonradan doğrulamak için (bkz. targetFormat akışı) —
      // gözlemlenebilirlik amaçlı, kalıcı olarak faydalı.
      rawResult: { postId, requestedMediaType: mediaType ?? "FEED" },
    };
  }

  private async analyzeAds(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "Seçili reklam hesabı yok" };
    }
    const datePreset =
      typeof payload.datePreset === "string" ? payload.datePreset : undefined;
    const insights = await fetchMetaAdsInsights({
      adAccountId: metadata.selectedAdAccountId,
      accessToken,
      datePreset,
    });
    return { status: "COMPLETED", rawResult: insights };
  }

  private async createCampaign(
    metadata: MetaCredentialMetadata,
    accessToken: string,
    payload: Record<string, unknown>,
  ): Promise<StoredResult> {
    if (!metadata.selectedAdAccountId) {
      return { status: "FAILED", errorMessage: "Seçili reklam hesabı yok" };
    }
    const name = typeof payload.name === "string" ? payload.name : undefined;
    const objective =
      typeof payload.objective === "string" ? payload.objective : undefined;
    if (!name || !objective) {
      return {
        status: "FAILED",
        errorMessage: "META_CAMPAIGN_CREATE için `name` ve `objective` gerekli",
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
        errorMessage: "META_CAMPAIGN_UPDATE için `campaignId` gerekli",
      };
    }
    const status =
      payload.status === "ACTIVE" || payload.status === "PAUSED"
        ? payload.status
        : undefined;
    const dailyBudgetCents =
      typeof payload.dailyBudgetCents === "number"
        ? payload.dailyBudgetCents
        : undefined;

    await updateMetaCampaign({
      campaignId,
      accessToken,
      status,
      dailyBudgetCents,
    });
    return { status: "COMPLETED", rawResult: { campaignId } };
  }
}
