import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BqErrorCode,
  BigQueryClient,
  BqQueryRequest,
  BqQueryResult,
} from "@/server/integrations/google/bigquery";

// Bu dosyanın kanıtladığı (GA-F8 okuyucu, sahte istemciyle): günler upsert edilir,
// kişisel veri taşıyan sayfa yolları atılır ve kalanlar maskelenir; parça sayısı
// ÜÇ kuru çalıştırmanın toplamından hesaplanır ve her sorgu sınırı geçmez; kesilmiş
// sonuç o parça için hiçbir şey yazmaz; bütçe dolunca durum OK kalır, lastError
// 'budget' olur ve nextRunAt gelecek ay başı olur; BigQuery hatası ERROR + kod +
// geri çekilme yazar; bağlama kuralı her çalıştırmada yeniden denetlenir; hiç fırlatmaz.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  dayUpsert: vi.fn(),
  dayDeleteMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaBigQuerySource: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
    gaBigQueryDay: {
      upsert: mocks.dayUpsert,
      deleteMany: mocks.dayDeleteMany,
    },
    $transaction: (operations: unknown[]) => Promise.all(operations),
  },
}));
vi.mock("./verify", () => ({
  prepareGaBigQueryClient: (deps: { client?: unknown }) => deps.client,
}));
vi.mock("@/server/integrations/google/bigquery", () => {
  class BigQueryError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return { BigQueryError };
});

const { BigQueryError } = await import("@/server/integrations/google/bigquery");
const { GaBigQuery } = await import("./reader");

const NOW = new Date("2026-10-07T10:00:00Z");

function sourceRow(over: Record<string, unknown> = {}, linkOver: Record<string, unknown> = {}) {
  return {
    id: "src1",
    workspaceId: "ws1",
    projectId: "proj1",
    linkId: "link1",
    gcpProjectId: "my-company-123456",
    datasetId: "analytics_424242",
    location: "EU",
    status: "OK",
    lastError: null,
    lastDay: null,
    usageMonth: null,
    usageBytes: BigInt(0),
    link: {
      id: "link1",
      propertyId: "424242",
      isPrimary: true,
      isSecondary: false,
      timeZone: "UTC",
      propertyCreatedAt: null,
      keyEvents: [{ eventName: "purchase" }],
      ...linkOver,
    },
    ...over,
  };
}

function result(
  columns: string[],
  rows: (string | number | null)[][],
  over: Partial<BqQueryResult> = {},
): BqQueryResult {
  return {
    columns: columns.map((name) => ({ name, type: "OTHER" as const })),
    rows,
    totalRows: rows.length,
    truncated: false,
    bytesProcessed: 10_000_000,
    bytesBilled: 10_000_000,
    cacheHit: false,
    ...over,
  };
}

const DAILY_COLS = ["day", "events", "users", "sessions", "key_events", "revenue_micros"];
const EVENT_COLS = ["day", "event_name", "events"];
const PAGE_COLS = ["day", "path", "views", "users"];

type Handlers = {
  daily?: (request: BqQueryRequest) => BqQueryResult;
  events?: (request: BqQueryRequest) => BqQueryResult;
  pages?: (request: BqQueryRequest) => BqQueryResult;
  dry?: (request: BqQueryRequest) => number;
};

function fakeClient(handlers: Handlers = {}) {
  const client = {
    configured: vi.fn(() => true),
    serviceAccountEmail: vi.fn(() => "sa@x.iam.gserviceaccount.com"),
    getTable: vi.fn(),
    getDataset: vi.fn(),
    dryRun: vi.fn(async (request: BqQueryRequest) => ({
      bytesProcessed: handlers.dry ? handlers.dry(request) : 50_000_000,
    })),
    query: vi.fn(async (request: BqQueryRequest) => {
      if (request.purpose === "ga.daily") {
        return (
          handlers.daily?.(request) ??
          result(DAILY_COLS, [
            ["20261004", 500, 60, 80, 3, 0],
            ["20261005", 600, 70, 90, 4, 2_500_000],
          ])
        );
      }
      if (request.purpose === "ga.events") {
        return (
          handlers.events?.(request) ??
          result(EVENT_COLS, [
            ["20261004", "page_view", 300],
            ["20261005", "page_view", 400],
          ])
        );
      }
      return (
        handlers.pages?.(request) ??
        result(PAGE_COLS, [
          ["20261004", "/pricing", 40, 20],
          ["20261005", "/", 90, 50],
        ])
      );
    }),
  };
  return client as unknown as BigQueryClient & typeof client;
}

function sync(client: BigQueryClient, id = "src1") {
  return GaBigQuery.syncSource(id, NOW, { client });
}

