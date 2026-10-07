import "server-only";

import { googleFetchJson } from "../http";
import { BigQueryError } from "./errors";
import { bqTable, isValidDatasetId, isValidGcpProjectId } from "./identifiers";
import type {
  BigQueryBackend,
  BqCell,
  BqColumn,
  BqDatasetInfo,
  BqDryRunResult,
  BqQueryRequest,
  BqQueryResult,
  BqTableInfo,
} from "./types";

// BigQuery REST v2 (düz fetch, SDK yok). İş ÖDEMELİ olduğu için jobs.query
// POST'u googleFetchJson'a retry:false ile gider: aktarım katmanı tekrarı
// ikinci bir faturalanan iş açamaz; tekrar yalnız çağıran katmanda, aynı
// requestId ile (idempotent) yapılır. Sonuç yoklaması (GET) varsayılan
// tekrarı kullanır.

const BASE = "https://bigquery.googleapis.com/bigquery/v2";
const DEFAULT_TIMEOUT_MS = 90_000;
// Sunucunun tek istekte bekleyeceği süre (jobs.query ve yoklama).
const SERVER_WAIT_MS = 20_000;
const PAGE_SIZE_MAX = 10_000;
const POLL_PAUSE_MS = 500;

type FetchJson = typeof googleFetchJson;

type SchemaField = { name?: string; type?: string; mode?: string };

type QueryResponse = {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: SchemaField[] };
  rows?: { f?: { v?: unknown }[] }[];
  totalRows?: string;
  pageToken?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
};

type JobResponse = {
  statistics?: { query?: { totalBytesBilled?: string } };
};

