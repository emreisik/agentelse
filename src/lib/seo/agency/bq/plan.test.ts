import { describe, expect, it } from "vitest";

import {
  bqPeriodKey,
  planBqPeriods,
  type BqFetchState,
  type BqPeriodTask,
} from "./plan";

// 2026-09-01 Salı; ilk Pazartesi 2026-09-07. Pencere 2026-09-01 … 2026-10-04:
// tam haftalar 09-07, 09-14, 09-21, 09-28 (Pazar 10-04); tam ay yalnız Eylül
// (09-01 pencerenin ilk günü, 09-30 ≤ 10-04); Ekim henüz bitmedi.
const WINDOW = { exportStart: "2026-09-01", exportedThrough: "2026-10-04" };

function fetched(
  entries: [string, "WEEK" | "MONTH", string, BqFetchState][],
): Map<string, BqFetchState> {
  return new Map(
    entries.map(([start, grain, key, state]) => [
      bqPeriodKey(grain, start, key),
      state,
    ]),
  );
}

const weeks = (tasks: BqPeriodTask[]) =>
  [...new Set(tasks.filter((t) => t.grain === "WEEK").map((t) => t.periodStart))];

describe("window math", () => {
  it("excludes the partial boundary week and the partial last month", () => {
    const tasks = planBqPeriods({
      ...WINDOW,
      importAll: false,
      fetched: new Map(),
      maxTasks: 1000,
    });
    expect(weeks(tasks).sort()).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
    const months = [
      ...new Set(tasks.filter((t) => t.grain === "MONTH").map((t) => t.periodStart)),
    ];
    expect(months).toEqual(["2026-09-01"]);
  });

  it("skips a partial first month and a partial first week", () => {
    const tasks = planBqPeriods({
      exportStart: "2026-09-02",
      exportedThrough: "2026-10-31",
      importAll: false,
      fetched: new Map(),
      maxTasks: 1000,
    });
    const months = tasks.filter((t) => t.grain === "MONTH");
    expect(months.map((t) => t.periodStart)).toEqual(["2026-10-01", "2026-10-01"]);
    expect(weeks(tasks)).not.toContain("2026-08-31");
  });

  it("never plans monthly query_page", () => {
    const tasks = planBqPeriods({
      ...WINDOW,
      importAll: true,
      fetched: new Map(),
      maxTasks: 1000,
    });
    expect(
      tasks.some((t) => t.grain === "MONTH" && t.key === "query_page"),
    ).toBe(false);
    expect(
      tasks.some((t) => t.grain === "WEEK" && t.key === "query_page"),
    ).toBe(true);
  });

  it("is empty for a window without complete periods", () => {
    expect(
      planBqPeriods({
        exportStart: "2026-09-02",
        exportedThrough: "2026-09-05",
        importAll: true,
        fetched: new Map(),
      }),
    ).toEqual([]);
  });
});

describe("reasons and ordering", () => {
  it("selects missing, truncated API and (with importAll) complete API periods", () => {
    const state = fetched([
      ["2026-09-07", "WEEK", "query", { source: "API", truncated: true }],
      ["2026-09-07", "WEEK", "page", { source: "API", truncated: false }],
    ]);
    const without = planBqPeriods({
      ...WINDOW,
      importAll: false,
      fetched: state,
      maxTasks: 1000,
    });
    expect(
      without.find((t) => t.periodStart === "2026-09-07" && t.key === "query")
        ?.reason,
    ).toBe("API_TRUNCATED");
    expect(
      without.find((t) => t.periodStart === "2026-09-07" && t.key === "page"),
    ).toBeUndefined();

    const withAll = planBqPeriods({
      ...WINDOW,
      importAll: true,
      fetched: state,
      maxTasks: 1000,
    });
    expect(
      withAll.find((t) => t.periodStart === "2026-09-07" && t.key === "page")
        ?.reason,
    ).toBe("IMPORT_ALL");
  });

  it("orders API_TRUNCATED first, then MISSING, then IMPORT_ALL; newest first; weeks before months", () => {
    const state = fetched([
      ["2026-09-07", "WEEK", "query", { source: "API", truncated: true }],
      ["2026-09-14", "WEEK", "query", { source: "API", truncated: true }],
      ["2026-09-21", "WEEK", "query", { source: "API", truncated: false }],
    ]);
    const tasks = planBqPeriods({
      ...WINDOW,
      importAll: true,
      fetched: state,
      maxTasks: 1000,
    });
    expect(tasks[0]).toMatchObject({ reason: "API_TRUNCATED", periodStart: "2026-09-14" });
    expect(tasks[1]).toMatchObject({ reason: "API_TRUNCATED", periodStart: "2026-09-07" });
    const reasons = tasks.map((t) => t.reason);
    expect(reasons.indexOf("MISSING")).toBeGreaterThan(1);
    expect(reasons.lastIndexOf("MISSING")).toBeLessThan(reasons.indexOf("IMPORT_ALL"));
    const missing = tasks.filter((t) => t.reason === "MISSING");
    const firstMonth = missing.findIndex((t) => t.grain === "MONTH");
    const lastWeek = missing.map((t) => t.grain).lastIndexOf("WEEK");
    expect(firstMonth).toBeGreaterThan(lastWeek);
    const missingWeekStarts = missing
      .filter((t) => t.grain === "WEEK")
      .map((t) => t.periodStart);
    expect([...missingWeekStarts].sort().reverse()).toEqual(missingWeekStarts);
  });

  it("never re-selects BQ periods, truncated or not", () => {
    const entries: [string, "WEEK" | "MONTH", string, BqFetchState][] = [];
    for (const start of ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]) {
      for (const key of ["query", "page", "query_page"]) {
        entries.push([start, "WEEK", key, { source: "BQ", truncated: key === "query" }]);
      }
    }
    for (const key of ["query", "page"]) {
      entries.push(["2026-09-01", "MONTH", key, { source: "BQ", truncated: true }]);
    }
    expect(
      planBqPeriods({
        ...WINDOW,
        importAll: true,
        fetched: fetched(entries),
        maxTasks: 1000,
      }),
    ).toEqual([]);
  });

  it("caps the number of tasks (default 6)", () => {
    const tasks = planBqPeriods({ ...WINDOW, importAll: false, fetched: new Map() });
    expect(tasks).toHaveLength(6);
    expect(
      planBqPeriods({ ...WINDOW, importAll: false, fetched: new Map(), maxTasks: 2 }),
    ).toHaveLength(2);
  });
});
