import type { GscBqSource, GscSiteLink } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BqUsage } from "@/lib/seo/agency/bq/cost";
import type {
  BigQueryClient,
  BqCell,
  BqQueryRequest,
  BqQueryResult,
} from "@/server/integrations/google/bigquery";

import { BigQueryError } from "@/server/integrations/google/bigquery";

import { bqRequestId, readBqPeriod } from "./reader";

// Bu dosyanın kanıtladığı: içe aktarma sorgusundan önce kuru çalıştırma yapılır,
// tahmin tavanı aşarsa sorgu hiç gitmez, maxRows = cap + 1 olur, fazla satır
// kırpılma işaretidir, sorgu zaman aşımı turda kalan süreyi izler ve sonuç
// GscPagedResult biçimindedir.

const GIB = 1024 ** 3;
const calls: string[] = [];
let dryBytes = 50_000_000;
let queryRows: BqCell[][] = [];
let lastQuery: BqQueryRequest | null = null;
let queryError: Error | null = null;

function result(rows: BqCell[][], extra: Partial<BqQueryResult> = {}): BqQueryResult {
  return {
    columns: [],
    rows,
    totalRows: rows.length,
    truncated: false,
    bytesProcessed: 40_000_000,
    bytesBilled: 41_000_000,
    cacheHit: false,
    ...extra,
  };
}

const client: BigQueryClient = {
  configured: () => true,
  serviceAccountEmail: () => "sa@example.com",
  async dryRun() {
    calls.push("dryRun");
    return { bytesProcessed: dryBytes };
  },
  async query(request) {
    calls.push("query");
    lastQuery = request;
    if (queryError) throw queryError;
    return result(queryRows);
  },
  getTable: async () => {
    throw new Error("unused");
  },
  getDataset: async () => {
    throw new Error("unused");
  },
};

const source = {
  id: "src-1",
  bqProjectId: "my-cloud-proj",
  dataset: "searchconsole",
  location: "US",
  bqSiteUrl: "sc-domain:example.com",
  maxBytesPerQuery: BigInt(10 * GIB),
  monthlyBudgetBytes: BigInt(300 * GIB),
} as unknown as GscBqSource;
const link = { id: "link-1", siteUrl: "sc-domain:example.com" } as GscSiteLink;
const usage: BqUsage = { usageMonth: "2026-10", bytesBilledMonth: 0, queriesMonth: 0 };

function read(
  task: { grain: "WEEK" | "MONTH"; periodStart: string; key: "query" | "page" | "query_page" },
  overrides: {
    deadlineAt?: number;
    usage?: BqUsage;
    onUnfinished?: (bytes: number) => Promise<void> | void;
  } = {},
) {
  return readBqPeriod({
    client,
    source,
    link,
    task: { ...task, reason: "MISSING" },
    usage: overrides.usage ?? usage,
    hardMax: 100 * GIB,
    hardMonthly: 2048 * GIB,
    deadlineAt: overrides.deadlineAt ?? Date.now() + 60_000,
    onUnfinished: overrides.onUnfinished,
  });
}

beforeEach(() => {
  calls.length = 0;
  dryBytes = 50_000_000;
  queryRows = [];
  lastQuery = null;
  queryError = null;
  vi.stubEnv("GSC_BQ_ROW_CAP", "1000");
});
afterEach(() => vi.unstubAllEnvs());

const week = { grain: "WEEK", periodStart: "2026-09-07", key: "query" } as const;

