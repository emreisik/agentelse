import { describe, expect, it } from "vitest";

import {
  SPLIT_ERROR_TEXT,
  SPLIT_MAX_PAGES,
  assignArms,
  splitEligibility,
  type SplitCandidate,
} from "./assign";

// Bu dosyanın kanıtladığı: atama tohuma göre belirlidir, farklı tohum farklı
// ayrım verir; her grup KENDİ içinde en çok 1 sayfa farkla ikiye bölünür ve
// çarpık (Zipf benzeri) bir örnekte tıklama oranı >= 0.9 kalır; tek sayılı
// grup; 4000 sınırı taban denetiminden önce uygulanır; gösterimi olmayan
// sayfa dışlanır; 99 sayfalık grup TOO_FEW_PAGES, 100 yeterli; kimlik
// listeleri sıralı.

function zipf(group: string, count: number, scale = 400): SplitCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    pageId: `${group}-${String(index).padStart(4, "0")}`,
    group,
    preClicks: Math.max(1, Math.round(scale / (index + 1) ** 0.7)),
    preImpressions: 100 + index,
  }));
}

const THREE_GROUPS = [
  ...zipf("/a", 150),
  ...zipf("/b", 150),
  ...zipf("/c", 150),
];

describe("assignArms", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const one = assignArms({ candidates: THREE_GROUPS, seed: "seed-1" });
    const again = assignArms({ candidates: THREE_GROUPS, seed: "seed-1" });
    const other = assignArms({ candidates: THREE_GROUPS, seed: "seed-2" });
    expect(again).toEqual(one);
    expect(other.test).not.toEqual(one.test);
  });

  it("balances every group within one page and keeps the click ratio high", () => {
    for (const seed of ["t1", "t2", "t3", "t4", "t5", "t6"]) {
      const result = assignArms({ candidates: THREE_GROUPS, seed });
      for (const group of result.perGroup) {
        expect(Math.abs(group.test - group.control)).toBeLessThanOrEqual(1);
        expect(group.test + group.control).toBe(150);
      }
      expect(result.test.length + result.control.length).toBe(450);
      expect(result.balance.ratio).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("puts every page in exactly one arm and sorts the ids", () => {
    const result = assignArms({ candidates: THREE_GROUPS, seed: "x" });
    expect(result.test).toEqual([...result.test].sort());
    expect(result.control).toEqual([...result.control].sort());
    expect(new Set([...result.test, ...result.control]).size).toBe(450);
  });

  it("splits an odd group with a one page difference", () => {
    const result = assignArms({ candidates: zipf("/odd", 101), seed: "odd" });
    expect(Math.abs(result.test.length - result.control.length)).toBe(1);
  });

  it("excludes pages without impressions", () => {
    const result = assignArms({
      candidates: [
        ...zipf("/a", 10),
        { pageId: "dead", group: "/a", preClicks: 0, preImpressions: 0 },
      ],
      seed: "s",
    });
    expect([...result.test, ...result.control]).not.toContain("dead");
    expect(result.test.length + result.control.length).toBe(10);
  });

  it("reports a ratio of 1 when both arms have no clicks", () => {
    const result = assignArms({
      candidates: Array.from({ length: 6 }, (_, index) => ({
        pageId: `p${index}`,
        group: "/z",
        preClicks: 0,
        preImpressions: 5,
      })),
      seed: "s",
    });
    expect(result.balance.ratio).toBe(1);
  });

  it("caps the population at 4000 pages by clicks", () => {
    const many = Array.from({ length: SPLIT_MAX_PAGES + 50 }, (_, index) => ({
      pageId: `p${String(index).padStart(5, "0")}`,
      group: "/big",
      preClicks: SPLIT_MAX_PAGES + 50 - index,
      preImpressions: 10,
    }));
    const result = assignArms({ candidates: many, seed: "s" });
    expect(result.test.length + result.control.length).toBe(SPLIT_MAX_PAGES);
    expect([...result.test, ...result.control]).not.toContain("p04049");
  });
});

describe("splitEligibility", () => {
  it("needs four covered pre weeks", () => {
    expect(
      splitEligibility({
        candidates: THREE_GROUPS,
        groups: ["/a"],
        preWeeksCovered: 3,
      }),
    ).toEqual({ ok: false, reason: "NO_HISTORY" });
  });

  it("refuses a group with 99 pages and accepts 100", () => {
    expect(
      splitEligibility({
        candidates: zipf("/a", 99),
        groups: ["/a"],
        preWeeksCovered: 8,
      }),
    ).toEqual({ ok: false, reason: "TOO_FEW_PAGES" });
    const ok = splitEligibility({
      candidates: zipf("/a", 100),
      groups: ["/a"],
      preWeeksCovered: 8,
    });
    expect(ok.ok).toBe(true);
    expect(SPLIT_ERROR_TEXT.TOO_FEW_PAGES).toBe(
      "Each page group needs at least 100 pages with search traffic.",
    );
  });

  it("checks EVERY selected group, not the total", () => {
    const result = splitEligibility({
      candidates: [...zipf("/a", 300), ...zipf("/b", 50)],
      groups: ["/a", "/b"],
      preWeeksCovered: 8,
    });
    expect(result).toEqual({ ok: false, reason: "TOO_FEW_PAGES" });
  });

  it("does not count pages without impressions toward the floor", () => {
    const candidates = zipf("/a", 100).map((page, index) =>
      index < 5 ? { ...page, preImpressions: 0 } : page,
    );
    expect(
      splitEligibility({ candidates, groups: ["/a"], preWeeksCovered: 8 }),
    ).toEqual({ ok: false, reason: "TOO_FEW_PAGES" });
  });

  it("applies the 4000 cap before the per-group floor", () => {
    // /big has 4100 strong pages, /small only 100 weak ones: the cap removes
    // the weak group's pages from the population, so the floor fails.
    const big = Array.from({ length: 4100 }, (_, index) => ({
      pageId: `b${index}`,
      group: "/big",
      preClicks: 1000,
      preImpressions: 10,
    }));
    const small = Array.from({ length: 100 }, (_, index) => ({
      pageId: `s${index}`,
      group: "/small",
      preClicks: 1,
      preImpressions: 10,
    }));
    expect(
      splitEligibility({
        candidates: [...big, ...small],
        groups: ["/big", "/small"],
        preWeeksCovered: 8,
      }),
    ).toEqual({ ok: false, reason: "TOO_FEW_PAGES" });
  });

  it("refuses low traffic", () => {
    const weak = zipf("/a", 100).map((page) => ({ ...page, preClicks: 0 }));
    expect(
      splitEligibility({
        candidates: weak,
        groups: ["/a"],
        preWeeksCovered: 8,
      }),
    ).toEqual({ ok: false, reason: "LOW_TRAFFIC" });
  });

  it("recommends when both arms hold 100 pages or more", () => {
    const small = splitEligibility({
      candidates: zipf("/a", 150),
      groups: ["/a"],
      preWeeksCovered: 8,
    });
    expect(small.ok && small.recommended).toBe(false);
    const big = splitEligibility({
      candidates: THREE_GROUPS,
      groups: ["/a", "/b", "/c"],
      preWeeksCovered: 8,
    });
    expect(big.ok && big.recommended).toBe(true);
    if (big.ok) {
      expect(big.arms.test + big.arms.control).toBe(450);
      expect(big.perGroup).toHaveLength(3);
    }
  });
});
