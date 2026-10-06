import { describe, expect, it } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import { GA_CHECK_REASONS, gaCheckDef } from "./registry";
import { checkMH23, checkMH3, siteDoubleLoad } from "./site-checks";
import type { GaCheckResult, GaSiteTagResult } from "./types";

// Bu dosyanın kanıtladığı (GA-F3 site kontrolleri): MH3'ün tam sırası
// (tarama yok/site yok/robots/hata → kimlik yok → bulundu → başka kimlik →
// GTM → Google etiketi → istemci tarafı ya da eksik; asla FAIL); MH4'ün site
// yarısı; MH23'ün %20 AB/AEA sınırı, CMP ve Google etiketiyle gtm_only.

function siteTag(overrides: Partial<GaSiteTagResult> = {}): GaSiteTagResult {
  return {
    v: 1,
    at: "2026-10-01T08:00:00.000Z",
    host: "example.com",
    outcome: "ok",
    pagesChecked: 3,
    pagesFailed: 0,
    pagesWithExpected: 0,
    expectedId: "G-ABC123",
    otherIds: [],
    gtm: false,
    googleTag: false,
    gtagJs: false,
    doubleLoad: false,
    consentDefault: false,
    cmp: null,
    hints: {
      tel: false,
      whatsapp: false,
      mailto: false,
      form: false,
      maps: false,
      checkout: false,
    },
    ...overrides,
  };
}

function verdict(result: GaCheckResult) {
  const reason = String(result.evidence.reason);
  expect(GA_CHECK_REASONS[result.key]).toContain(reason);
  if (result.status === "PASS" || result.status === "UNKNOWN") {
    expect(result.severity).toBe(gaCheckDef(result.key).defaultSeverity);
  }
  return `${result.status}:${result.severity}:${reason}`;
}

describe("MH3 tag on the website", () => {
  it("follows the order and never fails", () => {
    expect(verdict(checkMH3(null, "PASS"))).toBe("UNKNOWN:WARN:not_checked");
    expect(verdict(checkMH3(siteTag({ outcome: "no_site" }), "FAIL"))).toBe(
      "UNKNOWN:WARN:no_site",
    );
    expect(
      verdict(checkMH3(siteTag({ outcome: "blocked_by_robots" }), "FAIL")),
    ).toBe("UNKNOWN:WARN:robots");
    expect(
      verdict(checkMH3(siteTag({ outcome: "fetch_failed" }), "FAIL")),
    ).toBe("UNKNOWN:WARN:fetch_failed");
    expect(
      verdict(
        checkMH3(siteTag({ expectedId: null, pagesWithExpected: 2 }), "FAIL"),
      ),
    ).toBe("UNKNOWN:WARN:no_measurement_id");
    expect(
      verdict(
        checkMH3(
          siteTag({ pagesWithExpected: 1, otherIds: ["G-OTHER"], gtm: true }),
          "FAIL",
        ),
      ),
    ).toBe("PASS:WARN:ok");
    expect(
      verdict(checkMH3(siteTag({ otherIds: ["G-OTHER"], gtm: true }), "FAIL")),
    ).toBe("WARN:WARN:other_id");
    expect(
      verdict(checkMH3(siteTag({ gtm: true, googleTag: true }), "FAIL")),
    ).toBe("UNKNOWN:WARN:gtm_only");
    expect(verdict(checkMH3(siteTag({ googleTag: true }), "FAIL"))).toBe(
      "UNKNOWN:WARN:google_tag_only",
    );
    expect(verdict(checkMH3(siteTag(), "PASS"))).toBe(
      "UNKNOWN:WARN:client_side",
    );
    expect(verdict(checkMH3(siteTag(), "UNKNOWN"))).toBe("WARN:WARN:missing");
    expect(verdict(checkMH3(siteTag(), "FAIL"))).toBe("WARN:WARN:missing");
  });

  it("keeps only ids and counts in the evidence", () => {
    const result = checkMH3(siteTag({ otherIds: ["G-OTHER"] }), "PASS");
    expect(result.evidence).toEqual({
      reason: "other_id",
      pagesChecked: 3,
      pagesWithExpected: 0,
      otherIds: ["G-OTHER"],
      checkedAt: "2026-10-01T08:00:00.000Z",
    });
  });
});

describe("MH4 site half", () => {
  it("reports double loading only for a successful scan", () => {
    expect(siteDoubleLoad(siteTag({ doubleLoad: true }))).toBe(true);
    expect(siteDoubleLoad(siteTag())).toBe(false);
    expect(
      siteDoubleLoad(siteTag({ outcome: "fetch_failed", doubleLoad: true })),
    ).toBeNull();
    expect(siteDoubleLoad(null)).toBeNull();
  });
});

describe("MH23 cookie consent signal", () => {
  const countries = (eu: number, other: number): GaTableRow[] => [
    { key: ["Germany"], values: [eu, 0] },
    { key: ["Turkey"], values: [other, 0] },
  ];

  it("passes when at most 20% of visits come from the EU/EEA", () => {
    expect(verdict(checkMH23(null, countries(40, 160)))).toBe(
      "PASS:INFO:few_eu",
    );
    expect(verdict(checkMH23(null, countries(41, 159)))).toBe(
      "UNKNOWN:INFO:not_checked",
    );
    expect(verdict(checkMH23(siteTag(), countries(100, 99)))).toBe(
      "UNKNOWN:INFO:low_volume",
    );
  });

  it("accepts a consent default or a CMP", () => {
    expect(
      verdict(
        checkMH23(siteTag({ consentDefault: true }), countries(100, 100)),
      ),
    ).toBe("PASS:INFO:ok");
    const cmp = checkMH23(siteTag({ cmp: "cookiebot" }), countries(100, 100));
    expect(verdict(cmp)).toBe("PASS:INFO:ok");
    expect(cmp.evidence).toMatchObject({ euShare: 0.5, cmp: "cookiebot" });
  });

  it("is unknown behind GTM or a Google tag and warns otherwise", () => {
    expect(
      verdict(checkMH23(siteTag({ googleTag: true }), countries(100, 100))),
    ).toBe("UNKNOWN:INFO:gtm_only");
    expect(
      verdict(checkMH23(siteTag({ gtm: true }), countries(100, 100))),
    ).toBe("UNKNOWN:INFO:gtm_only");
    expect(
      verdict(
        checkMH23(siteTag({ outcome: "fetch_failed" }), countries(100, 100)),
      ),
    ).toBe("UNKNOWN:INFO:not_checked");
    const result = checkMH23(siteTag(), countries(100, 100));
    expect(verdict(result)).toBe("WARN:INFO:no_consent_default");
    expect(result.evidence).toEqual({
      reason: "no_consent_default",
      euShare: 0.5,
      cmp: null,
    });
  });
});
