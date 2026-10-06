import { describe, expect, it } from "vitest";

import history from "@/server/integrations/crux/__fixtures__/crux-history.json";
import record from "@/server/integrations/crux/__fixtures__/crux-record.json";

import {
  cwvOverall,
  cwvRating,
  cwvWorsened,
  parseCruxHistory,
  parseCruxRecord,
  type CwvRecord,
} from "./cwv";

// Bu dosyanın kanıtladığı: CrUX kaydı (CLS dizgi, TTFB'nin iki anahtar
// biçimi, lastDate/endDate) ve geçmişi (null/NaN değerler) okunur; eşik
// değerleri iyi tarafta sayılır; genel değerlendirme en kötüdür;
// kötüleşme son dönemi 4 dönem öncesiyle karşılaştırır.

describe("parseCruxRecord", () => {
  it("parses the record fixture", () => {
    const parsed = parseCruxRecord(record, "PHONE");
    expect(parsed).toEqual({
      formFactor: "PHONE",
      collectionPeriod: "2026-09-06..2026-10-03",
      periodEnd: "2026-10-03",
      p75: { lcp: 2900, inp: 180, cls: 0.05, fcp: 2210, ttfb: 1012 },
      histogram: {
        lcp: [0.6214, 0.2408, 0.1378],
        inp: [0.7804, 0.1702, 0.0494],
        cls: [0.8412, 0.0991, 0.0597],
        fcp: [0.5531, 0.3022, 0.1447],
        ttfb: [0.6123, 0.3015, 0.0862],
      },
    });
  });

  it("accepts the time_to_first_byte key and an endDate period", () => {
    const parsed = parseCruxRecord(
      {
        record: {
          metrics: {
            time_to_first_byte: { percentiles: { p75: 700 } },
            cumulative_layout_shift: { percentiles: { p75: "0.12" } },
          },
          collectionPeriod: {
            startDate: { year: 2026, month: 9, day: 1 },
            endDate: { year: 2026, month: 9, day: 28 },
          },
        },
      },
      "DESKTOP",
    );
    expect(parsed).toMatchObject({
      formFactor: "DESKTOP",
      collectionPeriod: "2026-09-01..2026-09-28",
      periodEnd: "2026-09-28",
      p75: { lcp: null, inp: null, cls: 0.12, fcp: null, ttfb: 700 },
    });
  });

  it("returns null for empty or malformed records", () => {
    expect(parseCruxRecord(null, "PHONE")).toBeNull();
    expect(parseCruxRecord({ record: { metrics: {} } }, "PHONE")).toBeNull();
    expect(
      parseCruxRecord(
        {
          record: {
            metrics: {},
            collectionPeriod: { lastDate: { year: 2026, month: 9, day: 1 } },
          },
        },
        "PHONE",
      ),
    ).toBeNull();
  });
});

describe("parseCruxHistory", () => {
  it("parses periods, skips the empty one and keeps string CLS values", () => {
    const parsed = parseCruxHistory(history, "PHONE");
    expect(parsed).toHaveLength(4);
    expect(parsed.map((entry) => entry.periodEnd)).toEqual([
      "2026-09-05",
      "2026-09-12",
      "2026-09-26",
      "2026-10-03",
    ]);
    expect(parsed[3]).toMatchObject({
      p75: { lcp: 2900, inp: 180, cls: 0.05, fcp: null, ttfb: 1012 },
      histogram: { lcp: [0.62, 0.24, 0.14] },
    });
    expect(parsed[0]!.p75.lcp).toBe(2100);
  });

  it("returns [] for malformed input", () => {
    expect(parseCruxHistory(null, "PHONE")).toEqual([]);
    expect(parseCruxHistory({ record: { metrics: {} } }, "PHONE")).toEqual([]);
  });
});

describe("cwvRating", () => {
  it("counts the threshold values on the better side", () => {
    expect(cwvRating("lcp", 2500)).toBe("good");
    expect(cwvRating("lcp", 2501)).toBe("needs-improvement");
    expect(cwvRating("lcp", 4000)).toBe("needs-improvement");
    expect(cwvRating("lcp", 4001)).toBe("poor");
    expect(cwvRating("inp", 200)).toBe("good");
    expect(cwvRating("inp", 501)).toBe("poor");
    expect(cwvRating("cls", 0.1)).toBe("good");
    expect(cwvRating("cls", 0.25)).toBe("needs-improvement");
    expect(cwvRating("cls", 0.26)).toBe("poor");
    expect(cwvRating("ttfb", null)).toBeNull();
  });
});

describe("cwvOverall", () => {
  it("is the worst of LCP, INP and CLS", () => {
    expect(
      cwvOverall({ lcp: 2900, inp: 180, cls: 0.05, fcp: 9000, ttfb: 9000 }),
    ).toBe("needs-improvement");
    expect(
      cwvOverall({ lcp: 1000, inp: 600, cls: 0.05, fcp: null, ttfb: null }),
    ).toBe("poor");
    expect(
      cwvOverall({ lcp: 1000, inp: null, cls: null, fcp: null, ttfb: null }),
    ).toBe("good");
    expect(
      cwvOverall({ lcp: null, inp: null, cls: null, fcp: 100, ttfb: 100 }),
    ).toBeNull();
  });
});

describe("cwvWorsened", () => {
  const entry = (periodEnd: string, lcp: number): CwvRecord => ({
    formFactor: "PHONE",
    collectionPeriod: `x..${periodEnd}`,
    periodEnd,
    p75: { lcp, inp: 100, cls: 0.01, fcp: null, ttfb: null },
    histogram: {},
  });

  it("compares the latest period with four periods earlier", () => {
    expect(cwvWorsened(parseCruxHistory(history, "PHONE"))).toBe(true);
    expect(
      cwvWorsened([
        entry("2026-09-05", 2000),
        entry("2026-09-12", 2100),
        entry("2026-09-19", 2200),
        entry("2026-09-26", 2300),
        entry("2026-10-03", 2400),
      ]),
    ).toBe(false);
    // Sıra karışık gelse de son dönem tarihe göre bulunur.
    expect(
      cwvWorsened([entry("2026-10-03", 4500), entry("2026-09-05", 2000)]),
    ).toBe(true);
    expect(cwvWorsened([entry("2026-10-03", 4500)])).toBe(false);
  });
});
