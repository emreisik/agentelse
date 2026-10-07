import { BigQueryError } from "./errors";
import type {
  BigQueryBackend,
  BqDatasetInfo,
  BqDryRunResult,
  BqQueryRequest,
  BqQueryResult,
  BqTableInfo,
} from "./types";

// Ağsız, deterministik BigQuery arka ucu (AGENTELSE_PROVIDER_MODE=mock).
// Sorguyu ilgili özellik kaydeder: handler, `purpose` önekine ("gsc." /
// "ga.") göre en uzun önek eşleşmesiyle seçilir.

export const MOCK_SERVICE_ACCOUNT_EMAIL =
  "agentelse-reader@mock-project.iam.gserviceaccount.com";

export type BigQueryMockHandler = {
  query(request: BqQueryRequest): BqQueryResult | Promise<BqQueryResult>;
  // Verilmezse kuru çalıştırma 50 MB döner.
  dryRun?(request: BqQueryRequest): BqDryRunResult | Promise<BqDryRunResult>;
};

const DEFAULT_DRY_RUN_BYTES = 50_000_000;

const handlers = new Map<string, BigQueryMockHandler>();

export function registerBigQueryMockHandler(
  prefix: string,
  handler: BigQueryMockHandler,
): void {
  handlers.set(prefix, handler);
}

export function resetBigQueryMock(): void {
  handlers.clear();
}

export function bigQueryMockMode(): boolean {
  return process.env.AGENTELSE_PROVIDER_MODE === "mock";
}

function handlerFor(purpose: string): BigQueryMockHandler | null {
  let best: string | null = null;
  for (const prefix of handlers.keys()) {
    if (
      purpose.startsWith(prefix) &&
      (best === null || prefix.length > best.length)
    ) {
      best = prefix;
    }
  }
  return best === null ? null : (handlers.get(best) ?? null);
}

export function createMockBackend(): BigQueryBackend {
  return {
    async query(request) {
      const handler = handlerFor(request.purpose);
      if (!handler) throw new BigQueryError("INVALID_REQUEST");
      const result = await handler.query(request);
      // Gerçek arka uç gibi: maxRows'tan fazlası okunmaz ve kesildi sayılır.
      if (result.rows.length <= request.maxRows) return result;
      return {
        ...result,
        rows: result.rows.slice(0, request.maxRows),
        truncated: true,
      };
    },

    async dryRun(request): Promise<BqDryRunResult> {
      const handler = handlerFor(request.purpose);
      if (handler?.dryRun) return handler.dryRun(request);
      return { bytesProcessed: DEFAULT_DRY_RUN_BYTES };
    },

    async getDataset(input): Promise<BqDatasetInfo> {
      if (input.dataset.startsWith("missing")) {
        throw new BigQueryError("NOT_FOUND");
      }
      if (input.dataset.startsWith("denied")) {
        throw new BigQueryError("NO_ACCESS");
      }
      return { location: "US" };
    },

    async getTable(input): Promise<BqTableInfo> {
      if (input.table.startsWith("missing") || input.dataset.startsWith("missing")) {
        throw new BigQueryError("NOT_FOUND");
      }
      return {
        numRows: 1_000_000,
        sizeBytes: 5_000_000_000,
        location: "US",
        partitionField: "data_date",
      };
    },
  };
}
