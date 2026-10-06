import { describe, expect, it } from "vitest";

import {
  gaCatalogCheckDue,
  gaDisabledReports,
  gaOptionalReportEnabled,
  parseGaCatalogState,
  serializeGaCatalogState,
  withDisabledReport,
  type GaCatalogState,
} from "./catalog-state";

// Bu dosyanın kanıtladığı: bugünkü düz katalog (v1) okunmaya devam eder;
// v2'ye eski bir sürümün eklediği düz anahtar da düşmüş sayılır (geri dönüş
// güvenliği); rapor düşürmek saklanan biçimi değiştirmez (bayrak kapalıyken
// JSON v1 kalır); isteğe bağlı raporlar varsayılan kapalıdır; haftalık
// denetim 7 günde, hatalı denetim 24 saatte bir yeniden çalışır.

const AT = "2026-10-01T10:00:00.000Z";

function v2(overrides: Partial<GaCatalogState> = {}): Record<string, unknown> {
  return serializeGaCatalogState({
    v: 2,
    disabled: {},
    check: null,
    optional: {},
    ...overrides,
  });
}

describe("parseGaCatalogState", () => {
  it("reads today's flat map as disabled reports", () => {
    const state = parseGaCatalogState({
      campaign: { reason: "Field bogus", at: AT },
      page: { reason: "No at" },
      junk: 3,
    });
    expect(state).toEqual({
      v: 2,
      disabled: {
        campaign: { reason: "Field bogus", at: AT },
        page: { reason: "No at", at: new Date(0).toISOString() },
      },
      check: null,
      optional: {},
    });
    expect(parseGaCatalogState(null)).toEqual({
      v: 2,
      disabled: {},
      check: null,
      optional: {},
    });
    expect(parseGaCatalogState([1, 2]).disabled).toEqual({});
  });

  it("lifts a flat key an older build appended to v2", () => {
    const json = {
      ...v2({
        disabled: {
          site_search: { reason: "FIELD_MISSING: searchTerm", at: AT },
        },
        check: {
          at: AT,
          missing: { site_search: ["searchTerm"] },
          deprecated: [],
          blocked: ["advertiserAdCost"],
        },
        optional: { google_ads: { enabled: true, at: AT, reason: null } },
      }),
      campaign: { reason: "Old build dropped it", at: AT },
    };
    const state = parseGaCatalogState(json);
    expect(Object.keys(state.disabled).sort()).toEqual([
      "campaign",
      "site_search",
    ]);
    expect(state.check?.blocked).toEqual(["advertiserAdCost"]);
    expect(state.optional.google_ads?.enabled).toBe(true);
    expect(gaDisabledReports(json)).toEqual(
      new Set(["campaign", "site_search"]),
    );
    // v2 alanları rapor sayılmaz.
    expect(gaDisabledReports(v2())).toEqual(new Set());
  });
});

describe("withDisabledReport", () => {
  it("keeps the flat shape for v1 and empty input", () => {
    expect(withDisabledReport(null, "page", "bad", AT)).toEqual({
      page: { reason: "bad", at: AT },
    });
    expect(
      withDisabledReport(
        { campaign: { reason: "x", at: AT } },
        "page",
        "bad",
        AT,
      ),
    ).toEqual({
      campaign: { reason: "x", at: AT },
      page: { reason: "bad", at: AT },
    });
  });

  it("keeps v2 as v2", () => {
    const json = v2({
      check: { at: AT, missing: {}, deprecated: [], blocked: [] },
      optional: { search_console: { enabled: true, at: AT, reason: null } },
    });
    const next = withDisabledReport(json, "week:page", "bad", AT);
    expect(next.v).toBe(2);
    expect(next).not.toHaveProperty("week:page");
    const state = parseGaCatalogState(next);
    expect(state.disabled["week:page"]).toEqual({ reason: "bad", at: AT });
    expect(state.optional.search_console?.enabled).toBe(true);
    expect(state.check?.at).toBe(AT);
  });
});

describe("optional reports and the weekly check", () => {
  it("keeps optional reports off by default", () => {
    expect(gaOptionalReportEnabled(null, "google_ads")).toBe(false);
    expect(gaOptionalReportEnabled({}, "search_console")).toBe(false);
    expect(
      gaOptionalReportEnabled(
        v2({
          optional: {
            google_ads: { enabled: false, at: AT, reason: "NO_ADS_LINK" },
          },
        }),
        "google_ads",
      ),
    ).toBe(false);
  });

  it("runs the check weekly and retries a failed one after a day", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const checkedAgo = (ms: number, error?: string) =>
      v2({
        check: {
          at: new Date(now.getTime() - ms).toISOString(),
          missing: {},
          deprecated: [],
          blocked: [],
          ...(error ? { error } : {}),
        },
      });
    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    expect(gaCatalogCheckDue(null, now)).toBe(true);
    expect(gaCatalogCheckDue({ page: { reason: "x", at: AT } }, now)).toBe(
      true,
    );
    expect(gaCatalogCheckDue(checkedAgo(6 * DAY), now)).toBe(false);
    expect(gaCatalogCheckDue(checkedAgo(8 * DAY), now)).toBe(true);
    expect(gaCatalogCheckDue(checkedAgo(23 * HOUR, "429"), now)).toBe(false);
    expect(gaCatalogCheckDue(checkedAgo(25 * HOUR, "429"), now)).toBe(true);
    expect(gaCatalogCheckDue(checkedAgo(25 * HOUR), now)).toBe(false);
  });
});