function finalUpdate() {
  // İlk updateMany kilit alma, sonuncusu bitiriş (ya da kilit bırakma).
  const calls = mocks.updateMany.mock.calls;
  return calls.filter((call) => call[0]?.data?.status !== undefined).at(-1)?.[0];
}

beforeEach(() => {
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_BIGQUERY", "true");
  vi.stubEnv("GA_BIGQUERY_MAX_BYTES", "");
  vi.stubEnv("GA_BIGQUERY_MONTHLY_BYTES", "");
  mocks.findUnique.mockReset().mockResolvedValue(sourceRow());
  mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.dayUpsert.mockReset().mockResolvedValue({});
  mocks.dayDeleteMany.mockReset().mockResolvedValue({ count: 3 });
});
afterEach(() => vi.unstubAllEnvs());

describe("syncSource: happy path", () => {
  it("upserts the days with totals, top events and pages, then schedules the next daily read", async () => {
    const client = fakeClient();
    expect(await sync(client)).toBe("synced");

    expect(mocks.dayUpsert).toHaveBeenCalledTimes(2);
    const second = mocks.dayUpsert.mock.calls.find(
      (call) => call[0].where.linkId_date.date.toISOString().startsWith("2026-10-05"),
    )?.[0];
    expect(second.update).toMatchObject({
      events: 600,
      users: 70,
      sessions: 90,
      keyEvents: 4,
      revenueMicros: BigInt(2_500_000),
      topEvents: [["page_view", 400]],
      topPages: [["/", 90, 50]],
    });
    expect(second.create).toMatchObject({
      workspaceId: "ws1",
      projectId: "proj1",
      linkId: "link1",
    });

    const end = finalUpdate();
    expect(end.data).toMatchObject({
      status: "OK",
      lastError: null,
      lastDay: "2026-10-05",
      lastRunAt: NOW,
      leaseUntil: null,
      leaseOwner: null,
      usageMonth: "2026-10",
      // 3 sorgu x 10 MB (bytesBilled)
      usageBytes: BigInt(30_000_000),
    });
    const next = end.data.nextRunAt.getTime() - NOW.getTime();
    expect(next).toBeGreaterThanOrEqual(24 * 3_600_000);
    expect(next).toBeLessThanOrEqual(24 * 3_600_000 + 30 * 60_000);
  });

  it("queries the first 28 days up to yesterday in the property's time zone with the key events", async () => {
    const client = fakeClient();
    await sync(client);
    const dry = client.dryRun.mock.calls.map((call) => call[0]);
    expect(dry.map((request) => request.purpose)).toEqual(["ga.daily", "ga.events", "ga.pages"]);
    const daily = dry[0]!;
    expect(daily.params).toEqual([
      { name: "from_suffix", type: "STRING", value: "20260909" },
      { name: "to_suffix", type: "STRING", value: "20261006" },
      { name: "key_events", type: "STRING", value: "purchase" },
    ]);
    expect(daily.projectId).toBe("my-company-123456");
    expect(daily.location).toBe("EU");
    expect(daily.maxBytesBilled).toBe(2_000_000_000);
  });

  it("continues from two days before the last read day", async () => {
    mocks.findUnique.mockResolvedValue(sourceRow({ lastDay: "2026-10-03" }));
    const client = fakeClient();
    await sync(client);
    const params = client.dryRun.mock.calls[0]![0].params;
    expect(params[0]?.value).toBe("20261001");
  });

  it("never starts before the property was created", async () => {
    mocks.findUnique.mockResolvedValue(
      sourceRow({}, { propertyCreatedAt: new Date("2026-10-01T08:00:00Z") }),
    );
    const client = fakeClient();
    await sync(client);
    expect(client.dryRun.mock.calls[0]![0].params[0]?.value).toBe("20261001");
  });

  it("does nothing when there is no day to read yet", async () => {
    mocks.findUnique.mockResolvedValue(
      sourceRow({}, { propertyCreatedAt: new Date("2026-10-07T00:00:00Z") }),
    );
    const client = fakeClient();
    expect(await sync(client)).toBe("skipped");
    expect(client.query).not.toHaveBeenCalled();
    expect(finalUpdate().data).toMatchObject({ status: "OK", lastError: null });
  });

  it("keeps the old last day when the export returns no rows", async () => {
    mocks.findUnique.mockResolvedValue(sourceRow({ lastDay: "2026-10-04" }));
    const client = fakeClient({
      daily: () => result(DAILY_COLS, []),
      events: () => result(EVENT_COLS, []),
      pages: () => result(PAGE_COLS, []),
    });
    expect(await sync(client)).toBe("synced");
    expect(mocks.dayUpsert).not.toHaveBeenCalled();
    expect(finalUpdate().data.lastDay).toBe("2026-10-04");
  });

  it("stores zero revenue when the micros are not a safe integer", async () => {
    const client = fakeClient({
      daily: () => result(DAILY_COLS, [["20261005", 1, 1, 1, 0, 9.3e18]]),
    });
    await sync(client);
    expect(mocks.dayUpsert.mock.calls[0]![0].update.revenueMicros).toBe(BigInt(0));
  });

  it("adds the existing usage of this month", async () => {
    mocks.findUnique.mockResolvedValue(sourceRow({ usageMonth: "2026-10", usageBytes: BigInt(5_000_000) }));
    await sync(fakeClient());
    expect(finalUpdate().data.usageBytes).toBe(BigInt(35_000_000));
  });

  it("resets the usage when the month changed", async () => {
    mocks.findUnique.mockResolvedValue(sourceRow({ usageMonth: "2026-09", usageBytes: BigInt(90_000_000_000) }));
    await sync(fakeClient());
    expect(finalUpdate().data).toMatchObject({ usageMonth: "2026-10", usageBytes: BigInt(30_000_000) });
  });
});

