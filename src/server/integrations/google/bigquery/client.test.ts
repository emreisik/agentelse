import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleApiError, googleErrorFromResponse } from "../errors";
import { BQ_ABSOLUTE_MAX_BYTES, bigQueryClient } from "./client";
import { BigQueryError } from "./errors";
import {
  MOCK_SERVICE_ACCOUNT_EMAIL,
  registerBigQueryMockHandler,
  resetBigQueryMock,
} from "./mock";
import type { TokenProvider } from "./service-account";
import type {
  BigQueryBackend,
  BqQueryRequest,
  BqQueryResult,
} from "./types";

// Bu dosyanın kanıtladığı: istemci her isteği doğrular (salt-okunur SQL,
// bayt tavanı, proje kimliği, süre sınırı), requestId doldurur, her arka uç
// hatasını BigQueryError'a çevirir ve kipe göre doğru arka ucu seçer.

const RESULT: BqQueryResult = {
  columns: [{ name: "a", type: "INTEGER" }],
  rows: [[1]],
  totalRows: 1,
  truncated: false,
  bytesProcessed: 1,
  bytesBilled: 1,
  cacheHit: false,
};

function request(overrides: Partial<BqQueryRequest> = {}): BqQueryRequest {
  return {
    purpose: "gsc.test",
    projectId: "my-project-1",
    location: null,
    sql: "SELECT 1",
    params: [],
    maxBytesBilled: 1_000_000,
    maxRows: 10,
    ...overrides,
  };
}

function fakeBackend() {
  const backend: BigQueryBackend = {
    query: vi.fn(async () => RESULT),
    dryRun: vi.fn(async () => ({ bytesProcessed: 5 })),
    getTable: vi.fn(async () => ({
      numRows: 1,
      sizeBytes: 1,
      location: "US",
      partitionField: null,
    })),
    getDataset: vi.fn(async () => ({ location: "US" })),
  };
  return backend;
}

const provider: TokenProvider = {
  email: "sa@project.iam.gserviceaccount.com",
  configured: true,
  getToken: async () => "real-token",
};

beforeEach(() => {
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  resetBigQueryMock();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetBigQueryMock();
});

