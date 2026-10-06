import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import {
  checkMH1,
  checkMH10,
  checkMH11,
  checkMH12,
  checkMH16,
  checkMH17,
  checkMH18,
  checkMH19,
  checkMH1Realtime,
  checkMH20,
  checkMH22,
  checkMH4,
  checkMH6,
  checkMH7,
  checkMH8,
  checkMH9,
} from "./data-checks";
import { GA_CHECK_REASONS, gaCheckDef } from "./registry";
import type {
  GaCheckResult,
  GaHealthBreakdownDay,
  GaHealthDay,
  GaHealthInputs,
  GaPiiProbeResult,
  GaSiteTagResult,
} from "./types";

// Bu dosyanın kanıtladığı (GA-F3 veri kontrolleri): MH1 gün/hafta kipi ve
// eşikleri, yarım dünün yargılanmaması, sentetik sıfır dünün kritik olması;
// MH1_RT; MH4 çift sayım sınırları; MH6 durma/çift tetik; atıf
// kontrollerinin kapsam ve hacim kapıları ile pay sınırları; MH12 PII
// yoklaması ve maskeleri (kanıtta asla yol yok); MH16–MH19; MH20 sıçrama
// eşikleri; MH22 bir saniye sınırı. Her sonucun nedeni GA_CHECK_REASONS'ta.

const TODAY = "2026-10-06";
const YESTERDAY = "2026-10-05";

function day(
  dayKey: string,
  overrides: Partial<GaHealthDay> = {},
): GaHealthDay {
  return {
    day: dayKey,
    sessions: 100,
    engagedSessions: 60,
    engagementSec: 6000,
    screenPageViews: 250,
    keyEvents: 5,
    revenueMicros: 0,
    transactions: 0,
    isFinal: true,
    synthetic: false,
    ...overrides,
  };
}

// [today-70, today-1]; `back` dünden geriye gün sayısı (1 = dün).
function history(
  shape: (back: number, dayKey: string) => Partial<GaHealthDay> = () => ({}),
): GaHealthDay[] {
  const days: GaHealthDay[] = [];
  for (let back = 70; back >= 1; back -= 1) {
    const dayKey = addDays(TODAY, -back);
    days.push(day(dayKey, shape(back, dayKey)));
  }
  return days;
}

function breakdowns(
  shape: (
    back: number,
  ) => Partial<Omit<GaHealthBreakdownDay, "day">> = () => ({}),
): GaHealthBreakdownDay[] {
  const days: GaHealthBreakdownDay[] = [];
  for (let back = 35; back >= 1; back -= 1) {
    days.push({
      day: addDays(TODAY, -back),
      country: [{ key: ["Turkey"], values: [100, 60] }],
      source: [{ key: ["google"], values: [100, 60] }],
      ...shape(back),
    });
  }
  return days;
}

function probe(overrides: Partial<GaPiiProbeResult> = {}): GaPiiProbeResult {
  return {
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
    ...overrides,
  };
}

function siteTag(overrides: Partial<GaSiteTagResult> = {}): GaSiteTagResult {
  return {
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
      form: false,
      maps: false,
      checkout: false,
    },
    ...overrides,
  };
}

function inputs(overrides: Partial<GaHealthInputs> = {}): GaHealthInputs {
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
      keyEvents: [{ eventName: "generate_lead", countingMethod: null }],
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
    ],
    suspectDays: [],
    siteTag: siteTag(),
    piiProbe: probe(),
    realtime: null,
    ...overrides,
  };
}

function window28(
  overrides: Partial<GaHealthInputs["window28"]>,
): GaHealthInputs["window28"] {
  return { ...inputs().window28, ...overrides };
}

// Durum, önem ve neden; neden sözleşmedeki listede olmalı.
function verdict(result: GaCheckResult) {
  const reason = String(result.evidence.reason);
  expect(GA_CHECK_REASONS[result.key]).toContain(reason);
  if (result.status === "PASS" || result.status === "UNKNOWN") {
    expect(result.severity).toBe(gaCheckDef(result.key).defaultSeverity);
  }
  return `${result.status}:${result.severity}:${reason}`;
}

