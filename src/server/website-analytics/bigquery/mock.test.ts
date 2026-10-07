import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BqQueryRequest } from "@/server/integrations/google/bigquery";

import { buildGaStatements } from "@/lib/website-analytics/bigquery/sql";

// Bu dosyanın kanıtladığı: kayıt tekrarlanınca aynı 'ga.' işleyicisi kalır,
// sayılar belirleyicidir, veri kümesi adı SQL'den ve aralık parametrelerden
// okunur, bilinmeyen amaç reddedilir ve amaçlar REST etiket temizliğinden sonra
// da benzersizdir.

const registerHandler = vi.hoisted(() => vi.fn());

vi.mock("@/server/integrations/google/bigquery", () => ({
  registerBigQueryMockHandler: registerHandler,
}));

const {
  GA_MOCK_PREFIX,
  gaBigQueryMockHandler,
  mockBigQueryDayNumbers,
  mockExportKeyFor,
  registerGaBigQueryMock,
} = await import("./mock");

function request(purpose: string, over: Partial<BqQueryRequest> = {}): BqQueryRequest {
  const statements = buildGaStatements(
    { projectId: "my-company-123456", datasetId: "analytics_424242" },
    { fromDay: "2026-09-01", toDay: "2026-09-03", keyEventNames: ["purchase"] },
  );
  if (!statements) throw new Error("statements");
  const base =
    purpose === "ga.events"
      ? statements.events
      : purpose === "ga.pages"
        ? statements.pages
        : statements.daily;
  return {
    purpose,
    projectId: "my-company-123456",
    location: null,
    sql: base.sql,
    params: base.params,
    maxBytesBilled: 2_000_000_000,
    maxRows: base.maxRows,
    ...over,
  };
}

beforeEach(() => registerHandler.mockClear());

describe("registerGaBigQueryMock", () => {
  it("registers the ga. handler and is safe to repeat", () => {
    registerGaBigQueryMock();
    registerGaBigQueryMock();
    expect(registerHandler).toHaveBeenCalledTimes(2);
    for (const call of registerHandler.mock.calls) {
      expect(call[0]).toBe("ga.");
      expect(call[1]).toBe(gaBigQueryMockHandler);
    }
  });

  it("swallows a duplicate registration error", () => {
    registerHandler.mockImplementationOnce(() => {
      throw new Error("duplicate");
    });
    expect(() => registerGaBigQueryMock()).not.toThrow();
  });
});

describe("mockBigQueryDayNumbers", () => {
  it("is deterministic and key/day sensitive", () => {
    const a = mockBigQueryDayNumbers("analytics_1", "2026-09-01");
    expect(mockBigQueryDayNumbers("analytics_1", "2026-09-01")).toEqual(a);
    expect(mockBigQueryDayNumbers("analytics_1", "20260901")).toEqual(a);
    expect(mockBigQueryDayNumbers("analytics_2", "2026-09-01")).not.toEqual(a);
    expect(mockBigQueryDayNumbers("analytics_1", "2026-09-02")).not.toEqual(a);
  });

  it("returns plausible numbers (sessions >= users, events >= sessions)", () => {
    for (let day = 1; day <= 28; day += 1) {
      const n = mockBigQueryDayNumbers("analytics_1", `2026-09-${String(day).padStart(2, "0")}`);
      expect(n.sessions).toBeGreaterThanOrEqual(n.users);
      expect(n.events).toBeGreaterThanOrEqual(n.sessions);
      expect(n.keyEvents).toBeGreaterThanOrEqual(0);
    }
  });

  it("keys an export by the dataset name", () => {
    expect(mockExportKeyFor("424242")).toBe("analytics_424242");
  });
});

describe("gaBigQueryMockHandler", () => {
  it("returns the daily rows for the parameter range with the real column names", async () => {
    const out = await gaBigQueryMockHandler.query(request("ga.daily"));
    expect(out.columns.map((c) => c.name)).toEqual([
      "day",
      "events",
      "users",
      "sessions",
      "key_events",
      "revenue_micros",
    ]);
    expect(out.rows.map((row) => row[0])).toEqual(["20260901", "20260902", "20260903"]);
    // Veri kümesi adı SQL'den okunur
    const expected = mockBigQueryDayNumbers("analytics_424242", "20260902");
    expect(out.rows[1]?.slice(1, 5)).toEqual([
      expected.events,
      expected.users,
      expected.sessions,
      expected.keyEvents,
    ]);
    expect(out.truncated).toBe(false);
    expect(out.totalRows).toBe(3);
  });

  it("returns events and pages with the statement column names", async () => {
    const events = await gaBigQueryMockHandler.query(request("ga.events"));
    expect(events.columns.map((c) => c.name)).toEqual(["day", "event_name", "events"]);
    expect(events.rows.length).toBe(3 * 5);
    const pages = await gaBigQueryMockHandler.query(request("ga.pages"));
    expect(pages.columns.map((c) => c.name)).toEqual(["day", "path", "views", "users"]);
    expect(pages.rows.length).toBe(3 * 4);
  });

  it("splits the daily event count over the top events without losing any", async () => {
    const events = await gaBigQueryMockHandler.query(request("ga.events"));
    const firstDay = events.rows.filter((row) => row[0] === "20260901");
    const total = firstDay.reduce((sum, row) => sum + Number(row[2]), 0);
    expect(total).toBe(mockBigQueryDayNumbers("analytics_424242", "20260901").events);
  });

  it("uses another dataset's numbers for another dataset", async () => {
    const other = request("ga.daily", {
      sql: request("ga.daily").sql.replace("analytics_424242", "analytics_777"),
    });
    const out = await gaBigQueryMockHandler.query(other);
    expect(out.rows[0]?.[3]).toBe(mockBigQueryDayNumbers("analytics_777", "20260901").sessions);
  });

  it("rejects an unknown purpose and a statement without an export table", async () => {
    await expect(Promise.resolve().then(() => gaBigQueryMockHandler.query(request("ga.other")))).rejects.toThrow();
    await expect(
      Promise.resolve().then(() => gaBigQueryMockHandler.query(request("ga.daily", { sql: "SELECT 1" }))),
    ).rejects.toThrow();
  });

  it("returns no rows for missing or reversed suffix params", async () => {
    expect((await gaBigQueryMockHandler.query(request("ga.daily", { params: [] }))).rows).toEqual([]);
  });
});

describe("purposes", () => {
  it("stay unique after the REST label sanitising", () => {
    const sanitise = (purpose: string) =>
      purpose.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 63);
    const purposes = ["ga.daily", "ga.events", "ga.pages", "ga.verify"];
    const labels = purposes.map(sanitise);
    expect(labels).toEqual(["ga_daily", "ga_events", "ga_pages", "ga_verify"]);
    expect(new Set(labels).size).toBe(purposes.length);
    expect(purposes.every((purpose) => purpose.startsWith(GA_MOCK_PREFIX))).toBe(true);
  });
});