type RestDeps = {
  fetchJson?: FetchJson;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

// BigQuery etiket değeri yalnız küçük harf, rakam, "_" ve "-" alır (en çok
// 63); "." gibi bir karakter HER sorguyu 400 ile düşürür. Sahte arka uç ham
// purpose ile yönlendirir, yalnız etiket temizlenir.
export function jobLabelValue(purpose: string): string {
  const cleaned = purpose.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return cleaned.slice(0, 63) || "unknown";
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function columnType(type: string | undefined): BqColumn["type"] {
  switch (type) {
    case "STRING":
      return "STRING";
    case "INTEGER":
    case "INT64":
      return "INTEGER";
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return "FLOAT";
    case "BOOLEAN":
    case "BOOL":
      return "BOOLEAN";
    case "DATE":
      return "DATE";
    case "TIMESTAMP":
      return "TIMESTAMP";
    default:
      return "OTHER";
  }
}

function decodeCell(value: unknown, type: BqColumn["type"]): BqCell {
  if (value === null || value === undefined) return null;
  if (type === "INTEGER" || type === "FLOAT") {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "BOOLEAN") return value === true || value === "true";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function decodeRows(
  rows: QueryResponse["rows"],
  columns: BqColumn[],
): BqCell[][] {
  return (rows ?? []).map((row) =>
    columns.map((column, index) =>
      decodeCell(row.f?.[index]?.v, column.type),
    ),
  );
}

function toNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function queryBody(
  request: BqQueryRequest,
  maxResults: number,
  dryRun: boolean,
): Record<string, unknown> {
  return {
    query: request.sql,
    useLegacySql: false,
    parameterMode: "NAMED",
    queryParameters: request.params.map((param) => ({
      name: param.name,
      parameterType: { type: param.type },
      parameterValue: { value: String(param.value) },
    })),
    maximumBytesBilled: String(request.maxBytesBilled),
    maxResults,
    timeoutMs: SERVER_WAIT_MS,
    location: request.location ?? undefined,
    requestId: request.requestId,
    dryRun: dryRun ? true : undefined,
    labels: { app: "agentelse", purpose: jobLabelValue(request.purpose) },
  };
}

export function createRestBackend(deps: RestDeps = {}): BigQueryBackend {
  const fetchJson: FetchJson = deps.fetchJson ?? googleFetchJson;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  function resultsUrl(
    projectId: string,
    jobId: string,
    location: string | undefined,
    params: { pageToken?: string; maxResults: number; timeoutMs?: number },
  ): string {
    const query = new URLSearchParams();
    if (location) query.set("location", location);
    if (params.pageToken) query.set("pageToken", params.pageToken);
    query.set("maxResults", String(params.maxResults));
    if (params.timeoutMs !== undefined) {
      query.set("timeoutMs", String(params.timeoutMs));
    }
    return `${BASE}/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}?${query.toString()}`;
  }

  // Faturalanan bayt yalnız bilgi içindir; alınamazsa sorgu başarısız olmaz.
  async function billedBytes(
    projectId: string,
    jobId: string,
    location: string | undefined,
    token: string,
  ): Promise<number | null> {
    try {
      const url = `${BASE}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}${location ? `?location=${encodeURIComponent(location)}` : ""}`;
      const job = await fetchJson<JobResponse>(
        url,
        { headers: authHeaders(token) },
        { kind: "report" },
      );
      return toNumberOrNull(job?.statistics?.query?.totalBytesBilled);
    } catch {
      return null;
    }
  }

  // Süre dolunca iş Google'da sürüp müşteriye faturalanmasın: iptal en iyi
  // çabayladır (hata yutulur; asıl hata TIMEOUT olarak fırlatılır).
  async function cancelJob(
    projectId: string,
    jobId: string,
    location: string | undefined,
    token: string,
  ): Promise<void> {
    try {
      const url = `${BASE}/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel${location ? `?location=${encodeURIComponent(location)}` : ""}`;
      await fetchJson<unknown>(
        url,
        { method: "POST", headers: authHeaders(token) },
        { kind: "report", retry: false },
      );
    } catch {
      // İptal edilemediyse iş kendi sürecinde biter; tavan maximumBytesBilled'dır.
    }
  }

  return {
    async query(request, token): Promise<BqQueryResult> {
      const startedAt = now();
      const deadline = startedAt + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const pageSize = Math.min(request.maxRows, PAGE_SIZE_MAX);

      let response = await fetchJson<QueryResponse>(
        `${BASE}/projects/${encodeURIComponent(request.projectId)}/queries`,
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(queryBody(request, pageSize, false)),
        },
        // Aktarım tekrarı yok: ikinci bir faturalı iş açılamaz.
        { kind: "report", retry: false },
      );

      const jobId = response?.jobReference?.jobId;
      const location = response?.jobReference?.location ?? request.location ?? undefined;

      while (!response?.jobComplete) {
        if (!jobId) throw new BigQueryError("UNKNOWN");
        const remaining = deadline - now();
        if (remaining <= 0) {
          await cancelJob(request.projectId, jobId, location, token);
          throw new BigQueryError("TIMEOUT");
        }
        response = await fetchJson<QueryResponse>(
          resultsUrl(request.projectId, jobId, location, {
            maxResults: pageSize,
            timeoutMs: Math.min(SERVER_WAIT_MS, remaining),
          }),
          { headers: authHeaders(token) },
          { kind: "report" },
        );
        if (!response?.jobComplete) await sleep(POLL_PAUSE_MS);
      }

      const columns: BqColumn[] = (response.schema?.fields ?? []).map(
        (field) => ({
          name: field.name ?? "",
          // Yinelenen alanlar tek hücreye sığmaz
          type: field.mode === "REPEATED" ? "OTHER" : columnType(field.type),
        }),
      );
      const rows = decodeRows(response.rows, columns);
      let pageToken = response.pageToken;
      while (pageToken && rows.length < request.maxRows) {
        if (!jobId) break;
        if (deadline - now() <= 0) {
          await cancelJob(request.projectId, jobId, location, token);
          throw new BigQueryError("TIMEOUT");
        }
        const page: QueryResponse = await fetchJson<QueryResponse>(
          resultsUrl(request.projectId, jobId, location, {
            pageToken,
            maxResults: Math.min(request.maxRows - rows.length, PAGE_SIZE_MAX),
          }),
          { headers: authHeaders(token) },
          { kind: "report" },
        );
        rows.push(...decodeRows(page.rows, columns));
        pageToken = page.pageToken;
      }

      const totalRows = Math.max(toNumber(response.totalRows), rows.length);
      const kept = rows.length > request.maxRows ? rows.slice(0, request.maxRows) : rows;
      return {
        columns,
        rows: kept,
        totalRows,
        truncated: totalRows > kept.length,
        bytesProcessed: toNumber(response.totalBytesProcessed),
        bytesBilled: jobId
          ? await billedBytes(request.projectId, jobId, location, token)
          : null,
        cacheHit: response.cacheHit === true,
      };
    },

    async dryRun(request, token): Promise<BqDryRunResult> {
      const response = await fetchJson<QueryResponse>(
        `${BASE}/projects/${encodeURIComponent(request.projectId)}/queries`,
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify(queryBody(request, 1, true)),
        },
        { kind: "report", retry: false },
      );
      return { bytesProcessed: toNumber(response?.totalBytesProcessed) };
    },

    async getTable(input, token): Promise<BqTableInfo> {
      // Tanımlayıcılar URL'ye girmeden doğrulanır.
      bqTable(input);
      const table = await fetchJson<{
        numRows?: string;
        numBytes?: string;
        location?: string;
        timePartitioning?: { field?: string };
      }>(
        `${BASE}/projects/${encodeURIComponent(input.projectId)}/datasets/${encodeURIComponent(input.dataset)}/tables/${encodeURIComponent(input.table)}`,
        { headers: authHeaders(token) },
        { kind: "report" },
      );
      return {
        numRows: toNumberOrNull(table?.numRows),
        sizeBytes: toNumberOrNull(table?.numBytes),
        location: table?.location ?? null,
        partitionField: table?.timePartitioning?.field ?? null,
      };
    },

    async getDataset(input, token): Promise<BqDatasetInfo> {
      if (!isValidGcpProjectId(input.projectId) || !isValidDatasetId(input.dataset)) {
        throw new BigQueryError("INVALID_REQUEST");
      }
      const dataset = await fetchJson<{ location?: string }>(
        `${BASE}/projects/${encodeURIComponent(input.projectId)}/datasets/${encodeURIComponent(input.dataset)}`,
        { headers: authHeaders(token) },
        { kind: "report" },
      );
      return { location: dataset?.location ?? null };
    },
  };
}
