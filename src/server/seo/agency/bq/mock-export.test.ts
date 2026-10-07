import { afterEach, describe, expect, it } from "vitest";

import {
  coverageLogSql,
  coverageTableSql,
  periodSql,
  reconcileDaysSql,
  siteMatchSql,
  type BqSql,
} from "@/lib/seo/agency/bq/sql";
import { addDays, gscToday } from "@/lib/seo/dates";
import {
  bigQueryClient,
  createMockBackend,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";
import { mockSearchAnalytics } from "@/server/integrations/search-console/mock";

import {
  resetMockExport,
  setMockExportDryRunBytes,
  setMockExportSiteUrl,
  setMockExportSize,
} from "./mock-export";

// Bu dosyanın kanıtladığı: sahte dışa aktarım belirlenimcidir, boyutu
// ayarlanabilir, kapsam penceresi bugün−120 … bugün−3'tür, yalnız bağın kendi
// site_url'ünü döndürür ve mutabakat günleri API mock'unun toplamlarının %1'i
// içindedir.

const client = bigQueryClient({
  backend: createMockBackend(),
  tokenProvider: { email: null, configured: true, getToken: async () => "t" },
});
const target = { projectId: "my-cloud-proj", dataset: "searchconsole" };
const SITE = "sc-domain:example.com";

function query(built: BqSql, maxRows = 200_000): Promise<BqQueryResult> {
  return client.query({
    purpose: built.purpose,
    projectId: target.projectId,
    location: "US",
    sql: built.sql,
    params: built.params,
    maxBytesBilled: 1024 ** 3,
    maxRows,
  });
}

afterEach(() => resetMockExport());

describe("period rows", () => {
  const week = (key: "query" | "page" | "query_page", cap = 100_000) =>
    periodSql(target, key, SITE, "2026-09-07", "2026-09-13", cap);

  it("is deterministic for the same request", async () => {
    const a = await query(week("query"));
    const b = await query(week("query"));
    expect(a.rows).toEqual(b.rows);
    const other = await query(
      periodSql(target, "query", SITE, "2026-09-14", "2026-09-20", 100_000),
    );
    expect(other.rows).not.toEqual(a.rows);
  });

  it("returns 120 queries, 80 pages and 150 pairs by default", async () => {
    expect((await query(week("query"))).rows).toHaveLength(120);
    expect((await query(week("page"))).rows).toHaveLength(80);
    expect((await query(week("query_page"))).rows).toHaveLength(150);
  });

  it("honours the size override and the cap + 1 limit", async () => {
    setMockExportSize({ query: 62_000 });
    expect((await query(week("query"))).rows).toHaveLength(62_000);
    setMockExportSize({ query: 500 });
    const limited = await query(week("query", 99));
    expect(limited.rows).toHaveLength(100);
  });

  it("shapes rows as [keys..., clicks, impressions, position sum]", async () => {
    const queryRow = (await query(week("query"))).rows[0]!;
    expect(queryRow).toHaveLength(4);
    expect(String(queryRow[0])).toMatch(/^mock query /);
    const pairRow = (await query(week("query_page"))).rows[0]!;
    expect(pairRow).toHaveLength(5);
    expect(String(pairRow[1])).toBe(String(pairRow[1]).trim());
    expect(String(pairRow[1])).toMatch(/^https:\/\/example\.com\/p\//);
  });

  it("sorts by clicks then impressions", async () => {
    const rows = (await query(week("query"))).rows;
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(Number(a[1])).toBeGreaterThanOrEqual(Number(b[1]));
    }
  });
});

describe("coverage and site match", () => {
  it("covers today(PT)-120 … today-3 in both tables", async () => {
    const today = gscToday(new Date());
    const log = await query(coverageLogSql(target));
    expect(log.rows).toHaveLength(2);
    for (const row of log.rows) {
      expect(row[1]).toBe(addDays(today, -120));
      expect(row[2]).toBe(addDays(today, -3));
    }
    const probe = await query(coverageTableSql(target, "site", "2025-01-01", SITE));
    expect(probe.rows[0]![0]).toBe(addDays(today, -120));
  });

  it("returns only the requested property", async () => {
    const result = await query(siteMatchSql(target, "2026-09-01", SITE));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]![0]).toBe(SITE);
  });

  it("shows nothing when the dataset only holds a foreign property", async () => {
    setMockExportSiteUrl("sc-domain:other.com");
    expect((await query(siteMatchSql(target, "2026-09-01", SITE))).rows).toEqual([]);
    expect(
      (await query(periodSql(target, "query", SITE, "2026-09-07", "2026-09-13", 10))).rows,
    ).toEqual([]);
    const probe = await query(coverageTableSql(target, "url", "2025-01-01", SITE));
    expect(probe.rows[0]).toEqual([null, null, 0]);
    // Kendi mülkü hâlâ görünür.
    setMockExportSiteUrl("SC-DOMAIN:example.com/");
    expect((await query(siteMatchSql(target, "2026-09-01", SITE))).rows).toHaveLength(1);
  });
});

describe("reconcile days", () => {
  it("stays within 1% of the mock API totals", async () => {
    const today = gscToday(new Date());
    const from = addDays(today, -20);
    const to = addDays(today, -6);
    const exportRows = (await query(reconcileDaysSql(target, SITE, from, to))).rows;
    expect(exportRows.length).toBeGreaterThan(10);
    const api = mockSearchAnalytics(SITE, {
      startDate: from,
      endDate: to,
      dimensions: ["date"],
      type: "web",
      aggregationType: "byProperty",
      dataState: "final",
      rowLimit: 25_000,
      startRow: 0,
    }) as { rows: { clicks: number; impressions: number }[] };
    const apiClicks = api.rows.reduce((sum, row) => sum + row.clicks, 0);
    const bqClicks = exportRows.reduce((sum, row) => sum + Number(row[1]), 0);
    expect(Math.abs(bqClicks - apiClicks) / apiClicks).toBeLessThan(0.01);
  });
});

describe("dry run", () => {
  it("defaults to 50 MB and can be overridden", async () => {
    const built = periodSql(target, "page", SITE, "2026-09-07", "2026-09-13", 10);
    const request = {
      purpose: built.purpose,
      projectId: target.projectId,
      location: null,
      sql: built.sql,
      params: built.params,
      maxBytesBilled: 1024 ** 3,
      maxRows: 11,
    };
    expect((await client.dryRun(request)).bytesProcessed).toBe(50_000_000);
    setMockExportDryRunBytes(20_000_000_000);
    expect((await client.dryRun(request)).bytesProcessed).toBe(20_000_000_000);
    setMockExportDryRunBytes(null);
    expect((await client.dryRun(request)).bytesProcessed).toBe(50_000_000);
  });
});
