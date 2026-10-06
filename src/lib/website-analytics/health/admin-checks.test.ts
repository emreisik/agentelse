import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";

import {
  checkMH13,
  checkMH14,
  checkMH15,
  checkMH2,
  checkMH21,
  checkMH24,
  checkMH5,
  tzOffsetMinutes,
} from "./admin-checks";
import { GA_CHECK_REASONS, gaCheckDef } from "./registry";
import type {
  GaCheckResult,
  GaHealthDay,
  GaHealthInputs,
  GaSiteHints,
} from "./types";

// Bu dosyanın kanıtladığı (GA-F3 yönetim ve entegrasyon kontrolleri): MH2
// 21:00 sınırı ve dün; MH5 anahtar olaylar ve ipucu önerileri; MH13 adlar
// değil UTC farkları; MH14; MH15 google/cpc vekili; MH21 alan adı/alt alan
// adı; MH24 her sağlık değeri, kimlik bilgisi ve öğlen gecikme sınırı. Her
// sonucun nedeni GA_CHECK_REASONS'ta.

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

const NO_HINTS: GaSiteHints = {
  tel: false,
  whatsapp: false,
  mailto: false,
  form: false,
  maps: false,
  checkout: false,
};

function inputs(
  overrides: Partial<GaHealthInputs> = {},
  link: Partial<GaHealthInputs["link"]> = {},
): GaHealthInputs {
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
      ...link,
    },
    project: { domain: "example.com", timeZone: "Europe/Istanbul" },
    days: [day(addDays(TODAY, -2)), day(YESTERDAY)],
    window28: {
      from: addDays(YESTERDAY, -27),
      to: YESTERDAY,
      coverage: {},
      channel: [],
      sourceMedium: [{ key: ["google", "organic"], values: [2000, 1200] }],
      landing: [],
      pages: [],
      events: [],
      country: [],
    },
    piiMarkers: [],
    breakdowns: [],
    quality: [],
    suspectDays: [],
    siteTag: null,
    piiProbe: null,
    realtime: null,
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

describe("MH2 yesterday's data is in", () => {
  it("warns only from 21:00 when the newest stored day is older than yesterday", () => {
    const late = { latestStoredDay: addDays(TODAY, -2) };
    expect(
      verdict(checkMH2(inputs({ ...late, propertyHour: 20 }), "PASS")),
    ).toBe("PASS:INFO:ok");
    const result = checkMH2(inputs({ ...late, propertyHour: 21 }), "PASS");
    expect(verdict(result)).toBe("WARN:INFO:late");
    expect(result.evidence).toMatchObject({
      expectedDay: YESTERDAY,
      latestDay: addDays(TODAY, -2),
    });
    expect(verdict(checkMH2(inputs({ propertyHour: 23 }), "PASS"))).toBe(
      "PASS:INFO:ok",
    );
  });

  it("leaves a broken connection to MH24", () => {
    expect(verdict(checkMH2(inputs({ propertyHour: 23 }), "FAIL"))).toBe(
      "UNKNOWN:INFO:not_checked",
    );
  });
});

describe("MH5 key events are set up", () => {
  it("is unknown before metadata is read and warns without key events", () => {
    expect(verdict(checkMH5(inputs({}, { keyEvents: null })))).toBe(
      "UNKNOWN:WARN:not_read",
    );
    expect(verdict(checkMH5(inputs({}, { keyEvents: [] })))).toBe(
      "WARN:WARN:no_key_events",
    );
  });

  it("flags purchase-only setups without any sales", () => {
    const purchase = [{ eventName: "purchase", countingMethod: null }];
    expect(verdict(checkMH5(inputs({}, { keyEvents: purchase })))).toBe(
      "WARN:WARN:only_purchase",
    );
    const withSales = inputs(
      { days: [day(YESTERDAY, { revenueMicros: 5_000_000, transactions: 1 })] },
      { keyEvents: purchase },
    );
    expect(verdict(checkMH5(withSales))).toBe("PASS:WARN:ok");
  });

  it("suggests key events from site hints minus the defined ones", () => {
    const result = checkMH5(
      inputs(
        {
          siteTag: {
            v: 1,
            at: "2026-10-01T08:00:00.000Z",
            host: "example.com",
            outcome: "ok",
            pagesChecked: 2,
            pagesFailed: 0,
            pagesWithExpected: 2,
            expectedId: "G-ABC123",
            otherIds: [],
            gtm: false,
            googleTag: false,
            gtagJs: true,
            doubleLoad: false,
            consentDefault: false,
            cmp: null,
            hints: { ...NO_HINTS, tel: true, form: true, whatsapp: true },
          },
        },
        {
          keyEvents: [
            { eventName: "generate_lead", countingMethod: null },
            { eventName: "generate_lead", countingMethod: "ONCE_PER_SESSION" },
          ],
        },
      ),
    );
    expect(verdict(result)).toBe("PASS:WARN:ok");
    expect(result.evidence).toMatchObject({
      count: 1,
      names: ["generate_lead"],
      suggestions: ["click_to_call", "whatsapp_click"],
    });
  });
});

