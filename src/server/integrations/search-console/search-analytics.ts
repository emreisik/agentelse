import "server-only";

import { GSC_DAILY_ROW_CAP, type GscQueryRequest } from "@/lib/seo/catalog";
import {
  parseGscResponse,
  type GscQueryResponse,
  type GscRow,
} from "@/lib/seo/response";
import { googleFetchJson } from "@/server/integrations/google/http";

import { mockSearchAnalytics } from "./mock";

// Search Console searchAnalytics.query istemcisi
// (docs/google-search-console-plan.md §3.3, §5.1). Düz `fetch`; ağ kapısı,
// zaman aşımı ve güvenli tekrar google/http.ts'te. Kota kararı (dakika
// sınırı, LOAD/RATE bekletmesi) çağıranda, her sayfadan önce `beforePage`
// ile verilir. Mock modunda fetch hiç çağrılmaz.

export const SEARCH_CONSOLE_BASE =
  "https://searchconsole.googleapis.com/webmasters/v3";

export function gscMockMode(): boolean {
  return process.env.AGENTELSE_PROVIDER_MODE === "mock";
}

// İstek gövdesi; süzgeç yoksa dimensionFilterGroups hiç gönderilmez.
function requestBody(request: GscQueryRequest): Record<string, unknown> {
  const { dimensionFilterGroups, ...rest } = request;
  return dimensionFilterGroups && dimensionFilterGroups.length > 0
    ? { ...rest, dimensionFilterGroups }
    : rest;
}

export async function querySearchAnalytics(
  accessToken: string,
  siteUrl: string,
  request: GscQueryRequest,
): Promise<GscQueryResponse> {
  if (gscMockMode()) {
    return parseGscResponse(mockSearchAnalytics(siteUrl, request));
  }
  const raw = await googleFetchJson<unknown>(
    `${SEARCH_CONSOLE_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody(request)),
    },
    { kind: "report" },
  );
  return parseGscResponse(raw);
}

export type GscPagedResult = {
  rows: GscRow[];
  pages: number;
  truncated: boolean;
  firstIncompleteDate: string | null;
  responseAggregationType: string | null;
};

// startRow ile sayfalama. Kısa sayfada ya da maxPages'te durur. Kırpılmış
// sayılır: maxPages'te dolu bir sayfayla durulduysa ya da Google'ın 50.000
// satır sınırına tam olarak ulaşıldıysa (son sayfa boş/kısa döndü ama
// toplam tam sınırda). beforePage her sayfa isteğinden önce beklenir ve
// fırlatırsa sayfalama durur (kota, süre bütçesi).
export async function querySearchAnalyticsPaged(
  accessToken: string,
  siteUrl: string,
  request: GscQueryRequest,
  options: {
    maxPages: number;
    beforePage?: (pageIndex: number) => Promise<void> | void;
  },
): Promise<GscPagedResult> {
  const rows: GscRow[] = [];
  let pages = 0;
  let lastPageFull = false;
  let firstIncompleteDate: string | null = null;
  let responseAggregationType: string | null = null;
  const maxPages = Math.max(1, options.maxPages);

  for (let index = 0; index < maxPages; index += 1) {
    await options.beforePage?.(index);
    const response = await querySearchAnalytics(accessToken, siteUrl, {
      ...request,
      startRow: request.startRow + index * request.rowLimit,
    });
    pages += 1;
    rows.push(...response.rows);
    firstIncompleteDate ??= response.firstIncompleteDate;
    responseAggregationType ??= response.responseAggregationType;
    lastPageFull = response.rows.length >= request.rowLimit;
    if (!lastPageFull) break;
  }

  return {
    rows,
    pages,
    truncated: lastPageFull || rows.length === GSC_DAILY_ROW_CAP,
    firstIncompleteDate,
    responseAggregationType,
  };
}
