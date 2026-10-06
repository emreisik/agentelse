import { describe, expect, it } from "vitest";

import { describeCheck, suspectDaysText } from "./copy";
import { GA_CHECK_KEYS, type GaCheckEvidence, type GaCheckKey } from "./types";
import { GA_CHECK_REASONS, gaCheckDef } from "./registry";
import type { MeasurementCheckView } from "./view-types";

// Bu dosyanın kanıtladığı (GA-F3 kontrol metinleri): GA_CHECK_REASONS'taki
// her (anahtar, neden) boş ya da dolu kanıtla tek, kısa, temiz bir cümle
// verir; sentetik MH1 günü "No visits arrived" okunur; oranlar yüzde olur;
// şüpheli gün satırı 5 günden sonra kısalır.

function view(
  key: GaCheckKey,
  evidence: GaCheckEvidence,
): MeasurementCheckView {
  const def = gaCheckDef(key);
  return {
    key,
    code: def.code,
    title: def.title,
    category: def.category,
    status: "WARN",
    severity: def.defaultSeverity,
    evidence,
    guideId: def.guideId,
    alertId: null,
    firstFailedAt: null,
    lastCheckedAt: "2026-10-06T10:00:00.000Z",
  };
}

// Kanıtta görülebilecek her alan, uç değerlerle.
const RICH: Omit<GaCheckEvidence, "reason"> = {
  mode: "day",
  day: "2026-10-05",
  sessions: 1234,
  expected: 240.4,
  ratio: 0.05,
  synthetic: false,
  zeros: 3,
  checks: 4,
  lastAt: "2026-10-06T09:00:00.000Z",
  expectedDay: "2026-10-05",
  latestDay: "2026-10-03",
  pagesChecked: 6,
  pagesWithExpected: 0,
  otherIds: ["G-AAAA111111", "G-BBBB222222", "G-CCCC333333", "G-DDDD444444"],
  checkedAt: "2026-10-04T23:30:00.000Z",
  viewsPerSession: 4.25,
  baselineViewsPerSession: 1.9,
  engagementRate: 0.97,
  count: 1,
  names: ["purchase"],
  suggestions: [
    "generate_lead",
    "click_to_call",
    "whatsapp_click",
    "email_click",
  ],
  last7: 210,
  dailyBaseline: 9.5,
  perSession: 1.4,
  share: 0.1234,
  pairs: ["a very long source name that keeps going on / (not set)"],
  variants: ["Instagram / instagram / IG / ig / insta / a very long tail"],
  mediums: ["Social"],
  domain: "example.com",
  sources: ["paypal.com"],
  params: ["email", "phone", "name", "token"],
  pages: 3,
  views: 12,
  email: true,
  phone: false,
  probeFrom: "2026-09-29",
  probeTo: "2026-10-05",
  markerDays: 2,
  propertyTimeZone: "America/Los_Angeles",
  projectTimeZone: "Europe/Istanbul",
  paidSessions: 42,
  seen: ["scroll", "click", "file_download", "form_start"],
  reports: ["landing_page", "page"],
  dimension: "country",
  label: "{weird} Country Name That Is Rather Long Indeed And Keeps Going",
  spikeDays: ["2026-10-03", "2026-10-04"],
  streamHost: "shop.other-example.com",
  projectDomain: "example.com",
  secondsPerSession: 0.4,
  euShare: 0.35,
  cmp: null,
};

function expectClean(sentence: string): void {
  expect(sentence.trim()).not.toBe("");
  expect(sentence.length).toBeLessThanOrEqual(160);
  expect(sentence).not.toContain("undefined");
  expect(sentence).not.toContain("NaN");
  expect(sentence).not.toContain("null");
  expect(sentence).not.toContain("{");
  expect(sentence).not.toContain("[object");
}

describe("describeCheck", () => {
  it("gives every reason a short, clean sentence with and without evidence", () => {
    for (const key of GA_CHECK_KEYS) {
      for (const reason of GA_CHECK_REASONS[key]) {
        expectClean(describeCheck(view(key, { reason })));
        expectClean(
          describeCheck(view(key, { ...RICH, reason }), {
            timeZone: "Europe/Istanbul",
          }),
        );
        // Bozuk kanıt (yanlış türler) da cümleyi bozmaz.
        expectClean(
          describeCheck(
            view(key, {
              reason,
              sessions: "many",
              share: Number.NaN,
              day: "yesterday",
              otherIds: null,
              spikeDays: Number.POSITIVE_INFINITY,
            }),
          ),
        );
      }
    }
  });

  it("falls back for an unknown reason or missing evidence", () => {
    expect(describeCheck(view("MH1", { reason: "brand_new" }))).toBe(
      "We couldn't check this yet.",
    );
    expect(describeCheck(view("MH7", { reason: null }))).toBe(
      "We couldn't check this yet.",
    );
  });

  it("reads a synthetic MH1 day as no visits", () => {
    expect(
      describeCheck(
        view("MH1", {
          reason: "stopped",
          mode: "day",
          day: "2026-10-05",
          sessions: 0,
          expected: 240.2,
          ratio: 0,
          synthetic: true,
        }),
      ),
    ).toBe("No visits arrived on Oct 5 (usually about 240).");
  });

  it("formats shares as percentages and counts with separators", () => {
    expect(
      describeCheck(
        view("MH7", {
          reason: "high_unassigned",
          share: 0.1234,
          sessions: 1234,
        }),
      ),
    ).toBe(
      "12.3% of visits (1,234) in the last 28 days have no channel (Unassigned).",
    );
    expect(
      describeCheck(
        view("MH10", { reason: "gateway_referrals", share: 0.006 }),
      ),
    ).toContain("0.6% of visits");
  });

  it("uses the fixed MH12 recent-history wording and never shows a value", () => {
    expect(
      describeCheck(view("MH12", { reason: "recent_history", markerDays: 2 })),
    ).toBe(
      "Personal data appeared in page addresses in the last week; today's data looks clean.",
    );
    const hit = describeCheck(
      view("MH12", {
        reason: "pii_in_url",
        pages: 1,
        email: true,
        params: ["email"],
      }),
    );
    expect(hit).toBe(
      "Page addresses on 1 page sent email addresses to Google Analytics.",
    );
  });
});

describe("suspectDaysText", () => {
  it("is null without days", () => {
    expect(suspectDaysText([])).toBeNull();
  });

  it("lists a few days", () => {
    expect(suspectDaysText(["2026-10-04", "2026-10-03", "2026-10-04"])).toBe(
      "Left out of trends because of tracking problems: Oct 3, Oct 4.",
    );
  });

  it("shows the newest five and counts the rest", () => {
    const days = [
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ];
    expect(suspectDaysText(days)).toBe(
      "Left out of trends because of tracking problems: Sep 30, Oct 1, Oct 2, Oct 3, Oct 4 +2 more.",
    );
  });
});
