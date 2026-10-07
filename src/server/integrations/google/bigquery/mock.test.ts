import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bigQueryMockMode,
  createMockBackend,
  registerBigQueryMockHandler,
  resetBigQueryMock,
} from "./mock";
import type { BqQueryRequest, BqQueryResult } from "./types";

// Bu dosyanın kanıtladığı: sahte arka uç ağsızdır, handler en uzun önekle
// seçilir, veri kümesi adına göre NOT_FOUND / NO_ACCESS döner ve sıfırlama
// kayıtları temizler.

function request(purpose: string, maxRows = 100): BqQueryRequest {
  return {
    purpose,
    projectId: "my-project-1",
    location: null,
    sql: "SELECT 1",
    params: [],
    maxBytesBilled: 1_000_000,
    maxRows,
  };
}

function result(tag: string, rows = 1): BqQueryResult {
  return {
    columns: [{ name: "tag", type: "STRING" }],
    rows: Array.from({ length: rows }, () => [tag]),
    totalRows: rows,
    truncated: false,
    bytesProcessed: 10,
    bytesBilled: 10,
    cacheHit: false,
  };
}

beforeEach(() => resetBigQueryMock());
afterEach(() => resetBigQueryMock());

describe("mock handler routing", () => {
  it("routes by the longest registered prefix", async () => {
    registerBigQueryMockHandler("gsc.", { query: () => result("short") });
    registerBigQueryMockHandler("gsc.period.", { query: () => result("long") });
    registerBigQueryMockHandler("ga.", { query: () => result("ga") });
    const backend = createMockBackend();
    expect((await backend.query(request("gsc.period.query"), "t")).rows[0]).toEqual(["long"]);
    expect((await backend.query(request("gsc.sites"), "t")).rows[0]).toEqual(["short"]);
    expect((await backend.query(request("ga.daily"), "t")).rows[0]).toEqual(["ga"]);
  });

  it("replaces a handler registered twice for the same prefix", async () => {
    registerBigQueryMockHandler("ga.", { query: () => result("old") });
    registerBigQueryMockHandler("ga.", { query: () => result("new") });
    const out = await createMockBackend().query(request("ga.x"), "t");
    expect(out.rows[0]).toEqual(["new"]);
  });

  it("is deterministic for the same request", async () => {
    registerBigQueryMockHandler("gsc.", { query: (r) => result(r.sql) });
    const backend = createMockBackend();
    const a = await backend.query(request("gsc.a"), "t");
    const b = await backend.query(request("gsc.a"), "t");
    expect(a).toEqual(b);
  });

  it("refuses a purpose nobody registered, and everything after a reset", async () => {
    const backend = createMockBackend();
    await expect(backend.query(request("gsc.a"), "t")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    registerBigQueryMockHandler("gsc.", { query: () => result("x") });
    await expect(backend.query(request("ga.a"), "t")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    resetBigQueryMock();
    await expect(backend.query(request("gsc.a"), "t")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("cuts rows above maxRows and marks the result truncated", async () => {
    registerBigQueryMockHandler("gsc.", { query: () => result("r", 5) });
    const out = await createMockBackend().query(request("gsc.a", 3), "t");
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });
});

describe("mock dry run, datasets and tables", () => {
  it("dry-runs 50 MB unless the handler answers", async () => {
    const backend = createMockBackend();
    expect(await backend.dryRun(request("gsc.a"), "t")).toEqual({
      bytesProcessed: 50_000_000,
    });
    registerBigQueryMockHandler("gsc.", {
      query: () => result("x"),
      dryRun: () => ({ bytesProcessed: 7 }),
    });
    expect(await backend.dryRun(request("gsc.a"), "t")).toEqual({
      bytesProcessed: 7,
    });
  });

  it("answers datasets by name", async () => {
    const backend = createMockBackend();
    const base = { projectId: "my-project-1" };
    expect(await backend.getDataset({ ...base, dataset: "searchconsole" }, "t")).toEqual({
      location: "US",
    });
    await expect(
      backend.getDataset({ ...base, dataset: "missing_one" }, "t"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      backend.getDataset({ ...base, dataset: "denied_one" }, "t"),
    ).rejects.toMatchObject({ code: "NO_ACCESS" });
  });

  it("answers tables, with missing table or dataset as NOT_FOUND", async () => {
    const backend = createMockBackend();
    const ok = await backend.getTable(
      { projectId: "my-project-1", dataset: "searchconsole", table: "t1" },
      "t",
    );
    expect(ok.partitionField).toBe("data_date");
    expect(ok.numRows).toBe(1_000_000);
    await expect(
      backend.getTable(
        { projectId: "my-project-1", dataset: "searchconsole", table: "missing_t" },
        "t",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      backend.getTable(
        { projectId: "my-project-1", dataset: "missing_d", table: "t1" },
        "t",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("bigQueryMockMode", () => {
  it("follows AGENTELSE_PROVIDER_MODE", () => {
    const saved = process.env.AGENTELSE_PROVIDER_MODE;
    process.env.AGENTELSE_PROVIDER_MODE = "mock";
    expect(bigQueryMockMode()).toBe(true);
    process.env.AGENTELSE_PROVIDER_MODE = "live";
    expect(bigQueryMockMode()).toBe(false);
    if (saved === undefined) delete process.env.AGENTELSE_PROVIDER_MODE;
    else process.env.AGENTELSE_PROVIDER_MODE = saved;
  });
});