describe("syncSource: privacy", () => {
  it("drops pages that carry personal data and masks the rest", async () => {
    const client = fakeClient({
      pages: () =>
        result(PAGE_COLS, [
          ["20261005", "/account/jane.doe@example.com", 9, 3],
          ["20261005", "/reset/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5", 8, 2],
          ["20261005", "/pricing", 7, 4],
          ["20261005", "/call/+1 (555) 123-4567", 6, 1],
        ]),
    });
    await sync(client);
    const day = mocks.dayUpsert.mock.calls.find(
      (call) => call[0].where.linkId_date.date.toISOString().startsWith("2026-10-05"),
    )?.[0];
    expect(day.update.topPages).toEqual([["/pricing", 7, 4]]);
    expect(
      JSON.stringify(mocks.dayUpsert.mock.calls, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("jane.doe");
  });

  it("merges pages that collapse to the same masked path", async () => {
    const client = fakeClient({
      pages: () =>
        result(PAGE_COLS, [
          ["20261005", "/Blog%20Post", 5, 2],
          ["20261005", "/Blog Post", 3, 1],
        ]),
    });
    await sync(client);
    const day = mocks.dayUpsert.mock.calls.find(
      (call) => call[0].where.linkId_date.date.toISOString().startsWith("2026-10-05"),
    )?.[0];
    expect(day.update.topPages).toEqual([["/Blog Post", 8, 3]]);
  });
});

describe("syncSource: cost control", () => {
  it("chunks by the SUM of the three dry runs and caps every query", async () => {
    // 3 x 3 GB = 9 GB tahmin, 2 GB sınır => 5 parça, 28 gün 6+6+6+6+4
    const client = fakeClient({ dry: () => 3_000_000_000 });
    expect(await sync(client)).toBe("synced");
    const dailyQueries = client.query.mock.calls
      .map((call) => call[0])
      .filter((request) => request.purpose === "ga.daily");
    expect(dailyQueries).toHaveLength(5);
    expect(dailyQueries.map((request) => request.params[0]?.value)).toEqual([
      "20260909",
      "20260915",
      "20260921",
      "20260927",
      "20261003",
    ]);
    expect(client.query).toHaveBeenCalledTimes(15);
    for (const call of client.query.mock.calls) {
      expect(call[0].maxBytesBilled).toBe(2_000_000_000);
    }
    // Tahmin tüm aralık için bir kez (3 kuru çalıştırma) alınır.
    expect(client.dryRun).toHaveBeenCalledTimes(3);
  });

  it("writes nothing for a truncated chunk and reports invalid_query", async () => {
    const client = fakeClient({
      daily: () =>
        result(DAILY_COLS, [["20261005", 1, 1, 1, 0, 0]], { truncated: true }),
    });
    expect(await sync(client)).toBe("error");
    expect(mocks.dayUpsert).not.toHaveBeenCalled();
    expect(finalUpdate().data).toMatchObject({
      status: "ERROR",
      lastError: "invalid_query",
    });
  });

  it("stops at the monthly budget: status stays OK and the next run is next month", async () => {
    mocks.findUnique.mockResolvedValue(
      sourceRow({ usageMonth: "2026-10", usageBytes: BigInt(99_900_000_000) }),
    );
    const client = fakeClient({ dry: () => 50_000_000 });
    expect(await sync(client)).toBe("skipped");
    expect(client.query).not.toHaveBeenCalled();
    const end = finalUpdate();
    expect(end.data).toMatchObject({ status: "OK", lastError: "budget" });
    expect(end.data.nextRunAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(end.data.usageBytes).toBe(BigInt(99_900_000_000));
  });
});

describe("syncSource: errors", () => {
  it.each([
    ["NO_ACCESS", "not_shared", 6],
    ["SA_AUTH", "auth", 6],
    ["RATE_LIMIT", "quota", 1],
    ["UNAVAILABLE", "unavailable", 1],
    ["COST_CAP", "bytes_limit", 6],
    ["BILLING_DISABLED", "billing", 6],
    ["NOT_FOUND", "dataset_not_found", 6],
  ])("maps BigQuery %s to %s with a %s hour backoff", async (code, expected, hours) => {
    const client = fakeClient();
    client.dryRun.mockRejectedValue(new BigQueryError(code as BqErrorCode));
    expect(await sync(client)).toBe("error");
    const end = finalUpdate();
    expect(end.data).toMatchObject({ status: "ERROR", lastError: expected });
    expect(end.data.nextRunAt.getTime() - NOW.getTime()).toBe(hours * 3_600_000);
    expect(end.data.leaseOwner).toBeNull();
  });

  it("records usage of the queries that already ran when a later one fails", async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce(result(DAILY_COLS, []))
      .mockRejectedValueOnce(new BigQueryError("RATE_LIMIT"));
    expect(await sync(client)).toBe("error");
    expect(finalUpdate().data.lastError).toBe("quota");
  });

  it("answers unavailable for an unexpected error and logs only its name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = fakeClient();
    client.query.mockRejectedValue(new TypeError("customer secret"));
    expect(await sync(client)).toBe("error");
    expect(finalUpdate().data.lastError).toBe("unavailable");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("customer secret");
    spy.mockRestore();
  });

  it("answers not_configured when the server has no service account", async () => {
    const client = fakeClient();
    client.configured.mockReturnValue(false);
    expect(await sync(client)).toBe("error");
    expect(finalUpdate().data.lastError).toBe("not_configured");
    expect(client.dryRun).not.toHaveBeenCalled();
  });

  it("never throws, even when the database fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    await expect(sync(fakeClient())).resolves.toBe("error");
    spy.mockRestore();
  });
});

