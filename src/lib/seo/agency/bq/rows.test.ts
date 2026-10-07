import { describe, expect, it } from "vitest";

import type {
  BqCell,
  BqQueryResult,
} from "@/server/integrations/google/bigquery/types";

import {
  coverageFromResults,
  dayRowsFromResult,
  matchSiteUrl,
  normalizeSiteUrl,
  periodRowsFromResult,
  positionFromSum,
} from "./rows";

function result(rows: BqCell[][], truncated = false): BqQueryResult {
  return {
    columns: [],
    rows,
    totalRows: rows.length,
    truncated,
    bytesProcessed: 0,
    bytesBilled: null,
    cacheHit: false,
  };
}

describe("positionFromSum", () => {
  it("converts zero-based sums to an average position", () => {
    expect(positionFromSum(0, 10)).toBe(1);
    expect(positionFromSum(20, 10)).toBe(3);
    expect(positionFromSum(5, 0)).toBe(0);
  });
});

describe("periodRowsFromResult", () => {
  it("maps query rows with keys [query]", () => {
    const { rows, truncated } = periodRowsFromResult(
      "query",
      result([["running shoes", 10, 200, 1800]]),
      100,
    );
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        keys: ["running shoes"],
        clicks: 10,
        impressions: 200,
        ctr: 0.05,
        position: 10,
      },
    ]);
  });

  it("maps page rows with keys [url]", () => {
    const { rows } = periodRowsFromResult(
      "page",
      result([["https://example.com/a", 3, 30, 0]]),
      100,
    );
    expect(rows[0]).toMatchObject({ keys: ["https://example.com/a"], position: 1 });
  });

  it("maps pair rows with keys [query, url]", () => {
    const { rows } = periodRowsFromResult(
      "query_page",
      result([["shoes", "https://example.com/a", 1, 4, 4]]),
      100,
    );
    expect(rows[0]).toMatchObject({
      keys: ["shoes", "https://example.com/a"],
      clicks: 1,
      impressions: 4,
      position: 2,
    });
  });

  it("skips null keys and zero impressions", () => {
    const { rows } = periodRowsFromResult(
      "query_page",
      result([
        [null, "https://example.com/a", 1, 4, 0],
        ["shoes", null, 1, 4, 0],
        ["shoes", "https://example.com/a", 0, 0, 0],
        ["ok", "https://example.com/b", 0, 2, 0],
      ]),
      100,
    );
    expect(rows.map((row) => row.keys[0])).toEqual(["ok"]);
  });

  const make = (count: number) =>
    result(Array.from({ length: count }, (_, i) => [`q${i}`, 1, 2, 0]));

  it("is not truncated below the cap", () => {
    const out = periodRowsFromResult("query", make(9), 10);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(9);
  });

  it("is not truncated at exactly the cap", () => {
    const out = periodRowsFromResult("query", make(10), 10);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(10);
  });

  it("is truncated with cap + 1 rows and drops the extra row", () => {
    const out = periodRowsFromResult("query", make(11), 10);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(10);
    expect(out.rows.at(-1)?.keys[0]).toBe("q9");
  });

  it("trusts the client truncated flag too", () => {
    expect(periodRowsFromResult("query", result([], true), 10).truncated).toBe(
      true,
    );
  });
});

describe("dayRowsFromResult", () => {
  it("reads [day, clicks, impressions]", () => {
    expect(
      dayRowsFromResult(
        result([
          ["2026-09-01", 5, 50],
          ["bad", 1, 1],
          [null, 1, 1],
        ]),
      ),
    ).toEqual([{ day: "2026-09-01", clicks: 5, impressions: 50 }]);
  });
});

describe("normalizeSiteUrl and matchSiteUrl", () => {
  it("lowercases and drops trailing slashes", () => {
    expect(normalizeSiteUrl("HTTPS://Example.com/")).toBe("https://example.com");
    expect(normalizeSiteUrl("sc-domain:Example.COM")).toBe("sc-domain:example.com");
  });

  it("returns the exact BigQuery literal of the own property", () => {
    expect(
      matchSiteUrl(
        [
          { siteUrl: "https://other.com/", clicks: 9000 },
          { siteUrl: "https://Example.com/", clicks: 10 },
        ],
        "https://example.com",
      ),
    ).toBe("https://Example.com/");
  });

  it("keeps domain and URL-prefix properties apart", () => {
    expect(
      matchSiteUrl([{ siteUrl: "https://example.com/", clicks: 1 }], "sc-domain:example.com"),
    ).toBeNull();
    expect(
      matchSiteUrl([{ siteUrl: "sc-domain:example.com", clicks: 1 }], "sc-domain:example.com"),
    ).toBe("sc-domain:example.com");
  });

  it("returns null without a match", () => {
    expect(matchSiteUrl([], "sc-domain:x.com")).toBeNull();
  });
});

describe("coverageFromResults", () => {
  const log = (site: BqCell[] | null, url: BqCell[] | null) =>
    result(
      [
        site ? ["SEARCHDATA_SITE_IMPRESSION", ...site] : null,
        url ? ["SEARCHDATA_URL_IMPRESSION", ...url] : null,
      ].filter((row): row is BqCell[] => row !== null),
    );

  it("takes the later first day and the earlier last day from the log", () => {
    expect(
      coverageFromResults(
        log(["2026-06-01", "2026-09-30", 120], ["2026-06-05", "2026-09-28", 115]),
        { site: null, url: null },
      ),
    ).toEqual({ exportStart: "2026-06-05", exportedThrough: "2026-09-28", days: 115 });
  });

  it("falls back to the table probes when the log is missing", () => {
    expect(
      coverageFromResults(null, {
        site: result([["2026-06-01", "2026-09-30", 100]]),
        url: result([["2026-06-02", "2026-09-29", 99]]),
      }),
    ).toEqual({ exportStart: "2026-06-02", exportedThrough: "2026-09-29", days: 99 });
  });

  it("falls back when the log lacks one table", () => {
    expect(
      coverageFromResults(log(["2026-06-01", "2026-09-30", 100], null), {
        site: result([["2026-06-01", "2026-09-30", 100]]),
        url: result([["2026-06-01", "2026-09-30", 100]]),
      }),
    ).toMatchObject({ exportStart: "2026-06-01" });
  });

  it("is null when one table is empty", () => {
    expect(
      coverageFromResults(null, {
        site: result([["2026-06-01", "2026-09-30", 100]]),
        url: result([[null, null, 0]]),
      }),
    ).toBeNull();
    expect(coverageFromResults(null, { site: null, url: null })).toBeNull();
  });

  it("is null when the two windows do not overlap", () => {
    expect(
      coverageFromResults(
        log(["2026-01-01", "2026-02-01", 30], ["2026-05-01", "2026-06-01", 30]),
        { site: null, url: null },
      ),
    ).toBeNull();
  });
});
