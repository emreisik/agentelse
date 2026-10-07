import "server-only";

import { randomUUID } from "node:crypto";

import { BigQueryError, classifyBigQueryError } from "./errors";
import {
  assertReadOnlySql,
  isValidDatasetId,
  isValidGcpProjectId,
  isValidTableId,
} from "./identifiers";
import {
  bigQueryMockMode,
  createMockBackend,
  MOCK_SERVICE_ACCOUNT_EMAIL,
} from "./mock";
import { createRestBackend } from "./rest-backend";
import {
  createServiceAccountTokenProvider,
  type TokenProvider,
} from "./service-account";
import type {
  BigQueryBackend,
  BqDatasetInfo,
  BqDryRunResult,
  BqQueryRequest,
  BqQueryResult,
  BqTableInfo,
} from "./types";

// BigQuery'ye tek giriş (docs/search-agency.md). Her istek burada doğrulanır:
// salt-okunur SQL, bayt tavanı, satır sınırı, geçerli proje kimliği. Her hata
// BigQueryError'a çevrilir; Google'ın ham mesajı dışarı çıkmaz.

// Hiçbir istek bunu aşamaz (200 GiB); çağıranın kendi sınırı bundan küçüktür.
export const BQ_ABSOLUTE_MAX_BYTES = 214_748_364_800;

const MAX_ROWS_LIMIT = 1_000_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PARAM_TYPES = new Set(["STRING", "INT64", "FLOAT64", "DATE", "BOOL"]);
const LOCATION = /^[A-Za-z0-9-]{2,40}$/;

export type BigQueryClient = {
  configured(): boolean;
  serviceAccountEmail(): string | null;
  query(request: BqQueryRequest): Promise<BqQueryResult>;
  dryRun(request: BqQueryRequest): Promise<BqDryRunResult>;
  getTable(input: {
    projectId: string;
    dataset: string;
    table: string;
  }): Promise<BqTableInfo>;
  getDataset(input: {
    projectId: string;
    dataset: string;
  }): Promise<BqDatasetInfo>;
};

export type BigQueryClientOptions = {
  backend?: BigQueryBackend;
  tokenProvider?: TokenProvider;
};

function invalid(): never {
  throw new BigQueryError("INVALID_REQUEST");
}

function validateRequest(request: BqQueryRequest): BqQueryRequest {
  assertReadOnlySql(request.sql);
  if (!request.purpose) invalid();
  if (!isValidGcpProjectId(request.projectId)) invalid();
  if (request.location !== null && !LOCATION.test(request.location)) invalid();
  if (
    !Number.isInteger(request.maxBytesBilled) ||
    request.maxBytesBilled <= 0 ||
    request.maxBytesBilled > BQ_ABSOLUTE_MAX_BYTES
  ) {
    invalid();
  }
  if (
    !Number.isInteger(request.maxRows) ||
    request.maxRows < 1 ||
    request.maxRows > MAX_ROWS_LIMIT
  ) {
    invalid();
  }
  for (const param of request.params) {
    if (!PARAM_NAME.test(param.name) || !PARAM_TYPES.has(param.type)) invalid();
  }
  const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    ...request,
    timeoutMs: Math.min(
      DEFAULT_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_MS),
    ),
    requestId: request.requestId || randomUUID(),
  };
}

// Gerçek servis hesabı sağlayıcısı süreç boyunca tek örnektir (token önbelleği
// çağrılar arasında yaşasın); env değişirse yeniden kurulur.
let sharedProvider: { raw: string | undefined; provider: TokenProvider } | null =
  null;

function sharedServiceAccountProvider(): TokenProvider {
  const raw = process.env.GOOGLE_BIGQUERY_SA_KEY;
  if (!sharedProvider || sharedProvider.raw !== raw) {
    sharedProvider = { raw, provider: createServiceAccountTokenProvider() };
  }
  return sharedProvider.provider;
}

const mockTokenProvider: TokenProvider = {
  email: MOCK_SERVICE_ACCOUNT_EMAIL,
  configured: true,
  getToken: async () => "mock-token",
};

export function bigQueryClient(
  options: BigQueryClientOptions = {},
): BigQueryClient {
  const mock = bigQueryMockMode();
  const backend: BigQueryBackend =
    options.backend ?? (mock ? createMockBackend() : createRestBackend());
  const tokens: TokenProvider =
    options.tokenProvider ??
    (mock ? mockTokenProvider : sharedServiceAccountProvider());

  // Her hata BigQueryError'a çevrilir; ham Google mesajı atılır.
  async function guarded<T>(run: (token: string) => Promise<T>): Promise<T> {
    try {
      return await run(await tokens.getToken());
    } catch (error) {
      throw classifyBigQueryError(error);
    }
  }

  return {
    configured: () => tokens.configured,
    serviceAccountEmail: () => tokens.email,

    async query(request) {
      const checked = validateRequest(request);
      return guarded((token) => backend.query(checked, token));
    },

    async dryRun(request) {
      const checked = validateRequest(request);
      return guarded((token) => backend.dryRun(checked, token));
    },

    async getTable(input) {
      if (
        !isValidGcpProjectId(input.projectId) ||
        !isValidDatasetId(input.dataset) ||
        !isValidTableId(input.table)
      ) {
        throw new BigQueryError("INVALID_REQUEST");
      }
      return guarded((token) => backend.getTable(input, token));
    },

    async getDataset(input) {
      if (
        !isValidGcpProjectId(input.projectId) ||
        !isValidDatasetId(input.dataset)
      ) {
        throw new BigQueryError("INVALID_REQUEST");
      }
      return guarded((token) => backend.getDataset(input, token));
    },
  };
}
