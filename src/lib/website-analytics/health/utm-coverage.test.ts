import { describe, expect, it } from "vitest";

import {
  evaluateUtmCoverage,
  UTM_COVERAGE_GUIDE,
  utmCoverageText,
  utmCoverageTitle,
  type UtmCoverageAd,
  type UtmCoverageInput,
} from "./utm-coverage";

// Bu dosyanın kanıtladığı (MH25): eşikler (%90 sınırı dahil geçer), "görünmedi"
// uygunluğu (en az 20 tıklama, ilk tıklama ≥ 2 gün önce), kodla ya da
// kampanyayla görülünce temiz çıkması, önem düzeyinin daima INFO olması ve
// metinlerde adres/kimlik bulunmaması.

const THROUGH = "2026-10-06";

function ad(index: number, overrides: Partial<UtmCoverageAd> = {}): UtmCoverageAd {
  return {
    adExternalId: `ad-secret-${index}`,
    firstClickDay: "2026-09-20",
    linkClicks: 10,
    tagged: true,
    code: `code${String(index).padStart(2, "0")}`,
    utmCampaign: `agx-camp-${index}`,
    ...overrides,
  };
}

function input(overrides: Partial<UtmCoverageInput> = {}): UtmCoverageInput {
  return {
    dataThrough: THROUGH,
    ads: [ad(1)],
    seen: { codes: [], campaigns: [] },
    ...overrides,
  };
}

function tenAds(tagged: number): UtmCoverageAd[] {
  return Array.from({ length: 10 }, (_, index) =>
    ad(index, index < tagged ? {} : { tagged: false, code: null, utmCampaign: null }),
  );
}

