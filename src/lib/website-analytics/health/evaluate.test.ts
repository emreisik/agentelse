import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import { evaluateGaChecks, evaluateGaRealtimeCheck } from "./evaluate";
import { GA_CHECK_REASONS, gaCheckDef } from "./registry";
import {
  GA_CHECK_KEYS,
  type GaCheckKey,
  type GaCheckResult,
  type GaCheckSeverity,
  type GaHealthBreakdownDay,
  type GaHealthDay,
  type GaHealthInputs,
} from "./types";

// Bu dosyanın kanıtladığı (GA-F3 değerlendirme): boş girdide GA_CHECK_KEYS
// sırasıyla 25 sonuç ve hata yok; sağlıklı bir mülkte her kontrol PASS;
// WARN/FAIL önem haritası (kritik: MH1, MH1_RT, MH6, MH12, MH24 FAIL; bilgi:
// MH2, MH8, MH12 recent_history, MH13–MH19, MH23); bozuk girdide kontrol
// UNKNOWN 'error' olur; her neden GA_CHECK_REASONS'ta; realtime yolu tam
// değerlendirmedeki MH1_RT satırıyla aynı.

const TODAY = "2026-10-06";
const YESTERDAY = "2026-10-05";

function history(
  shape: (back: number) => Partial<GaHealthDay> = () => ({}),
): GaHealthDay[] {
  const days: GaHealthDay[] = [];
  for (let back = 70; back >= 1; back -= 1) {
    days.push({
      day: addDays(TODAY, -back),
      sessions: 100,
      engagedSessions: 60,
      engagementSec: 6000,
      screenPageViews: 250,
      keyEvents: 5,
      revenueMicros: 1_000_000,
      transactions: 1,
      isFinal: true,
      synthetic: false,
      ...shape(back),
    });
  }
  return days;
}

function breakdowns(): GaHealthBreakdownDay[] {
  const days: GaHealthBreakdownDay[] = [];
  for (let back = 35; back >= 1; back -= 1) {
    days.push({
      day: addDays(TODAY, -back),
      country: [{ key: ["Turkey"], values: [100, 60] }],
      source: [{ key: ["google"], values: [100, 60] }],
    });
  }
  return days;
}

function healthy(): GaHealthInputs {
  return {
    now: new Date("2026-10-06T07:00:00.000Z"),
    today: TODAY,
    propertyHour: 10,
    completeThrough: YESTERDAY,
    latestStoredDay: YESTERDAY,
    link: {
      id: "link-1",
      propertyId: "123",
      health: "OK",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      measurementId: "G-ABC123",
      streamUri: "https://www.example.com",
      timeZone: "Europe/Istanbul",
      dataRetention: "FOURTEEN_MONTHS",
      keyEvents: [
        { eventName: "purchase", countingMethod: null },
        { eventName: "generate_lead", countingMethod: null },
      ],
      googleAdsLinks: 1,
      lastDailyDate: TODAY,
      lastDailyAt: new Date("2026-10-06T06:00:00.000Z"),
      credentialStatus: "ACTIVE",
      searchConsoleReport: "on",
    },
    project: { domain: "example.com", timeZone: "Europe/Istanbul" },
    days: history(),
    window28: {
      from: addDays(YESTERDAY, -27),
      to: YESTERDAY,
      coverage: {
        channel: 28,
        source_medium: 28,
        landing_page: 28,
        page: 28,
        events: 28,
        device_country: 28,
      },
      channel: [
        { key: ["Organic Search"], values: [2000, 1200] },
        { key: ["Direct"], values: [800, 400] },
      ],
      sourceMedium: [
        { key: ["google", "organic"], values: [2000, 1200] },
        { key: ["(direct)", "(none)"], values: [800, 400] },
      ],
      landing: [{ key: ["/"], values: [2800] }],
      pages: [{ key: ["/"], values: [7000] }],
      events: [
        { key: ["page_view"], values: [7000, 0] },
        { key: ["scroll"], values: [500, 0] },
      ],
      country: [{ key: ["Turkey"], values: [2800, 1600] }],
    },
    piiMarkers: [],
    breakdowns: breakdowns(),
    quality: [
      {
        reportKey: "landing_page",
        day: YESTERDAY,
        thresholded: false,
        otherRow: false,
      },
      {
        reportKey: "page",
        day: YESTERDAY,
        thresholded: false,
        otherRow: false,
      },
    ],
    suspectDays: [],
    siteTag: {
      v: 1,
      at: "2026-10-01T08:00:00.000Z",
      host: "example.com",
      outcome: "ok",
      pagesChecked: 3,
      pagesFailed: 0,
      pagesWithExpected: 3,
      expectedId: "G-ABC123",
      otherIds: [],
      gtm: false,
      googleTag: false,
      gtagJs: true,
      doubleLoad: false,
      consentDefault: true,
      cmp: null,
      hints: {
        tel: false,
        whatsapp: false,
        mailto: false,
        form: true,
        maps: false,
        checkout: false,
      },
    },
    piiProbe: {
      v: 1,
      at: "2026-10-04T08:00:00.000Z",
      from: "2026-09-28",
      to: "2026-10-03",
      forced: false,
      outcome: "ok",
      pages: 0,
      views: 0,
      params: [],
      email: false,
      phone: false,
    },
    realtime: {
      v: 1,
      day: TODAY,
      zeros: 0,
      checks: 2,
      lastAt: "2026-10-06T06:30:00.000Z",
      lastActive: 4,
      expected: 300,
    },
  };
}

