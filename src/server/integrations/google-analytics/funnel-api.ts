import "server-only";

import type { FunnelRequestBody } from "@/lib/website-analytics/funnel/request";
import { gaFunnelLiveAllowed } from "@/lib/website-analytics/agency/flags";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { googleFetchJson } from "@/server/integrations/google/http";
import { recordGaApiOutcome } from "@/server/website-analytics/api-counters";

import { gaMockMode } from "./data-api";

// GA4 Data API v1alpha `runFunnelReport` istemcisi (GA-F8, GA_FUNNEL). v1alpha
// kararsız olabilir: GA_FUNNEL_ALPHA=true ANİ KAPATMA anahtarıdır; kapalıyken
// gerçek modda hiç ağ çağrısı yapılmaz (mock çalışır). Ağ kapısı, zaman aşımı
// ve tekrar google/http.ts'te.

const ALPHA_BASE = "https://analyticsdata.googleapis.com/v1alpha";

export class FunnelUnavailableError extends Error {
  constructor() {
    super("Funnel reports are switched off");
    this.name = "FunnelUnavailableError";
  }
}

// data-api.ts'teki küçük sayaç sarmalının yerel kopyası (o dosya
// değiştirilmez).
async function counted<T>(run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    recordGaApiOutcome("ok");
    return result;
  } catch (error) {
    recordGaApiOutcome(
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN",
    );
    throw error;
  }
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

// Adı tohum alan küçük, deterministik karma (mock yanıtı için).
function seed(text: string): number {
  let hash = 7;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100_003;
  }
  return hash;
}

// Mock mod: adım adlarından türeyen sabit bir funnelTable. Ağa çıkmaz.
function mockFunnelResponse(
  propertyId: string,
  request: FunnelRequestBody,
): Record<string, unknown> {
  const names = request.funnel.steps.map((step) => step.name);
  let users = 800 + (seed(`${propertyId}:${names.join("|")}`) % 1200);
  const rows = names.map((name, index) => {
    const share = 0.45 + (seed(`${name}:${index}`) % 35) / 100;
    const next = index === names.length - 1 ? 0 : Math.round(users * share);
    const row = {
      dimensionValues: [{ value: `${index + 1}. ${name}` }],
      metricValues: [
        { value: String(users) },
        { value: index === names.length - 1 ? "0" : String(next / users) },
        { value: String(index === names.length - 1 ? 0 : users - next) },
        {
          value: index === names.length - 1 ? "0" : String((users - next) / users),
        },
      ],
    };
    users = next;
    return row;
  });
  return {
    funnelTable: {
      dimensionHeaders: [{ name: "funnelStepName" }],
      metricHeaders: [
        { name: "activeUsers" },
        { name: "funnelStepCompletionRate" },
        { name: "funnelStepAbandonments" },
        { name: "funnelStepAbandonmentRate" },
      ],
      rows,
    },
    propertyQuota: {
      tokensPerDay: { consumed: 10, remaining: 199_990 },
      tokensPerHour: { consumed: 10, remaining: 39_990 },
      tokensPerProjectPerHour: { consumed: 10, remaining: 13_990 },
    },
    kind: "analyticsData#runFunnelReport",
  };
}

// Ham yanıtı döner; ayrıştırma lib/website-analytics/funnel/parse.ts'te.
export async function runGaFunnelReport(
  accessToken: string,
  propertyId: string,
  request: FunnelRequestBody,
): Promise<unknown> {
  const mock = gaMockMode();
  // Kapatma anahtarı sayaçtan önce: hiç çağrı yapılmadı, hata sayılmaz.
  if (!mock && !gaFunnelLiveAllowed()) throw new FunnelUnavailableError();
  return counted(async () => {
    if (mock) return mockFunnelResponse(propertyId, request);
    return googleFetchJson<unknown>(
      `${ALPHA_BASE}/properties/${encodeURIComponent(propertyId)}:runFunnelReport`,
      {
        method: "POST",
        headers: headers(accessToken),
        body: JSON.stringify(request),
      },
      { kind: "report" },
    );
  });
}