describe("readBqPeriod", () => {
  it("runs the dry run before the query", async () => {
    const out = await read(week);
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["dryRun", "query"]);
  });

  it("returns OVER_QUERY_CAP without a query when the estimate exceeds the cap", async () => {
    dryBytes = 20 * GIB;
    expect(await read(week)).toEqual({ ok: false, reason: "OVER_QUERY_CAP" });
    expect(calls).toEqual(["dryRun"]);
  });

  it("returns OVER_MONTHLY_BUDGET when the month is nearly used", async () => {
    dryBytes = 2 * GIB;
    const out = await read(week, {
      usage: { usageMonth: "2026-10", bytesBilledMonth: 299 * GIB, queriesMonth: 9 },
    });
    expect(out).toEqual({ ok: false, reason: "OVER_MONTHLY_BUDGET" });
    expect(calls).toEqual(["dryRun"]);
  });

  it("asks for cap + 1 rows and a bounded job", async () => {
    await read(week);
    expect(lastQuery?.maxRows).toBe(1001);
    expect(lastQuery?.params).toContainEqual({ name: "limit", type: "INT64", value: 1001 });
    expect(lastQuery?.maxBytesBilled).toBeGreaterThan(0);
    expect(lastQuery?.maxBytesBilled).toBeLessThanOrEqual(10 * GIB + 10 * 1024 * 1024);
    expect(lastQuery?.projectId).toBe("my-cloud-proj");
    expect(lastQuery?.location).toBe("US");
  });

  it("uses the week range for weeks and the month range for months", async () => {
    await read(week);
    expect(lastQuery?.params).toContainEqual({ name: "from", type: "DATE", value: "2026-09-07" });
    expect(lastQuery?.params).toContainEqual({ name: "to", type: "DATE", value: "2026-09-13" });
    await read({ grain: "MONTH", periodStart: "2026-09-01", key: "page" });
    expect(lastQuery?.params).toContainEqual({ name: "to", type: "DATE", value: "2026-09-30" });
  });

  it("marks the period truncated when more than the cap came back and drops the extra row", async () => {
    queryRows = Array.from({ length: 1001 }, (_, i) => [`q${i}`, 1, 2, 0]);
    const out = await read(week);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.truncated).toBe(true);
      expect(out.result.rows).toHaveLength(1000);
    }
  });

  it("is complete when exactly the cap came back", async () => {
    queryRows = Array.from({ length: 1000 }, (_, i) => [`q${i}`, 1, 2, 0]);
    const out = await read(week);
    if (out.ok) expect(out.result.truncated).toBe(false);
  });

  it("follows the remaining tick budget for the timeout", async () => {
    await read(week, { deadlineAt: Date.now() + 30_000 });
    expect(lastQuery?.timeoutMs).toBeGreaterThan(25_000);
    expect(lastQuery?.timeoutMs).toBeLessThanOrEqual(30_000);
    await read(week, { deadlineAt: Date.now() + 500 });
    expect(lastQuery?.timeoutMs).toBe(5_000);
    await read(week, { deadlineAt: Date.now() + 600_000 });
    expect(lastQuery?.timeoutMs).toBe(90_000);
  });

  it("returns a GscPagedResult with billed bytes", async () => {
    queryRows = [["https://example.com/a", 3, 30, 0]];
    const out = await read({ grain: "WEEK", periodStart: "2026-09-07", key: "page" });
    expect(out).toMatchObject({
      ok: true,
      billedBytes: 41_000_000,
      result: {
        pages: 1,
        truncated: false,
        firstIncompleteDate: null,
        responseAggregationType: "byPage",
      },
    });
    if (out.ok) {
      expect(out.result.rows[0]).toMatchObject({ keys: ["https://example.com/a"], clicks: 3 });
    }
    const queryOut = await read(week);
    if (queryOut.ok) expect(queryOut.result.responseAggregationType).toBe("auto");
  });
});

describe("idempotency and unfinished queries", () => {
  it("sends the same UUID-shaped requestId for the same period and a different one otherwise", async () => {
    await read(week);
    const first = lastQuery?.requestId;
    await read(week);
    expect(lastQuery?.requestId).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    await read({ ...week, periodStart: "2026-09-14" });
    expect(lastQuery?.requestId).not.toBe(first);
    expect(
      bqRequestId({ sourceId: "a", grain: "WEEK", periodStart: "2026-09-07", key: "query", usageMonth: "2026-10" }),
    ).not.toBe(
      bqRequestId({ sourceId: "b", grain: "WEEK", periodStart: "2026-09-07", key: "query", usageMonth: "2026-10" }),
    );
  });

  it("reports the estimate as spent when a submitted query times out, then rethrows", async () => {
    queryError = new BigQueryError("TIMEOUT");
    const spent: number[] = [];
    await expect(read(week, { onUnfinished: (bytes) => void spent.push(bytes) })).rejects.toBe(queryError);
    expect(spent).toEqual([50_000_000]);
  });

  it("does not report spend for errors that mean the job never ran", async () => {
    queryError = new BigQueryError("NO_ACCESS");
    const spent: number[] = [];
    await expect(read(week, { onUnfinished: (bytes) => void spent.push(bytes) })).rejects.toBe(queryError);
    expect(spent).toEqual([]);
  });
});
