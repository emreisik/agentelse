import { describe, expect, it } from "vitest";

import {
  GA_BQ_PURPOSES,
  buildGaStatements,
  exportRangeDays,
  planChunks,
  splitDayRange,
} from "./sql";

// Bu dosyanın kanıtladığı: tanımlayıcılar yeniden doğrulanır (enjeksiyon => null),
// tarayan SELECT'te _TABLE_SUFFIX koşulları var, ga_session_id ve page_location
// event_params alt sorgularıyla okunur (çıplak sütun DEĞİL), olay ifadesi
// event_params'a dokunmaz, tarih SQL'e gömülmez, ifadeler SELECT ile başlar ve ';'
// içermez. SQL gerçek bir dışa aktarımda çalıştırılmadı: yalnız metin doğrulaması.

const REF = { projectId: "my-company-123456", datasetId: "analytics_424242" };
const RANGE = {
  fromDay: "2026-09-01",
  toDay: "2026-09-28",
  keyEventNames: ["purchase", "sign_up"],
};

function build() {
  const out = buildGaStatements(REF, RANGE);
  if (!out) throw new Error("expected statements");
  return out;
}

describe("buildGaStatements identifiers", () => {
  it.each([
    "UPPER-case-123456",
    "bad`tick-123456",
    "x",
    "project-123456; DROP",
    "my-company-123456.other",
    "",
  ])("returns null for project id %j", (projectId) => {
    expect(buildGaStatements({ ...REF, projectId }, RANGE)).toBeNull();
  });

  it.each([
    "analytics_1`; DROP",
    "analytics-1",
    "a.b",
    "",
    "analytics 1",
  ])("returns null for dataset id %j", (datasetId) => {
    expect(buildGaStatements({ ...REF, datasetId }, RANGE)).toBeNull();
  });

  it("returns null for bad or reversed dates", () => {
    expect(buildGaStatements(REF, { ...RANGE, fromDay: "2026-9-1" })).toBeNull();
    expect(buildGaStatements(REF, { ...RANGE, toDay: "20260928" })).toBeNull();
    expect(
      buildGaStatements(REF, { ...RANGE, fromDay: "2026-09-28", toDay: "2026-09-01" }),
    ).toBeNull();
  });

  it("backticks the project and dataset in the scanned table", () => {
    const { daily, events, pages } = build();
    for (const statement of [daily, events, pages]) {
      expect(statement.sql).toContain("`my-company-123456.analytics_424242.events_*`");
    }
  });
});

describe("buildGaStatements SQL shape", () => {
  it("scans only daily tables with suffix predicates in the scanning SELECT", () => {
    for (const statement of Object.values(build())) {
      expect(statement.sql).toContain("_TABLE_SUFFIX BETWEEN @from_suffix AND @to_suffix");
      expect(statement.sql).toContain("REGEXP_CONTAINS(_TABLE_SUFFIX, r'^[0-9]{8}$')");
    }
  });

  it("reads ga_session_id and page_location through UNNEST(event_params) subqueries", () => {
    const { daily, pages, events } = build();
    expect(daily.sql).toContain(
      "(SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS ga_session_id",
    );
    expect(pages.sql).toContain(
      "(SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location",
    );
    // Çıplak sütun olarak başvurulmaz: FROM'dan hemen sonraki SELECT listesinde
    // yalnız alt sorgu içinde geçer.
    expect(daily.sql).not.toMatch(/SELECT\s+ga_session_id,/);
    expect(pages.sql).not.toMatch(/,\s*page_location,/);
    // Olay ifadesi event_params'a hiç dokunmaz.
    expect(events.sql).not.toContain("event_params");
  });

  it("restricts the pages statement to page_view and extracts the path in the outer select", () => {
    const { pages } = build();
    expect(pages.sql).toContain("event_name = 'page_view'");
    expect(pages.sql).toContain(
      "REGEXP_EXTRACT(page_location, r'^https?://[^/]+(/[^?#]*)') AS path",
    );
    expect(pages.sql).toContain("ROW_NUMBER() OVER (PARTITION BY day");
    expect(pages.sql).toContain("rn <= 50");
  });

  it("aggregates the daily metrics", () => {
    const { daily } = build();
    expect(daily.sql).toContain("COUNT(DISTINCT user_pseudo_id) AS users");
    expect(daily.sql).toContain(
      "COUNT(DISTINCT CONCAT(user_pseudo_id, '.', CAST(ga_session_id AS STRING))) AS sessions",
    );
    expect(daily.sql).toContain("COUNTIF(event_name IN UNNEST(SPLIT(@key_events, ','))) AS key_events");
    expect(daily.sql).toContain("* 1000000) AS INT64) AS revenue_micros");
    expect(daily.sql).toContain("ecommerce.purchase_revenue");
  });

  it("keeps the top 20 events per day", () => {
    expect(build().events.sql).toContain("rn <= 20");
  });

  it("uses parameters only: no date or key event is interpolated", () => {
    const { daily, events, pages } = build();
    for (const statement of [daily, events, pages]) {
      expect(statement.sql).not.toMatch(/2026-?09/);
      expect(statement.sql).not.toContain("'purchase'");
      expect(statement.sql).not.toContain("sign_up");
    }
    expect(daily.params).toEqual([
      { name: "from_suffix", type: "STRING", value: "20260901" },
      { name: "to_suffix", type: "STRING", value: "20260928" },
      { name: "key_events", type: "STRING", value: "purchase,sign_up" },
    ]);
    expect(events.params.map((p) => p.name)).toEqual(["from_suffix", "to_suffix"]);
    expect(pages.params.map((p) => p.name)).toEqual(["from_suffix", "to_suffix"]);
  });

  it("joins key events with commas, empty becomes an empty string and bad names are dropped", () => {
    const empty = buildGaStatements(REF, { ...RANGE, keyEventNames: [] });
    expect(empty?.daily.params.find((p) => p.name === "key_events")?.value).toBe("");
    const dirty = buildGaStatements(REF, {
      ...RANGE,
      keyEventNames: ["ok_event", "bad,one", "x') OR 1=1 --"],
    });
    expect(dirty?.daily.params.find((p) => p.name === "key_events")?.value).toBe("ok_event");
  });

  it("starts with SELECT, has no semicolon and uses the documented purposes", () => {
    const statements = build();
    for (const statement of Object.values(statements)) {
      expect(statement.sql.trimStart()).toMatch(/^SELECT/);
      expect(statement.sql).not.toContain(";");
    }
    expect([statements.daily.purpose, statements.events.purpose, statements.pages.purpose]).toEqual([
      ...GA_BQ_PURPOSES,
    ]);
  });

  it("sets maxRows per statement from the range", () => {
    const { daily, events, pages } = build();
    expect(daily.maxRows).toBe(28 + 2);
    expect(events.maxRows).toBe(28 * 20 + 20);
    expect(pages.maxRows).toBe(28 * 50 + 50);
  });
});