describe("evaluateUtmCoverage", () => {
  it("GA verisi yoksa no_data", () => {
    const result = evaluateUtmCoverage(input({ dataThrough: null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.evidence.reason).toBe("no_data");
    expect(result.evidence.coveragePct).toBeNull();
  });

  it("reklam yoksa no_ads", () => {
    const result = evaluateUtmCoverage(input({ ads: [] }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.evidence.reason).toBe("no_ads");
  });

  it("10 reklamın 9'u etiketliyse %90 sınırında geçer", () => {
    const result = evaluateUtmCoverage(input({ ads: tenAds(9) }));
    expect(result.evidence.coveragePct).toBe(90);
    expect(result.status).toBe("PASS");
    expect(result.evidence.reason).toBe("ok");
  });

  it("10 reklamın 8'i etiketliyse low_coverage", () => {
    const result = evaluateUtmCoverage(input({ ads: tenAds(8) }));
    expect(result.evidence.coveragePct).toBe(80);
    expect(result.status).toBe("WARN");
    expect(result.evidence.reason).toBe("low_coverage");
    expect(result.evidence.tagged).toBe(8);
    expect(result.evidence.ads).toBe(10);
  });

  it("kodu görünmeyen, 25 tıklamalı ve 3 gün önce başlamış reklam not_seen", () => {
    const result = evaluateUtmCoverage(
      input({ ads: [ad(1, { linkClicks: 25, firstClickDay: "2026-10-03" })] }),
    );
    expect(result.status).toBe("WARN");
    expect(result.evidence.reason).toBe("not_seen");
    expect(result.evidence.unseen).toBe(1);
  });

  it("tam 2 gün önce başlayan reklam uygundur", () => {
    const result = evaluateUtmCoverage(
      input({ ads: [ad(1, { linkClicks: 20, firstClickDay: "2026-10-04" })] }),
    );
    expect(result.evidence.reason).toBe("not_seen");
  });

  it("kodla görülünce temiz", () => {
    const result = evaluateUtmCoverage(
      input({
        ads: [ad(1, { linkClicks: 25, firstClickDay: "2026-10-03" })],
        seen: { codes: ["CODE01"], campaigns: [] },
      }),
    );
    expect(result.status).toBe("PASS");
    expect(result.evidence.unseen).toBe(0);
  });

  it("agx kampanyasıyla görülünce temiz", () => {
    const result = evaluateUtmCoverage(
      input({
        ads: [ad(1, { linkClicks: 25, firstClickDay: "2026-10-03" })],
        seen: { codes: [], campaigns: ["agx-camp-1"] },
      }),
    );
    expect(result.status).toBe("PASS");
  });

  it("1 günlük ya da 19 tıklamalı reklam uygun değildir", () => {
    const young = evaluateUtmCoverage(
      input({ ads: [ad(1, { linkClicks: 25, firstClickDay: "2026-10-05" })] }),
    );
    expect(young.status).toBe("PASS");
    const few = evaluateUtmCoverage(
      input({ ads: [ad(1, { linkClicks: 19, firstClickDay: "2026-10-03" })] }),
    );
    expect(few.status).toBe("PASS");
  });

  it("etiketsiz reklam görünmedi sayılmaz", () => {
    const result = evaluateUtmCoverage(
      input({
        ads: [
          ...tenAds(10),
          ad(11, { tagged: false, code: null, utmCampaign: null, linkClicks: 90 }),
        ].slice(1),
      }),
    );
    // 9 etiketli + 1 etiketsiz = %90 → geçer; etiketsiz reklam unseen'e girmez
    expect(result.evidence.coveragePct).toBe(90);
    expect(result.evidence.unseen).toBe(0);
  });

  it("önem düzeyi her sonuçta INFO", () => {
    const results = [
      evaluateUtmCoverage(input({ dataThrough: null })),
      evaluateUtmCoverage(input({ ads: [] })),
      evaluateUtmCoverage(input({ ads: tenAds(1) })),
      evaluateUtmCoverage(input({ ads: tenAds(10) })),
      evaluateUtmCoverage(
        input({ ads: [ad(1, { linkClicks: 30, firstClickDay: "2026-10-01" })] }),
      ),
    ];
    for (const result of results) expect(result.severity).toBe("INFO");
  });
});

describe("utmCoverageTitle ve utmCoverageText", () => {
  it("başlıklar sabittir", () => {
    expect(utmCoverageTitle(evaluateUtmCoverage(input({ ads: tenAds(5) })))).toBe(
      "Some ads Agentelse created have no tracking tags",
    );
    expect(
      utmCoverageTitle(
        evaluateUtmCoverage(
          input({ ads: [ad(1, { linkClicks: 30, firstClickDay: "2026-10-01" })] }),
        ),
      ),
    ).toBe("Tagged ad visits aren't showing up in Google Analytics");
    expect(utmCoverageTitle(evaluateUtmCoverage(input()))).toBe(
      "Agentelse links carry tracking",
    );
  });

  it("metinde yalnız sayılar var; adres ve reklam kimliği yok", () => {
    const results = [
      evaluateUtmCoverage(input({ ads: tenAds(5) })),
      evaluateUtmCoverage(
        input({ ads: [ad(1, { linkClicks: 30, firstClickDay: "2026-10-01" })] }),
      ),
      evaluateUtmCoverage(input()),
      evaluateUtmCoverage(input({ ads: [] })),
      evaluateUtmCoverage(input({ dataThrough: null })),
    ];
    for (const result of results) {
      const text = `${utmCoverageTitle(result)} ${utmCoverageText(result)}`;
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toContain("ad-secret");
      expect(text).not.toContain("agx-camp");
      expect(text).not.toMatch(/code\d\d/);
    }
  });

  it("low_coverage metni sayıları ve yüzdeyi söyler", () => {
    const text = utmCoverageText(evaluateUtmCoverage(input({ ads: tenAds(8) })));
    expect(text).toContain("8 of 10 ads");
    expect(text).toContain("(80%)");
  });
});

describe("UTM_COVERAGE_GUIDE", () => {
  it("3-5 adım içerir", () => {
    expect(UTM_COVERAGE_GUIDE.steps.length).toBeGreaterThanOrEqual(3);
    expect(UTM_COVERAGE_GUIDE.steps.length).toBeLessThanOrEqual(5);
  });
});