describe("validation gates", () => {
  async function rejects(over: Partial<BqQueryRequest>): Promise<string> {
    const backend = fakeBackend();
    const client = bigQueryClient({ backend, tokenProvider: provider });
    const error = await client.query(request(over)).catch((e: unknown) => e);
    expect(backend.query).not.toHaveBeenCalled();
    return error instanceof BigQueryError ? error.code : "OTHER";
  }

  it("refuses non read-only SQL", async () => {
    expect(await rejects({ sql: "DROP TABLE t" })).toBe("INVALID_REQUEST");
    expect(await rejects({ sql: "SELECT 1; SELECT 2" })).toBe("INVALID_REQUEST");
  });

  it("refuses a byte cap outside (0, absolute max]", async () => {
    expect(await rejects({ maxBytesBilled: 0 })).toBe("INVALID_REQUEST");
    expect(await rejects({ maxBytesBilled: -5 })).toBe("INVALID_REQUEST");
    expect(await rejects({ maxBytesBilled: BQ_ABSOLUTE_MAX_BYTES + 1 })).toBe(
      "INVALID_REQUEST",
    );
    expect(await rejects({ maxBytesBilled: 1.5 })).toBe("INVALID_REQUEST");
  });

  it("accepts the absolute maximum itself", async () => {
    const client = bigQueryClient({
      backend: fakeBackend(),
      tokenProvider: provider,
    });
    await expect(
      client.query(request({ maxBytesBilled: BQ_ABSOLUTE_MAX_BYTES })),
    ).resolves.toEqual(RESULT);
  });

  it("refuses bad row limits, project ids, locations and params", async () => {
    expect(await rejects({ maxRows: 0 })).toBe("INVALID_REQUEST");
    expect(await rejects({ maxRows: 1_000_001 })).toBe("INVALID_REQUEST");
    expect(await rejects({ projectId: "Bad_Project" })).toBe("INVALID_REQUEST");
    expect(await rejects({ projectId: "org.com:project-1" })).toBe(
      "INVALID_REQUEST",
    );
    expect(await rejects({ location: "EU; DROP" })).toBe("INVALID_REQUEST");
    expect(
      await rejects({
        params: [{ name: "a b", type: "STRING", value: "x" }],
      }),
    ).toBe("INVALID_REQUEST");
    expect(await rejects({ purpose: "" })).toBe("INVALID_REQUEST");
  });

  it("clamps timeoutMs into 5000..90000", async () => {
    const backend = fakeBackend();
    const client = bigQueryClient({ backend, tokenProvider: provider });
    const seen = async (timeoutMs: number | undefined) => {
      await client.query(request({ timeoutMs }));
      const calls = vi.mocked(backend.query).mock.calls;
      return (calls[calls.length - 1] as [BqQueryRequest, string])[0].timeoutMs;
    };
    expect(await seen(undefined)).toBe(90_000);
    expect(await seen(100)).toBe(5_000);
    expect(await seen(1_000_000)).toBe(90_000);
    expect(await seen(30_000)).toBe(30_000);
  });

  it("validates dry runs and table lookups the same way", async () => {
    const backend = fakeBackend();
    const client = bigQueryClient({ backend, tokenProvider: provider });
    await expect(client.dryRun(request({ sql: "DELETE FROM t" }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      client.getTable({ projectId: "my-project-1", dataset: "a.b", table: "t" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.getDataset({ projectId: "BAD", dataset: "d" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(backend.dryRun).not.toHaveBeenCalled();
    expect(backend.getTable).not.toHaveBeenCalled();
    expect(backend.getDataset).not.toHaveBeenCalled();
  });
});

describe("requestId and token", () => {
  it("fills a random requestId once per call and keeps a given one", async () => {
    const backend = fakeBackend();
    const client = bigQueryClient({ backend, tokenProvider: provider });
    await client.query(request());
    await client.query(request());
    await client.query(request({ requestId: "mine" }));
    const calls = vi.mocked(backend.query).mock.calls as [BqQueryRequest, string][];
    const first = calls[0]?.[0].requestId as string;
    const second = calls[1]?.[0].requestId as string;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(calls[2]?.[0].requestId).toBe("mine");
  });

  it("passes the provider's token to the backend", async () => {
    const backend = fakeBackend();
    const client = bigQueryClient({ backend, tokenProvider: provider });
    await client.getDataset({ projectId: "my-project-1", dataset: "d" });
    expect(backend.getDataset).toHaveBeenCalledWith(
      { projectId: "my-project-1", dataset: "d" },
      "real-token",
    );
  });
});

describe("error mapping", () => {
  it("turns every backend failure into a BigQueryError", async () => {
    const failures: [unknown, string][] = [
      [googleErrorFromResponse(403, { error: { message: "Access Denied" } }), "NO_ACCESS"],
      [new GoogleApiError("x", undefined, { timedOut: true }), "TIMEOUT"],
      [new Error("raw secret detail"), "UNKNOWN"],
      [new BigQueryError("COST_CAP"), "COST_CAP"],
    ];
    for (const [failure, code] of failures) {
      const backend = fakeBackend();
      vi.mocked(backend.query).mockRejectedValueOnce(failure);
      const client = bigQueryClient({ backend, tokenProvider: provider });
      const error = await client.query(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BigQueryError);
      expect((error as BigQueryError).code).toBe(code);
      expect((error as BigQueryError).message).not.toContain("secret detail");
    }
  });

  it("maps token provider failures too", async () => {
    const broken: TokenProvider = {
      email: null,
      configured: false,
      getToken: async () => {
        throw new BigQueryError("NOT_CONFIGURED");
      },
    };
    const client = bigQueryClient({ backend: fakeBackend(), tokenProvider: broken });
    await expect(client.query(request())).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });
});

describe("configuration and default backend", () => {
  it("reports the injected provider in real mode", () => {
    const client = bigQueryClient({ backend: fakeBackend(), tokenProvider: provider });
    expect(client.configured()).toBe(true);
    expect(client.serviceAccountEmail()).toBe(provider.email);
  });

  it("is not configured in live mode without a key", () => {
    vi.stubEnv("GOOGLE_BIGQUERY_SA_KEY", "");
    const client = bigQueryClient({ backend: fakeBackend() });
    expect(client.configured()).toBe(false);
    expect(client.serviceAccountEmail()).toBeNull();
  });

  it("is configured with the mock account in mock mode, no key needed", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    vi.stubEnv("GOOGLE_BIGQUERY_SA_KEY", "");
    registerBigQueryMockHandler("gsc.", { query: () => RESULT });
    const client = bigQueryClient();
    expect(client.configured()).toBe(true);
    expect(client.serviceAccountEmail()).toBe(MOCK_SERVICE_ACCOUNT_EMAIL);
    await expect(client.query(request())).resolves.toEqual(RESULT);
    await expect(
      client.getDataset({ projectId: "my-project-1", dataset: "missing_x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses the REST backend (never the mock) in live mode", async () => {
    vi.stubEnv("GOOGLE_BIGQUERY_SA_KEY", "");
    registerBigQueryMockHandler("gsc.", { query: () => RESULT });
    const client = bigQueryClient();
    // Anahtar yok: istek mock handler'a hiç ulaşmadan NOT_CONFIGURED olur.
    await expect(client.query(request())).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });
});
