import { describe, expect, it } from "vitest";

import type { GaReportSpec } from "./catalog";
import type { GaParsedReport } from "./response";
import {
  aggregateSlices,
  droppedTotals,
  splitReportByDay,
  type GaStoredSlice,
} from "./slices";

// Bu dosyanın kanıtladığı: rapor mülk günlerine doğru bölünür; maskeleme
// sonrası aynılaşan sayfalar birleşir; gün başına sınır uygulanır ve kırpılan
// satırların toplamı kaybolmaz; satırı olmayan gün boş dilim olarak döner.

const spec: GaReportSpec = {
  key: "landing_page",
  version: 1,
  dimensions: ["landingPage"],
  metrics: ["sessions", "keyEvents"],
  orderBy: "sessions",
  rowsPerDay: 2,
  revisionDays: 7,
  retentionDays: 95,
  backfillDays: 95,
  chunkDays: 30,
  pathDimensions: ["landingPage"],
};

function report(
  rows: [string, string, number, number][],
  rowCount = rows.length,
): GaParsedReport {
  return {
    dimensionHeaders: ["date", "landingPage"],
    metricHeaders: ["sessions", "keyEvents"],
    rows: rows.map(([date, page, sessions, keyEvents]) => ({
      dimensions: [date, page],
      metrics: [sessions, keyEvents],
    })),
    rowCount,
    quality: {},
    propertyQuota: null,
  };
}

describe("splitReportByDay", () => {
  it("splits, masks, merges and trims each day", () => {
    const slices = splitReportByDay(
      report([
        ["20261004", "/", 50, 1],
        ["20261004", "/reset/jane@example.com", 7, 0],
        ["20261004", "/reset/joe@example.com", 5, 0],
        ["20261004", "/pricing", 9, 2],
        ["20261005", "/", 40, 0],
      ]),
      spec,
      ["2026-10-04", "2026-10-05", "2026-10-06"],
    );
    const [first, second, third] = slices;
    // İki e-postalı adres tek satır olur (7 + 5 = 12).
    expect(first?.rows).toEqual([
      ["/", 50, 1],
      ["/reset/[email]", 12, 0],
    ]);
    expect(first?.rowCount).toBe(3);
    expect(first?.truncated).toBe(true);
    expect(first?.otherRow).toEqual([9, 2]);
    expect(second?.rows).toEqual([["/", 40, 0]]);
    expect(second?.truncated).toBe(false);
    expect(second?.otherRow).toBeNull();
    // Satırı olmayan gün boş ama yazılır.
    expect(third).toMatchObject({ day: "2026-10-06", rows: [], rowCount: 0 });
  });

  it("marks every day truncated when Google cut the rows", () => {
    const [slice] = splitReportByDay(
      report([["20261004", "/", 50, 1]], 400),
      spec,
      ["2026-10-04"],
    );
    expect(slice?.truncated).toBe(true);
  });

  it("ignores days that were not asked for", () => {
    expect(
      splitReportByDay(report([["20261001", "/", 1, 0]]), spec, [
        "2026-10-04",
      ])[0]?.rows,
    ).toEqual([]);
  });
});

describe("aggregateSlices", () => {
  const slice = (day: string, rows: (string | number)[][]): GaStoredSlice => ({
    day,
    dimensionHeaders: ["landingPage"],
    metricHeaders: ["sessions", "keyEvents"],
    rows,
    truncated: false,
    otherRow: day === "2026-10-04" ? [3, 1] : null,
    quality: {},
  });

  it("sums a period by the asked dimensions, biggest first", () => {
    const slices = [
      slice("2026-10-04", [
        ["/", 10, 1],
        ["/pricing", 4, 2],
      ]),
      slice("2026-10-05", [
        ["/pricing", 8, 0],
        ["/", 1, 0],
      ]),
    ];
    expect(
      aggregateSlices(slices, ["landingPage"], ["sessions", "keyEvents"]),
    ).toEqual([
      { key: ["/pricing"], values: [12, 2] },
      { key: ["/"], values: [11, 1] },
    ]);
    // Dilimde olmayan boyut "(not set)", olmayan metrik 0.
    expect(
      aggregateSlices(slices, ["country"], ["sessions", "revenue"]),
    ).toEqual([{ key: ["(not set)"], values: [23, 0] }]);
    expect(droppedTotals(slices, ["sessions", "keyEvents"])).toEqual([3, 1]);
  });
});