describe("MH1 data is arriving", () => {
  // Her gün 20 oturum; dün `last` oturum.
  const withYesterday = (base: number, last: number) =>
    inputs({
      days: history((back) => ({ sessions: back === 1 ? last : base })),
    });

  it("judges the ratio against the same-weekday median at 0.10 and 0.50", () => {
    expect(verdict(checkMH1(withYesterday(20, 1.998)))).toBe(
      "FAIL:CRITICAL:stopped",
    );
    expect(verdict(checkMH1(withYesterday(20, 2)))).toBe("WARN:WARN:dropped");
    expect(verdict(checkMH1(withYesterday(20, 9.998)))).toBe(
      "WARN:WARN:dropped",
    );
    expect(verdict(checkMH1(withYesterday(20, 10)))).toBe("PASS:CRITICAL:ok");
    const fail = checkMH1(withYesterday(20, 1.998));
    expect(fail.days).toEqual([YESTERDAY]);
    expect(fail.evidence).toMatchObject({
      mode: "day",
      day: YESTERDAY,
      expected: 20,
      synthetic: false,
    });
  });

  it("falls back to week mode when every median is below 20", () => {
    const result = checkMH1(withYesterday(19, 1));
    expect(verdict(result)).toBe("PASS:CRITICAL:ok");
    expect(result.evidence).toMatchObject({ mode: "week", expected: 133 });

    const stopped = checkMH1(
      inputs({ days: history((back) => ({ sessions: back <= 7 ? 0 : 19 })) }),
    );
    expect(verdict(stopped)).toBe("FAIL:CRITICAL:stopped");
    expect(stopped.evidence.mode).toBe("week");
    expect(stopped.days).toHaveLength(7);

    expect(verdict(checkMH1(withYesterday(2, 2)))).toBe(
      "UNKNOWN:CRITICAL:low_volume",
    );
  });

  it("is unknown without data, before the first complete day and when the sync is late", () => {
    expect(verdict(checkMH1(inputs({ days: [] })))).toBe(
      "UNKNOWN:CRITICAL:no_data",
    );
    expect(verdict(checkMH1(inputs({ completeThrough: null })))).toBe(
      "UNKNOWN:CRITICAL:not_ready",
    );
    expect(
      verdict(checkMH1(inputs({ completeThrough: addDays(TODAY, -4) }))),
    ).toBe("UNKNOWN:CRITICAL:sync_late");
  });

  it("never judges a partial yesterday beyond completeThrough", () => {
    const result = checkMH1(
      inputs({
        completeThrough: addDays(TODAY, -2),
        days: history((back) => ({ sessions: back === 1 ? 3 : 100 })),
      }),
    );
    expect(verdict(result)).toBe("PASS:CRITICAL:ok");
    expect(result.evidence.day).toBe(addDays(TODAY, -2));
  });

  it("turns a synthetic zero yesterday critical", () => {
    const result = checkMH1(
      inputs({
        days: history((back) =>
          back === 1
            ? { sessions: 0, engagedSessions: 0, synthetic: true }
            : {},
        ),
      }),
    );
    expect(verdict(result)).toBe("FAIL:CRITICAL:stopped");
    expect(result.days).toEqual([YESTERDAY]);
    expect(result.evidence.synthetic).toBe(true);
  });

  it("leaves stored suspect days out of the baseline", () => {
    // Dünün önceki dört eşi sıfır ama şüpheli: medyanı düşürmez.
    const zeros = [8, 15, 22, 29];
    const days = history((back) => ({
      sessions: zeros.includes(back) ? 0 : 100,
    }));
    const suspectDays = zeros.map((back) => addDays(TODAY, -back));
    expect(checkMH1(inputs({ days })).evidence.expected).toBe(50);
    expect(checkMH1(inputs({ days, suspectDays })).evidence.expected).toBe(100);
  });
});

describe("MH1_RT live visitors today", () => {
  const realtime = (zeros: number, dayKey = TODAY) => ({
    v: 1 as const,
    day: dayKey,
    zeros,
    checks: 3,
    lastAt: "2026-10-06T09:00:00.000Z",
    lastActive: 0,
    expected: 300,
  });

  it("fails after three zero readings on the same property day", () => {
    expect(
      verdict(checkMH1Realtime({ today: TODAY, realtime: realtime(2) })),
    ).toBe("PASS:CRITICAL:ok");
    const fail = checkMH1Realtime({ today: TODAY, realtime: realtime(3) });
    expect(verdict(fail)).toBe("FAIL:CRITICAL:no_live_visitors");
    expect(fail.evidence).toMatchObject({ zeros: 3, checks: 3 });
  });

  it("is unknown on a new property day or without readings", () => {
    expect(
      verdict(
        checkMH1Realtime({ today: TODAY, realtime: realtime(3, YESTERDAY) }),
      ),
    ).toBe("UNKNOWN:CRITICAL:not_checked");
    expect(verdict(checkMH1Realtime({ today: TODAY, realtime: null }))).toBe(
      "UNKNOWN:CRITICAL:not_checked",
    );
  });
});

