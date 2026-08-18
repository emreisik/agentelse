import "server-only";

import type { CapabilityKey, ExecutionProviderType } from "@prisma/client";

import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  fetchGa4Report,
  fetchSearchConsoleReport,
  type GoogleCredentialMetadata,
} from "@/server/integrations/google-client";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import type {
  ExecutionAcceptedResult,
  ExecutionPolicyContext,
  ExecutionProvider,
  ExecutionRequest,
  ProviderExecutionStatus,
} from "@/server/execution/types";

// Gerçek GA4 Data API + Search Console API — OpenClawProvider'ın tarayıcı
// otomasyonu yerine, projede bir OAuth ile bağlanmış Google hesabı ve seçili
// bir property/site varsa onu kullanır. provider-registry.ts'de
// OpenClawProvider'dan önce kayıtlı: gerçek API her zaman ekran kazımaya
// tercih edilir (meta-api-provider.ts ile aynı desen).
const OWNED_CAPABILITIES: ReadonlySet<CapabilityKey> = new Set<CapabilityKey>([
  "ANALYTICS_ANALYSIS",
]);

// Rapor penceresi: tek seferlik "Test Et" 7 gün kullanıyor, gerçek analiz
// görevi burada 28 gün — trend görmeye yeter, ekstra sorgu maliyeti yok.
const REPORT_WINDOW_DAYS = 28;

type StoredResult = {
  status: "COMPLETED" | "FAILED";
  rawResult?: unknown;
  errorMessage?: string;
};

const store = new Map<string, StoredResult>();

async function findActiveGoogleCredential(projectId: string) {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "google" } },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  return credential;
}

export class GoogleApiProvider implements ExecutionProvider {
  readonly key = "google-api";
  readonly type: ExecutionProviderType = "API";

  get isConfigured(): boolean {
    return isIntegrationConfigured("GOOGLE");
  }

  async canExecute(
    capability: CapabilityKey,
    context: ExecutionPolicyContext,
  ): Promise<boolean> {
    if (!this.isConfigured) return false;
    if (!OWNED_CAPABILITIES.has(capability)) return false;

    const credential = await findActiveGoogleCredential(context.projectId);
    if (!credential) return false;

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    return Boolean(
      metadata.selectedGa4PropertyId || metadata.selectedSearchConsoleSite,
    );
  }

  // Google API çağrıları senkron ve saniyeler içinde döner —
  // OpenClawProvider/MetaApiProvider'ın "senkron çalıştır, sonucu
  // önbelleğe al" desenini izliyoruz.
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
        errorMessage: "Unknown Google API execution reference",
        isMock: false,
      };
    }
    return { ...record, isMock: false };
  }

  private async runCapability(
    request: ExecutionRequest,
  ): Promise<StoredResult> {
    const credential = await findActiveGoogleCredential(
      request.context.projectId,
    );
    if (!credential) {
      return { status: "FAILED", errorMessage: "Google bağlantısı bulunamadı" };
    }
    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;

    try {
      const accessToken = await getFreshGoogleAccessToken(credential);
      return await this.analyzeAnalytics(accessToken, metadata);
    } catch (error) {
      return {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async analyzeAnalytics(
    accessToken: string,
    metadata: GoogleCredentialMetadata,
  ): Promise<StoredResult> {
    const [ga4, searchConsole] = await Promise.all([
      metadata.selectedGa4PropertyId
        ? fetchGa4Report(
            accessToken,
            metadata.selectedGa4PropertyId,
            REPORT_WINDOW_DAYS,
          )
        : Promise.resolve(null),
      metadata.selectedSearchConsoleSite
        ? fetchSearchConsoleReport(
            accessToken,
            metadata.selectedSearchConsoleSite,
            REPORT_WINDOW_DAYS,
          )
        : Promise.resolve(null),
    ]);

    if (!ga4 && !searchConsole) {
      return {
        status: "FAILED",
        errorMessage: "Seçili GA4 property veya Search Console site yok",
      };
    }

    const parts: string[] = [];
    if (ga4) {
      parts.push(
        `GA4: ${ga4.activeUsers} kullanıcı, ${ga4.sessions} oturum (${REPORT_WINDOW_DAYS}g)`,
      );
    }
    if (searchConsole) {
      parts.push(
        `Search Console: ${searchConsole.clicks} tıklama / ${searchConsole.impressions} gösterim, ` +
          `ort. sıra ${searchConsole.position.toFixed(1)} (${REPORT_WINDOW_DAYS}g)`,
      );
    }

    return {
      status: "COMPLETED",
      rawResult: {
        text: parts.join(" · "),
        windowDays: REPORT_WINDOW_DAYS,
        ga4,
        searchConsole,
      },
    };
  }
}