// Her şeyin ters gittiği mülk: veri kesildi, olaylar durdu, PII var, atıf
// bozuk, ayarlar eksik.
function broken(): GaHealthInputs {
  const input = healthy();
  return {
    ...input,
    propertyHour: 22,
    latestStoredDay: addDays(TODAY, -2),
    link: {
      ...input.link,
      timeZone: "America/New_York",
      dataRetention: "TWO_MONTHS",
      googleAdsLinks: 0,
      searchConsoleReport: "off",
      streamUri: "https://other.example.org",
    },
    days: history((back) =>
      back <= 7
        ? { sessions: back === 1 ? 0 : 100, keyEvents: 0, engagementSec: 10 }
        : {},
    ),
    window28: {
      ...input.window28,
      channel: [
        { key: ["Unassigned"], values: [500, 0] },
        { key: ["Organic Search"], values: [500, 0] },
      ],
      sourceMedium: [
        { key: ["google", "cpc"], values: [200, 0] },
        { key: ["Instagram", "Story"], values: [100, 0] },
        { key: ["instagram", "Story"], values: [100, 0] },
        { key: ["example.com", "referral"], values: [100, 0] },
        { key: ["paypal.com", "referral"], values: [100, 0] },
      ],
      landing: [
        { key: ["/"], values: [500] },
        { key: ["(not set)"], values: [500] },
      ],
      events: [{ key: ["page_view"], values: [7000, 0] }],
      country: [{ key: ["Germany"], values: [2800, 0] }],
    },
    piiMarkers: [{ day: YESTERDAY, count: 3 }],
    quality: [
      { reportKey: "page", day: YESTERDAY, thresholded: true, otherRow: true },
    ],
    breakdowns: breakdowns().map((day) =>
      day.day === YESTERDAY
        ? { ...day, source: [{ key: ["spam.example"], values: [500, 0] }] }
        : day,
    ),
    siteTag: {
      ...input.siteTag!,
      pagesWithExpected: 0,
      otherIds: ["G-OTHER"],
      doubleLoad: true,
      consentDefault: false,
    },
    piiProbe: { ...input.piiProbe!, email: true, pages: 1, views: 3 },
    realtime: { ...input.realtime!, zeros: 3, checks: 3 },
  };
}

const CRITICAL_ON_FAIL: ReadonlySet<GaCheckKey> = new Set([
  "MH1",
  "MH1_RT",
  "MH6",
  "MH12",
  "MH24",
]);
const INFO_KEYS: ReadonlySet<GaCheckKey> = new Set([
  "MH2",
  "MH8",
  "MH13",
  "MH14",
  "MH15",
  "MH16",
  "MH17",
  "MH18",
  "MH19",
  "MH23",
]);

function expectedSeverity(result: GaCheckResult): GaCheckSeverity {
  if (result.status === "PASS" || result.status === "UNKNOWN") {
    return gaCheckDef(result.key).defaultSeverity;
  }
  if (result.status === "FAIL" && CRITICAL_ON_FAIL.has(result.key)) {
    return "CRITICAL";
  }
  if (INFO_KEYS.has(result.key)) return "INFO";
  if (result.key === "MH12" && result.evidence.reason === "recent_history") {
    return "INFO";
  }
  return "WARN";
}

function expectContract(results: GaCheckResult[]) {
  expect(results.map((result) => result.key)).toEqual([...GA_CHECK_KEYS]);
  for (const result of results) {
    expect(GA_CHECK_REASONS[result.key]).toContain(result.evidence.reason);
    expect(result.severity).toBe(expectedSeverity(result));
    if (result.days) {
      expect(result.days.length).toBeGreaterThan(0);
      expect(result.days).toEqual([...new Set(result.days)].sort());
    }
  }
}