describe("MH4 double counting from data", () => {
  // Geçmiş: oturum başına 2 görüntüleme; son 7 gün `views` ve `engaged`.
  const doubled = (views: number, engaged: number) =>
    inputs({
      siteTag: null,
      days: history((back) =>
        back <= 7
          ? { sessions: 100, screenPageViews: views, engagedSessions: engaged }
          : { sessions: 100, screenPageViews: 200 },
      ),
    });

  it("warns at twice the baseline with more than 95% engagement", () => {
    const result = checkMH4(doubled(400, 96));
    expect(verdict(result)).toBe("WARN:WARN:double_count_data");
    expect(result.days).toHaveLength(7);
    expect(result.evidence).toMatchObject({
      viewsPerSession: 4,
      baselineViewsPerSession: 2,
      engagementRate: 0.96,
    });
    expect(verdict(checkMH4(doubled(399, 96)))).toBe("PASS:WARN:ok");
    expect(verdict(checkMH4(doubled(400, 95)))).toBe("PASS:WARN:ok");
  });

  it("is unknown when neither data nor the site can be judged", () => {
    expect(
      verdict(checkMH4(inputs({ completeThrough: null, siteTag: null }))),
    ).toBe("UNKNOWN:WARN:not_ready");
    expect(
      verdict(
        checkMH4(
          inputs({ siteTag: null, days: history(() => ({ sessions: 5 })) }),
        ),
      ),
    ).toBe("UNKNOWN:WARN:low_volume");
  });
});

describe("MH6 key events are arriving", () => {
  it("fails when key events stop while sessions continue", () => {
    const result = checkMH6(
      inputs({ days: history((back) => ({ keyEvents: back <= 7 ? 0 : 5 })) }),
    );
    expect(verdict(result)).toBe("FAIL:CRITICAL:stopped");
    expect(result.days).toHaveLength(7);
    expect(result.evidence).toMatchObject({ last7: 0, dailyBaseline: 5 });
  });

  it("passes a steady flow", () => {
    expect(verdict(checkMH6(inputs()))).toBe("PASS:CRITICAL:ok");
  });

  it("warns about double firing", () => {
    const result = checkMH6(
      inputs({
        days: history((back) => ({
          keyEvents: back <= 7 ? (back <= 3 ? 250 : 5) : 5,
        })),
      }),
    );
    expect(verdict(result)).toBe("WARN:WARN:double_fire");
    expect(result.days).toEqual([
      addDays(TODAY, -3),
      addDays(TODAY, -2),
      YESTERDAY,
    ]);
  });

  it("needs key events and history", () => {
    const noEvents = inputs();
    noEvents.link.keyEvents = [];
    expect(verdict(checkMH6(noEvents))).toBe("UNKNOWN:CRITICAL:no_key_events");
    expect(verdict(checkMH6(inputs({ days: history().slice(-20) })))).toBe(
      "UNKNOWN:CRITICAL:low_history",
    );
    expect(verdict(checkMH6(inputs({ completeThrough: null })))).toBe(
      "UNKNOWN:CRITICAL:not_ready",
    );
  });
});

describe("MH7 unassigned share", () => {
  const channel = (unassigned: number, total: number) =>
    window28({
      channel: [
        { key: ["Unassigned"], values: [unassigned, 0] },
        { key: ["Organic Search"], values: [total - unassigned, 0] },
      ],
      sourceMedium: [
        { key: ["newsletter", "Email"], values: [40, 0] },
        { key: ["(not set)", "(not set)"], values: [20, 0] },
        { key: ["google", "organic"], values: [900, 0] },
      ],
    });

  it("warns above 5%", () => {
    expect(verdict(checkMH7(inputs({ window28: channel(10, 200) })))).toBe(
      "PASS:WARN:ok",
    );
    const result = checkMH7(inputs({ window28: channel(501, 10_000) }));
    expect(verdict(result)).toBe("WARN:WARN:high_unassigned");
    expect(result.evidence).toMatchObject({
      share: 0.05,
      sessions: 501,
      pairs: ["newsletter / Email", "(not set) / (not set)"],
    });
  });

  it("needs 200 sessions and 21 days of coverage", () => {
    expect(verdict(checkMH7(inputs({ window28: channel(100, 199) })))).toBe(
      "UNKNOWN:WARN:low_volume",
    );
    const thin = channel(100, 1000);
    thin.coverage = { ...thin.coverage, channel: 20 };
    expect(verdict(checkMH7(inputs({ window28: thin })))).toBe(
      "UNKNOWN:WARN:low_volume",
    );
  });
});

