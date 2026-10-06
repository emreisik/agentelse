import "server-only";

import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import {
  parseGaReport,
  type GaParsedReport,
  type GaRawReport,
} from "@/lib/website-analytics/response";
import { googleFetchJson } from "@/server/integrations/google/http";

import { mockGaReport } from "./mock";

// GA4 Data API v1beta istemcisi (docs/google-analytics-plan.md §3.3). Her
// istekte `returnPropertyQuota` istenir; kota yöneticisi yanıttaki
// `propertyQuota`'yı saklar. `batchRunReports` aynı mülk için en çok 5 isteği
// tek HTTP çağrısında toplar (token yine istek başına sayılır). Ağ kapısı,
// zaman aşımı ve güvenli tekrar google/http.ts'te.

const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
export const GA_BATCH_SIZE = 5;

export function gaMockMode(): boolean {
  return process.env.AGENTELSE_PROVIDER_MODE === "mock";
}

function headers(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export async function runGaReport(
  accessToken: string,
  propertyId: string,
  request: GaRunReportRequest,
): Promise<GaParsedReport> {
  if (gaMockMode()) return parseGaReport(mockGaReport(propertyId, request));
  const raw = await googleFetchJson<GaRawReport>(
    `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify(request),
    },
    { kind: "report" },
  );
  return parseGaReport(raw);
}

// En çok 5 istek; yanıtlar istek sırasıyla döner. Biri geçersizse Google
// bütün çağrıyı 400 ile reddeder: çağıran, istekleri tek tek dener.
export async function runGaReportBatch(
  accessToken: string,
  propertyId: string,
  requests: GaRunReportRequest[],
): Promise<GaParsedReport[]> {
  if (requests.length === 0) return [];
  if (requests.length > GA_BATCH_SIZE) {
    throw new Error(`batchRunReports takes at most ${GA_BATCH_SIZE} requests`);
  }
  if (requests.length === 1) {
    return [await runGaReport(accessToken, propertyId, requests[0]!)];
  }
  if (gaMockMode()) {
    return requests.map((request) =>
      parseGaReport(mockGaReport(propertyId, request)),
    );
  }
  const raw = await googleFetchJson<{ reports?: GaRawReport[] }>(
    `${DATA_BASE}/properties/${encodeURIComponent(propertyId)}:batchRunReports`,
    {
      method: "POST",
      headers: headers(accessToken),
      body: JSON.stringify({ requests }),
    },
    { kind: "report" },
  );
  const reports = raw?.reports ?? [];
  return requests.map((_, index) => parseGaReport(reports[index] ?? null));
}