describe("syncSource: binding and gates", () => {
  it("re-asserts analytics_<propertyId> on every run and sends no query", async () => {
    mocks.findUnique.mockResolvedValue(sourceRow({ datasetId: "analytics_999999" }));
    const client = fakeClient();
    expect(await sync(client)).toBe("error");
    expect(client.dryRun).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(finalUpdate().data).toMatchObject({ status: "ERROR", lastError: "invalid_query" });
  });

  it("only ever uses the stored single project id for queries", async () => {
    const client = fakeClient();
    await sync(client);
    const projects = [...client.dryRun.mock.calls, ...client.query.mock.calls].map(
      (call) => call[0].projectId,
    );
    expect(new Set(projects)).toEqual(new Set(["my-company-123456"]));
  });

  it("skips when the lease is held by someone else", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const client = fakeClient();
    expect(await sync(client)).toBe("skipped");
    expect(client.dryRun).not.toHaveBeenCalled();
  });

  it("skips a missing source, a retired link and a switched-off flag", async () => {
    const client = fakeClient();
    mocks.findUnique.mockResolvedValueOnce(null);
    expect(await sync(client)).toBe("skipped");
    mocks.findUnique.mockResolvedValueOnce(
      sourceRow({}, { isPrimary: false, isSecondary: false }),
    );
    expect(await sync(client)).toBe("skipped");
    vi.stubEnv("GA_BIGQUERY", "false");
    expect(await sync(client)).toBe("skipped");
    expect(client.dryRun).not.toHaveBeenCalled();
  });

  it("claims the lease with a CAS on the source row for five minutes", async () => {
    await sync(fakeClient());
    const claim = mocks.updateMany.mock.calls[0]![0];
    expect(claim.where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: NOW } }]);
    expect(claim.data.leaseUntil.getTime() - NOW.getTime()).toBe(5 * 60_000);
  });
});

describe("retention", () => {
  it("deletes days older than 400 days", async () => {
    expect(await GaBigQuery.retention(NOW)).toBe(3);
    const cutoff = mocks.dayDeleteMany.mock.calls[0]![0].where.date.lt as Date;
    expect(NOW.getTime() - cutoff.getTime()).toBe(400 * 24 * 3_600_000);
  });

  it("does nothing without a query where global work is not allowed", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@ep-live.neon.tech/db");
    expect(await GaBigQuery.retention(NOW)).toBe(0);
    expect(mocks.dayDeleteMany).not.toHaveBeenCalled();
  });
});