describe("evaluateGaChecks", () => {
  it("returns 25 results in key order for an empty input without throwing", () => {
    const empty: GaHealthInputs = {
      ...healthy(),
      completeThrough: null,
      latestStoredDay: null,
      link: {
        ...healthy().link,
        measurementId: null,
        streamUri: null,
        timeZone: null,
        dataRetention: null,
        keyEvents: null,
        googleAdsLinks: null,
        lastDailyDate: null,
        lastDailyAt: null,
        searchConsoleReport: "unknown",
      },
      project: { domain: null, timeZone: null },
      days: [],
      window28: {
        from: addDays(YESTERDAY, -27),
        to: YESTERDAY,
        coverage: {},
        channel: [],
        sourceMedium: [],
        landing: [],
        pages: [],
        events: [],
        country: [],
      },
      breakdowns: [],
      quality: [],
      siteTag: null,
      piiProbe: null,
      realtime: null,
    };
    const results = evaluateGaChecks(empty);
    expect(results).toHaveLength(25);
    expectContract(results);
    expect(results.every((result) => result.status === "UNKNOWN")).toBe(true);
  });

  it("passes every check for a healthy property", () => {
    const results = evaluateGaChecks(healthy());
    expectContract(results);
    expect(
      results
        .filter((result) => result.status !== "PASS")
        .map(
          (result) =>
            `${result.key}:${result.status}:${result.evidence.reason}`,
        ),
    ).toEqual([]);
    expect(results.every((result) => result.days === undefined)).toBe(true);
  });

  it("uses the severity map for a broken property", () => {
    const results = evaluateGaChecks(broken());
    expectContract(results);
    const byKey = new Map(results.map((result) => [result.key, result]));
    const verdict = (key: GaCheckKey) => {
      const result = byKey.get(key)!;
      return `${result.status}:${result.severity}:${result.evidence.reason}`;
    };
    expect(verdict("MH1")).toBe("FAIL:CRITICAL:stopped");
    expect(byKey.get("MH1")!.days).toEqual([YESTERDAY]);
    expect(verdict("MH1_RT")).toBe("FAIL:CRITICAL:no_live_visitors");
    expect(verdict("MH2")).toBe("WARN:INFO:late");
    expect(verdict("MH3")).toBe("WARN:WARN:other_id");
    expect(verdict("MH4")).toBe("WARN:WARN:double_load");
    expect(verdict("MH6")).toBe("FAIL:CRITICAL:stopped");
    expect(verdict("MH7")).toBe("WARN:WARN:high_unassigned");
    expect(verdict("MH8")).toBe("WARN:INFO:utm_variants");
    expect(verdict("MH9")).toBe("WARN:WARN:self_referral");
    expect(verdict("MH10")).toBe("WARN:WARN:gateway_referrals");
    expect(verdict("MH11")).toBe("WARN:WARN:not_set_landing");
    expect(verdict("MH12")).toBe("FAIL:CRITICAL:pii_in_url");
    expect(verdict("MH13")).toBe("WARN:INFO:timezone_mismatch");
    expect(verdict("MH14")).toBe("WARN:INFO:two_months");
    expect(verdict("MH15")).toBe("WARN:INFO:ads_not_linked");
    expect(verdict("MH16")).toBe("WARN:INFO:not_linked");
    expect(verdict("MH17")).toBe("WARN:INFO:enhanced_off");
    expect(verdict("MH18")).toBe("WARN:INFO:thresholding");
    expect(verdict("MH19")).toBe("WARN:INFO:other_row");
    expect(verdict("MH20")).toBe("WARN:WARN:bot_wave");
    expect(verdict("MH21")).toBe("WARN:WARN:domain_mismatch");
    expect(verdict("MH22")).toBe("WARN:WARN:no_engagement_time");
    expect(verdict("MH23")).toBe("WARN:INFO:no_consent_default");
    // Bağlantı çalışıyor ama en yeni gün iki gün geride.
    expect(verdict("MH24")).toBe("PASS:CRITICAL:ok");
  });

  it("turns a throwing check into UNKNOWN 'error' and keeps the others", () => {
    const input = healthy();
    const malformed = {
      ...input,
      window28: { ...input.window28, sourceMedium: null },
    } as unknown as GaHealthInputs;
    const results = evaluateGaChecks(malformed);
    expectContract(results);
    const errored = results
      .filter((result) => result.evidence.reason === "error")
      .map((result) => result.key);
    expect(errored).toEqual(["MH8", "MH9", "MH10", "MH15"]);
    expect(results.find((result) => result.key === "MH1")!.status).toBe("PASS");
  });
});

describe("evaluateGaRealtimeCheck", () => {
  it("equals the MH1_RT row of the full evaluation", () => {
    for (const input of [healthy(), broken()]) {
      const row = evaluateGaChecks(input).find(
        (result) => result.key === "MH1_RT",
      );
      expect(
        evaluateGaRealtimeCheck({
          today: input.today,
          realtime: input.realtime,
        }),
      ).toEqual(row);
    }
    expect(
      evaluateGaRealtimeCheck({ today: TODAY, realtime: null }).evidence.reason,
    ).toBe("not_checked");
  });
});