describe("MH8 UTM variants", () => {
  it("lists case-only spellings and non-standard mediums", () => {
    const result = checkMH8(
      inputs({
        window28: window28({
          sourceMedium: [
            { key: ["Instagram", "social"], values: [40, 0] },
            { key: ["instagram", "social"], values: [30, 0] },
            { key: ["newsletter", "Email"], values: [10, 0] },
          ],
        }),
      }),
    );
    expect(verdict(result)).toBe("WARN:INFO:utm_variants");
    expect(result.evidence.variants).toEqual(["Instagram / instagram"]);
    expect(result.evidence.mediums).toEqual(["Email"]);
    expect(verdict(checkMH8(inputs()))).toBe("PASS:INFO:ok");
  });

  it("is gated by coverage and volume", () => {
    const thin = window28({});
    thin.coverage = { ...thin.coverage, source_medium: 20 };
    expect(verdict(checkMH8(inputs({ window28: thin })))).toBe(
      "UNKNOWN:INFO:low_volume",
    );
    expect(
      verdict(
        checkMH8(
          inputs({
            window28: window28({
              sourceMedium: [{ key: ["google", "organic"], values: [49, 0] }],
            }),
          }),
        ),
      ),
    ).toBe("UNKNOWN:INFO:low_volume");
  });
});

describe("MH9 self-referrals", () => {
  const referrals = (source: string, sessions: number) =>
    window28({
      sourceMedium: [
        { key: [source, "referral"], values: [sessions, 0] },
        { key: ["google", "organic"], values: [1000 - sessions, 0] },
      ],
    });

  it("warns above 2% and counts subdomains", () => {
    expect(
      verdict(checkMH9(inputs({ window28: referrals("example.com", 20) }))),
    ).toBe("PASS:WARN:ok");
    const result = checkMH9(
      inputs({ window28: referrals("shop.example.com", 21) }),
    );
    expect(verdict(result)).toBe("WARN:WARN:self_referral");
    expect(result.evidence).toMatchObject({
      share: 0.021,
      sessions: 21,
      domain: "example.com",
    });
  });

  it("falls back to the stream host and needs a domain", () => {
    const fromStream = inputs({
      project: { domain: null, timeZone: null },
      window28: referrals("www.example.com", 50),
    });
    expect(verdict(checkMH9(fromStream))).toBe("WARN:WARN:self_referral");
    const none = inputs({ project: { domain: null, timeZone: null } });
    none.link.streamUri = null;
    expect(verdict(checkMH9(none))).toBe("UNKNOWN:WARN:no_domain");
  });
});

describe("MH10 payment-page referrals", () => {
  const gateway = (sessions: number) =>
    window28({
      sourceMedium: [
        { key: ["paypal.com", "referral"], values: [sessions, 0] },
        { key: ["google", "organic"], values: [1000 - sessions, 0] },
      ],
    });

  it("warns above 0.5%", () => {
    expect(verdict(checkMH10(inputs({ window28: gateway(5) })))).toBe(
      "PASS:WARN:ok",
    );
    const result = checkMH10(inputs({ window28: gateway(6) }));
    expect(verdict(result)).toBe("WARN:WARN:gateway_referrals");
    expect(result.evidence.sources).toEqual(["paypal.com"]);
  });
});

describe("MH11 landing page (not set)", () => {
  it("divides by the landing table's own total", () => {
    const result = checkMH11(
      inputs({
        days: history(() => ({ sessions: 10_000 })),
        window28: window28({
          landing: [
            { key: ["/"], values: [900] },
            { key: ["(not set)"], values: [100] },
          ],
        }),
      }),
    );
    expect(verdict(result)).toBe("WARN:WARN:not_set_landing");
    expect(result.evidence).toMatchObject({ share: 0.1, sessions: 100 });
    expect(
      verdict(
        checkMH11(
          inputs({
            window28: window28({
              landing: [
                { key: ["/"], values: [950] },
                { key: ["(not set)"], values: [50] },
              ],
            }),
          }),
        ),
      ),
    ).toBe("PASS:WARN:ok");
  });
});