describe("exportRangeDays", () => {
  it("counts inclusive days", () => {
    expect(exportRangeDays("2026-09-01", "2026-09-01")).toBe(1);
    expect(exportRangeDays("2026-09-01", "2026-09-28")).toBe(28);
    expect(exportRangeDays("2026-09-28", "2026-09-01")).toBe(0);
    expect(exportRangeDays("bad", "2026-09-01")).toBe(0);
  });
});

describe("planChunks", () => {
  it("returns one chunk when the estimate fits", () => {
    expect(planChunks({ days: 28, estimatedBytes: 1_000, capBytes: 2_000 })).toBe(1);
    expect(planChunks({ days: 28, estimatedBytes: 0, capBytes: 2_000 })).toBe(1);
  });

  it("splits by the summed estimate over the cap", () => {
    expect(planChunks({ days: 28, estimatedBytes: 5_000, capBytes: 2_000 })).toBe(3);
  });

  it("never exceeds the number of days", () => {
    expect(planChunks({ days: 3, estimatedBytes: 1e12, capBytes: 1_000 })).toBe(3);
  });

  it("handles degenerate inputs", () => {
    expect(planChunks({ days: 0, estimatedBytes: 10, capBytes: 5 })).toBe(0);
    expect(planChunks({ days: 5, estimatedBytes: 10, capBytes: 0 })).toBe(5);
    expect(planChunks({ days: 5, estimatedBytes: Number.NaN, capBytes: 5 })).toBe(1);
    expect(planChunks({ days: 5.9, estimatedBytes: 100, capBytes: 1 })).toBe(5);
  });
});

describe("splitDayRange", () => {
  it("covers the range exactly without overlap", () => {
    const parts = splitDayRange("2026-09-01", "2026-09-10", 3);
    expect(parts).toEqual([
      { fromDay: "2026-09-01", toDay: "2026-09-04" },
      { fromDay: "2026-09-05", toDay: "2026-09-08" },
      { fromDay: "2026-09-09", toDay: "2026-09-10" },
    ]);
  });

  it("returns one part for one chunk and caps at the day count", () => {
    expect(splitDayRange("2026-09-01", "2026-09-03", 1)).toEqual([
      { fromDay: "2026-09-01", toDay: "2026-09-03" },
    ]);
    expect(splitDayRange("2026-09-01", "2026-09-02", 9)).toHaveLength(2);
    expect(splitDayRange("2026-09-03", "2026-09-01", 2)).toEqual([]);
    expect(splitDayRange("2026-09-01", "2026-09-03", 0)).toEqual([]);
  });
});