describe("MH13 time zone", () => {
  it("compares offsets, not names", () => {
    expect(
      tzOffsetMinutes("Europe/Istanbul", new Date("2026-10-06T07:00:00Z")),
    ).toBe(180);
    expect(verdict(checkMH13(inputs({}, { timeZone: "Asia/Riyadh" })))).toBe(
      "PASS:INFO:ok",
    );
    const result = checkMH13(inputs({}, { timeZone: "America/New_York" }));
    expect(verdict(result)).toBe("WARN:INFO:timezone_mismatch");
    expect(result.evidence).toMatchObject({
      propertyTimeZone: "America/New_York",
      projectTimeZone: "Europe/Istanbul",
    });
  });

  it("is unknown without both zones or with an invalid one", () => {
    expect(
      verdict(checkMH13(inputs({ project: { domain: null, timeZone: null } }))),
    ).toBe("UNKNOWN:INFO:no_project_tz");
    expect(verdict(checkMH13(inputs({}, { timeZone: null })))).toBe(
      "UNKNOWN:INFO:not_read",
    );
    expect(verdict(checkMH13(inputs({}, { timeZone: "Mars/Olympus" })))).toBe(
      "UNKNOWN:INFO:invalid_tz",
    );
  });
});

describe("MH14 data retention", () => {
  it("flags two months only", () => {
    expect(verdict(checkMH14(inputs({}, { dataRetention: null })))).toBe(
      "UNKNOWN:INFO:not_read",
    );
    expect(
      verdict(checkMH14(inputs({}, { dataRetention: "TWO_MONTHS" }))),
    ).toBe("WARN:INFO:two_months");
    expect(verdict(checkMH14(inputs()))).toBe("PASS:INFO:ok");
  });
});

describe("MH15 Google Ads link", () => {
  const paid = (sessions: number, links: number | null) =>
    inputs(
      {
        window28: {
          ...inputs().window28,
          sourceMedium: [
            { key: ["google", "cpc"], values: [sessions, 0] },
            { key: ["google", "organic"], values: [1000, 0] },
          ],
        },
      },
      { googleAdsLinks: links },
    );

  it("uses google / cpc sessions as the proxy", () => {
    expect(verdict(checkMH15(paid(10, null)))).toBe("UNKNOWN:INFO:not_read");
    const result = checkMH15(paid(10, 0));
    expect(verdict(result)).toBe("WARN:INFO:ads_not_linked");
    expect(result.evidence.paidSessions).toBe(10);
    expect(verdict(checkMH15(paid(9, 0)))).toBe("PASS:INFO:no_paid_search");
    expect(verdict(checkMH15(paid(10, 1)))).toBe("PASS:INFO:ok");
  });
});

describe("MH21 property matches the website", () => {
  const match = (domain: string | null, streamUri: string | null) =>
    checkMH21(inputs({ project: { domain, timeZone: null } }, { streamUri }));

  it("accepts the same host and subdomains either way", () => {
    expect(verdict(match("example.com", "https://www.example.com/"))).toBe(
      "PASS:WARN:ok",
    );
    expect(verdict(match("example.com", "https://shop.example.com"))).toBe(
      "PASS:WARN:ok",
    );
    expect(verdict(match("shop.example.com", "example.com"))).toBe(
      "PASS:WARN:ok",
    );
    const result = match("example.com", "https://notexample.com");
    expect(verdict(result)).toBe("WARN:WARN:domain_mismatch");
    expect(result.evidence).toMatchObject({
      streamHost: "notexample.com",
      projectDomain: "example.com",
    });
  });

  it("needs a valid project domain and a stream", () => {
    expect(verdict(match(null, "https://example.com"))).toBe(
      "UNKNOWN:WARN:no_domain",
    );
    expect(verdict(match("not a domain", "https://example.com"))).toBe(
      "UNKNOWN:WARN:no_domain",
    );
    expect(verdict(match("example.com", null))).toBe("UNKNOWN:WARN:no_stream");
  });
});

describe("MH24 connection health", () => {
  it("fails critically on every broken health and on the credential", () => {
    for (const health of [
      "AUTH",
      "NEEDS_PERMISSION",
      "ACCESS_LOST",
      "GONE",
      "API_DISABLED",
    ]) {
      expect(verdict(checkMH24(inputs({}, { health })))).toBe(
        `FAIL:CRITICAL:${health.toLowerCase()}`,
      );
    }
    for (const credentialStatus of ["REVOKED", "MISSING", "EXPIRED"]) {
      expect(verdict(checkMH24(inputs({}, { credentialStatus })))).toBe(
        "FAIL:CRITICAL:credential",
      );
    }
    expect(verdict(checkMH24(inputs({}, { health: "DEGRADED" })))).toBe(
      "WARN:WARN:sync_failing",
    );
    expect(verdict(checkMH24(inputs()))).toBe("PASS:CRITICAL:ok");
    expect(verdict(checkMH24(inputs({}, { health: "UNKNOWN" })))).toBe(
      "PASS:CRITICAL:ok",
    );
  });

  it("is unknown without data and late from noon", () => {
    expect(verdict(checkMH24(inputs({ latestStoredDay: null })))).toBe(
      "UNKNOWN:CRITICAL:no_data",
    );
    const old = { latestStoredDay: addDays(TODAY, -3) };
    expect(verdict(checkMH24(inputs({ ...old, propertyHour: 11 })))).toBe(
      "PASS:CRITICAL:ok",
    );
    const result = checkMH24(inputs({ ...old, propertyHour: 12 }));
    expect(verdict(result)).toBe("WARN:WARN:sync_late");
    expect(result.evidence.latestDay).toBe(addDays(TODAY, -3));
    expect(
      verdict(
        checkMH24(
          inputs({ latestStoredDay: addDays(TODAY, -2), propertyHour: 23 }),
        ),
      ),
    ).toBe("PASS:CRITICAL:ok");
  });
});
