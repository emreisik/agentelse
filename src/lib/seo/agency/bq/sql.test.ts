import { describe, expect, it } from "vitest";

import { assertReadOnlySql } from "@/server/integrations/google/bigquery/identifiers";

import {
  coverageLogSql,
  coverageTableSql,
  periodSql,
  reconcileDaysSql,
  siteMatchSql,
  type BqSql,
  type BqTarget,
} from "./sql";

// Bu dosyanın kanıtladığı: her kurucu salt okunur SQL üretir, ilk satır amaç
// yorumudur, tanımlayıcılar ters tırnaklıdır, müşteri değerleri yalnız
// adlandırılmış parametredir, dışa aktarım tablolarında bölüm süzgeci ve tek
// mülk kısıtı vardır, SELECT * yoktur, geçersiz kimlik SQL oluşmadan fırlatır.

const target: BqTarget = { projectId: "my-cloud-proj", dataset: "searchconsole" };
const SITE = "https://www.Example.com/";

const builders: { name: string; build: () => BqSql; export: boolean }[] = [
  { name: "coverageLog", build: () => coverageLogSql(target), export: false },
  {
    name: "coverageTable site",
    build: () => coverageTableSql(target, "site", "2026-01-01", SITE),
    export: true,
  },
  {
    name: "coverageTable url",
    build: () => coverageTableSql(target, "url", "2026-01-01", SITE),
    export: true,
  },
  {
    name: "siteMatch",
    build: () => siteMatchSql(target, "2026-09-01", "https://www.example.com"),
    export: true,
  },
  {
    name: "reconcileDays",
    build: () => reconcileDaysSql(target, SITE, "2026-09-01", "2026-09-14"),
    export: true,
  },
  {
    name: "period query",
    build: () => periodSql(target, "query", SITE, "2026-09-07", "2026-09-13", 100),
    export: true,
  },
  {
    name: "period page",
    build: () => periodSql(target, "page", SITE, "2026-09-07", "2026-09-13", 100),
    export: true,
  },
  {
    name: "period pair",
    build: () =>
      periodSql(target, "query_page", SITE, "2026-09-07", "2026-09-13", 100),
    export: true,
  },
];

describe.each(builders)("$name", ({ build, export: exportTable }) => {
  const built = build();

  it("starts with the purpose comment and is read-only", () => {
    expect(built.sql.startsWith(`-- agentelse:${built.purpose}\n`)).toBe(true);
    expect(() => assertReadOnlySql(built.sql)).not.toThrow();
    expect(built.sql).not.toMatch(/SELECT\s+\*/i);
    expect(built.sql).not.toContain(";");
  });

  it("quotes identifiers and never interpolates customer values", () => {
    expect(built.sql).toMatch(/`my-cloud-proj\.searchconsole\.[A-Za-z_]+`/);
    for (const param of built.params) {
      if (typeof param.value === "string") {
        expect(built.sql).not.toContain(param.value);
      }
      expect(built.sql).toContain(`@${param.name}`);
    }
    expect(built.sql).not.toContain("example.com");
    expect(built.sql).not.toContain("Example.com");
  });

  it("filters the date partition and restricts to one property", () => {
    if (!exportTable) return;
    expect(built.sql).toMatch(/data_date (>= @since|BETWEEN @from AND @to)/);
    expect(built.sql).toMatch(
      /site_url = @site_url|LOWER\(RTRIM\(site_url, '\/'\)\) = @site/,
    );
  });
});

describe("siteMatchSql", () => {
  it("normalizes the site parameter and never lists other sites", () => {
    const built = siteMatchSql(target, "2026-09-01", "HTTPS://WWW.Example.com//");
    expect(built.params).toContainEqual({
      name: "site",
      type: "STRING",
      value: "https://www.example.com",
    });
    expect(built.sql).toContain("LOWER(RTRIM(site_url, '/')) = @site");
    // Eşleşme süzgeci olmadan site listeleyen biçim yok.
    expect(built.sql).toMatch(/WHERE[^]*= @site/);
    expect(built.sql).not.toMatch(/LIMIT/);
  });
});

describe("periodSql", () => {
  it("asks for cap + 1 rows through a named parameter", () => {
    for (const key of ["query", "page", "query_page"] as const) {
      const built = periodSql(target, key, SITE, "2026-09-07", "2026-09-13", 1000);
      expect(built.sql).toContain("LIMIT @limit");
      expect(built.params).toContainEqual({
        name: "limit",
        type: "INT64",
        value: 1001,
      });
      expect(built.params).toContainEqual({
        name: "site_url",
        type: "STRING",
        value: SITE,
      });
    }
  });

  it("excludes anonymized queries for query keys and keeps them for the page key", () => {
    const query = periodSql(target, "query", SITE, "2026-09-07", "2026-09-13", 10);
    const pair = periodSql(target, "query_page", SITE, "2026-09-07", "2026-09-13", 10);
    const page = periodSql(target, "page", SITE, "2026-09-07", "2026-09-13", 10);
    expect(query.sql).toContain("is_anonymized_query = FALSE");
    expect(pair.sql).toContain("is_anonymized_query = FALSE");
    expect(page.sql).not.toContain("is_anonymized_query");
  });

  it("reads the right table, position column and purpose per key", () => {
    const query = periodSql(target, "query", SITE, "2026-09-07", "2026-09-13", 10);
    const page = periodSql(target, "page", SITE, "2026-09-07", "2026-09-13", 10);
    const pair = periodSql(target, "query_page", SITE, "2026-09-07", "2026-09-13", 10);
    expect(query.purpose).toBe("gsc.period.query");
    expect(query.sql).toContain("searchdata_site_impression");
    expect(query.sql).toContain("sum_top_position");
    expect(page.purpose).toBe("gsc.period.page");
    expect(page.sql).toContain("searchdata_url_impression");
    expect(page.sql).toContain("sum_position");
    expect(pair.purpose).toBe("gsc.period.pair");
    expect(pair.sql).toContain("GROUP BY query, url");
  });

  it("orders deterministically so the cap keeps the top rows", () => {
    const query = periodSql(target, "query", SITE, "2026-09-07", "2026-09-13", 10);
    expect(query.sql).toContain(
      "ORDER BY n_clicks DESC, n_impressions DESC, query ASC",
    );
  });
});

describe("identifier injection", () => {
  it("throws before any SQL exists", () => {
    const bad: BqTarget[] = [
      { projectId: "my-cloud-proj`; DROP TABLE x; --", dataset: "searchconsole" },
      { projectId: "my-cloud-proj", dataset: "searchconsole`.evil" },
      { projectId: "my-cloud-proj", dataset: "a b" },
      { projectId: "UPPER", dataset: "searchconsole" },
    ];
    for (const entry of bad) {
      expect(() => coverageLogSql(entry)).toThrow();
      expect(() =>
        periodSql(entry, "query", SITE, "2026-09-07", "2026-09-13", 10),
      ).toThrow();
      expect(() => siteMatchSql(entry, "2026-09-01", "x")).toThrow();
    }
  });

  it("keeps hostile site values inside parameters", () => {
    const hostile = "x' OR 1=1 --";
    const built = reconcileDaysSql(target, hostile, "2026-09-01", "2026-09-14");
    expect(built.sql).not.toContain("OR 1=1");
    expect(built.params).toContainEqual({
      name: "site_url",
      type: "STRING",
      value: hostile,
    });
  });
});