describe("MH12 personal data in page addresses", () => {
  const results: GaCheckResult[] = [];
  const run = (input: GaHealthInputs) => {
    const result = checkMH12(input);
    results.push(result);
    return result;
  };

  it("fails on a probe hit with only names and counts", () => {
    const result = run(
      inputs({
        piiProbe: probe({ params: ["email"], pages: 2, views: 9, email: true }),
      }),
    );
    expect(verdict(result)).toBe("FAIL:CRITICAL:pii_in_url");
    expect(result.evidence).toMatchObject({
      params: ["email"],
      pages: 2,
      views: 9,
      email: true,
      phone: false,
      probeFrom: "2026-09-28",
      probeTo: "2026-10-03",
    });
  });

  it("ignores markers older than the last 7 complete days", () => {
    const result = run(
      inputs({ piiMarkers: [{ day: addDays(YESTERDAY, -8), count: 4 }] }),
    );
    expect(verdict(result)).toBe("PASS:CRITICAL:ok");
  });

  it("downgrades recent markers after a clean probe that started later", () => {
    const result = run(
      inputs({
        piiMarkers: [
          { day: addDays(YESTERDAY, -3), count: 2 },
          { day: addDays(YESTERDAY, -2), count: 1 },
        ],
        piiProbe: probe({
          from: addDays(YESTERDAY, -1),
          to: TODAY,
          forced: true,
        }),
      }),
    );
    expect(verdict(result)).toBe("WARN:INFO:recent_history");
    expect(result.evidence.markerDays).toBe(2);
  });

  it("fails on recent markers when the clean probe is older", () => {
    const result = run(
      inputs({
        piiMarkers: [{ day: addDays(YESTERDAY, -2), count: 1 }],
        piiProbe: probe({ from: addDays(YESTERDAY, -6) }),
      }),
    );
    expect(verdict(result)).toBe("FAIL:CRITICAL:pii_in_path");
    expect(
      verdict(
        run(
          inputs({
            piiMarkers: [{ day: YESTERDAY, count: 1 }],
            piiProbe: probe({ outcome: "error" }),
          }),
        ),
      ),
    ).toBe("FAIL:CRITICAL:pii_in_path");
  });

  it("is unknown without an ok probe", () => {
    expect(verdict(run(inputs({ piiProbe: null })))).toBe(
      "UNKNOWN:CRITICAL:not_checked",
    );
    expect(
      verdict(run(inputs({ piiProbe: probe({ outcome: "error" }) }))),
    ).toBe("UNKNOWN:CRITICAL:not_checked");
  });

  it("never puts a path in the evidence", () => {
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(JSON.stringify(result.evidence)).not.toMatch(/\//);
    }
  });
});

describe("MH16–MH19 catalog and slice quality", () => {
  it("MH16 follows the catalog state", () => {
    const off = inputs();
    off.link.searchConsoleReport = "off";
    const unknown = inputs();
    unknown.link.searchConsoleReport = "unknown";
    expect(verdict(checkMH16(inputs()))).toBe("PASS:INFO:ok");
    expect(verdict(checkMH16(off))).toBe("WARN:INFO:not_linked");
    expect(verdict(checkMH16(unknown))).toBe("UNKNOWN:INFO:catalog_off");
  });

  it("MH17 looks for enhanced measurement events", () => {
    const result = checkMH17(inputs());
    expect(verdict(result)).toBe("PASS:INFO:ok");
    expect(result.evidence.seen).toEqual(["scroll"]);
    const pageViewsOnly = window28({
      events: [{ key: ["page_view"], values: [7000, 0] }],
    });
    expect(verdict(checkMH17(inputs({ window28: pageViewsOnly })))).toBe(
      "WARN:INFO:enhanced_off",
    );
    expect(
      verdict(
        checkMH17(
          inputs({
            window28: pageViewsOnly,
            days: history(() => ({ sessions: 5 })),
          }),
        ),
      ),
    ).toBe("UNKNOWN:INFO:low_volume");
  });

  it("MH18 judges the share of thresholded report keys", () => {
    const quality = (thresholdedKeys: number) =>
      ["a", "b", "c", "d", "e"].flatMap((reportKey, index) => [
        { reportKey, day: YESTERDAY, thresholded: false, otherRow: false },
        {
          reportKey,
          day: addDays(YESTERDAY, -1),
          thresholded: index < thresholdedKeys,
          otherRow: false,
        },
      ]);
    expect(verdict(checkMH18(inputs({ quality: quality(1) })))).toBe(
      "PASS:INFO:ok",
    );
    const result = checkMH18(inputs({ quality: quality(2) }));
    expect(verdict(result)).toBe("WARN:INFO:thresholding");
    expect(result.evidence).toMatchObject({ share: 0.4, reports: ["a", "b"] });
    expect(verdict(checkMH18(inputs({ quality: [] })))).toBe(
      "UNKNOWN:INFO:no_data",
    );
  });

  it("MH19 lists report keys with an (other) row", () => {
    const result = checkMH19(
      inputs({
        quality: [
          {
            reportKey: "page",
            day: YESTERDAY,
            thresholded: false,
            otherRow: true,
          },
          {
            reportKey: "page",
            day: TODAY,
            thresholded: false,
            otherRow: false,
          },
          {
            reportKey: "events",
            day: YESTERDAY,
            thresholded: false,
            otherRow: false,
          },
        ],
      }),
    );
    expect(verdict(result)).toBe("WARN:INFO:other_row");
    expect(result.evidence.reports).toEqual(["page"]);
    expect(verdict(checkMH19(inputs()))).toBe("PASS:INFO:ok");
    expect(verdict(checkMH19(inputs({ quality: [] })))).toBe(
      "UNKNOWN:INFO:no_data",
    );
  });
});

describe("MH20 bot waves", () => {
  // Dün Türkiye'de `sessions` oturum, `engaged` etkileşimli; taban 100/gün.
  const spike = (sessions: number, engaged: number) =>
    inputs({
      breakdowns: breakdowns((back) =>
        back === 1
          ? { country: [{ key: ["Turkey"], values: [sessions, engaged] }] }
          : {},
      ),
    });

  it("needs three times the baseline and under 5% engagement", () => {
    const result = checkMH20(spike(300, 14.7));
    expect(verdict(result)).toBe("WARN:WARN:bot_wave");
    expect(result.days).toEqual([YESTERDAY]);
    expect(result.evidence).toMatchObject({
      dimension: "country",
      label: "Turkey",
      spikeDays: 1,
      sessions: 300,
    });
    expect(verdict(checkMH20(spike(300, 15)))).toBe("PASS:WARN:ok");
    expect(verdict(checkMH20(spike(299, 0)))).toBe("PASS:WARN:ok");
  });

  it("applies the 30-session floor to a new key", () => {
    const newKey = (sessions: number) =>
      inputs({
        breakdowns: breakdowns((back) =>
          back === 2
            ? {
                source: [
                  { key: ["google"], values: [100, 60] },
                  { key: ["spam.example"], values: [sessions, 0] },
                ],
              }
            : {},
        ),
      });
    expect(verdict(checkMH20(newKey(29)))).toBe("PASS:WARN:ok");
    const result = checkMH20(newKey(30));
    expect(verdict(result)).toBe("WARN:WARN:bot_wave");
    expect(result.evidence).toMatchObject({
      dimension: "source",
      label: "spam.example",
    });
    expect(result.days).toEqual([addDays(TODAY, -2)]);
  });

  it("needs 14 complete breakdown days", () => {
    expect(
      verdict(checkMH20(inputs({ breakdowns: breakdowns().slice(-13) }))),
    ).toBe("UNKNOWN:WARN:low_history");
  });
});

describe("MH22 engagement time", () => {
  it("warns below one second per session", () => {
    const seconds = (value: number) =>
      inputs({
        days: history(() => ({ sessions: 100, engagementSec: value })),
      });
    expect(verdict(checkMH22(seconds(100)))).toBe("PASS:WARN:ok");
    const result = checkMH22(seconds(99.9));
    expect(verdict(result)).toBe("WARN:WARN:no_engagement_time");
    expect(result.evidence.secondsPerSession).toBe(0.999);
    expect(verdict(checkMH22(inputs({ completeThrough: null })))).toBe(
      "UNKNOWN:WARN:not_ready",
    );
    expect(
      verdict(checkMH22(inputs({ days: history(() => ({ sessions: 7 })) }))),
    ).toBe("UNKNOWN:WARN:low_volume");
  });
});
