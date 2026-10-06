import { describe, expect, it } from "vitest";

import { GA_REPORTS } from "./catalog";
import {
  applyGaCatalogCheck,
  evaluateGaMetadata,
  gaCatalogRequiredFields,
  type GaFieldMeta,
  type GaMetadataFields,
  type GaRequiredFields,
} from "./catalog-fields";
import type { GaCatalogState } from "./catalog-state";
import { GA_WEEKLY_BREAKDOWN_KEYS } from "./weekly";

// Bu dosyanın kanıtladığı (GA-F2 bölüm 2, katalog denetimi): her raporun
// istediği alanlar listelenir; eksik alan raporu düşürür (KPI raporları
// hariç), alan geri gelince açılır; diğer düşmeler ve bilinmeyen anahtarlar
// yalnız 7 gün sonra yeniden denenir; eski adla bulunan alan ve kısıtlı
// metrik ayrıca kaydedilir.

const now = new Date("2026-10-06T12:00:00.000Z");
const at = now.toISOString();
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();

function field(apiName: string, extra: Partial<GaFieldMeta> = {}): GaFieldMeta {
  return { apiName, deprecatedApiNames: [], blockedReasons: [], ...extra };
}

// Gereken her alanı içeren metadata.
function fullMetadata(required: GaRequiredFields): GaMetadataFields {
  const dimensions = new Set<string>();
  const metrics = new Set<string>();
  for (const fields of Object.values(required)) {
    fields.dimensions.forEach((name) => dimensions.add(name));
    fields.metrics.forEach((name) => metrics.add(name));
  }
  return {
    dimensions: [...dimensions].map((name) => field(name)),
    metrics: [...metrics].map((name) => field(name)),
  };
}

function emptyState(disabled: GaCatalogState["disabled"] = {}): GaCatalogState {
  return { v: 2, disabled, check: null, optional: {} };
}

describe("gaCatalogRequiredFields", () => {
  const required = gaCatalogRequiredFields();

  it("covers totals, every report, rolling users, weekly, site search and the optional reports", () => {
    expect(required.totals?.dimensions).toEqual(["date"]);
    expect(required.totals?.metrics).toContain("sessions");
    for (const spec of GA_REPORTS) {
      expect(required[spec.key]).toEqual({
        dimensions: ["date", ...spec.dimensions],
        metrics: [...spec.metrics],
      });
    }
    expect(required.rolling_users).toEqual({
      dimensions: [],
      metrics: ["activeUsers", "newUsers", "totalUsers"],
    });
    for (const key of GA_WEEKLY_BREAKDOWN_KEYS) {
      expect(required[`week:${key}`]?.dimensions[0]).toBe("isoYearIsoWeek");
    }
    expect(required["week:landing_page"]?.dimensions).toEqual([
      "isoYearIsoWeek",
      "landingPage",
    ]);
    expect(required.site_search).toEqual({
      dimensions: ["isoYearIsoWeek", "searchTerm", "eventName"],
      metrics: ["eventCount"],
    });
    expect(required["week:site_search"]).toBeUndefined();
    expect(required.google_ads?.dimensions).toEqual([
      "date",
      "sessionGoogleAdsCampaignName",
    ]);
    expect(required.google_ads?.metrics).toContain("advertiserAdCost");
    expect(required.search_console).toEqual({
      dimensions: ["landingPagePlusQueryString"],
      metrics: [
        "organicGoogleSearchClicks",
        "organicGoogleSearchImpressions",
        "organicGoogleSearchAveragePosition",
      ],
    });
  });
});

describe("evaluateGaMetadata", () => {
  it("finds nothing wrong when every field is present", () => {
    const required = gaCatalogRequiredFields();
    expect(evaluateGaMetadata(fullMetadata(required), required)).toEqual({
      missing: {},
      deprecated: [],
      blocked: [],
    });
  });

  it("lists missing fields per report", () => {
    const required: GaRequiredFields = {
      landing_page: {
        dimensions: ["date", "landingPage"],
        metrics: ["sessions"],
      },
      channel: { dimensions: ["date"], metrics: ["sessions"] },
    };
    const result = evaluateGaMetadata(
      { dimensions: [field("date")], metrics: [field("sessions")] },
      required,
    );
    expect(result.missing).toEqual({ landing_page: ["landingPage"] });
  });

  it("treats a field found only under its old name as present and deprecated", () => {
    const required: GaRequiredFields = {
      events: { dimensions: ["date"], metrics: ["conversions", "keyEvents"] },
    };
    const result = evaluateGaMetadata(
      {
        dimensions: [field("date")],
        metrics: [field("keyEvents", { deprecatedApiNames: ["conversions"] })],
      },
      required,
    );
    expect(result.missing).toEqual({});
    expect(result.deprecated).toEqual(["conversions"]);
  });

  it("records restricted metrics once, with the reason", () => {
    const required: GaRequiredFields = {
      google_ads: { dimensions: ["date"], metrics: ["advertiserAdCost"] },
      other: { dimensions: [], metrics: ["advertiserAdCost", "totalRevenue"] },
    };
    const result = evaluateGaMetadata(
      {
        dimensions: [field("date")],
        metrics: [
          field("advertiserAdCost", { blockedReasons: ["NO_COST_METRICS"] }),
          field("totalRevenue"),
        ],
      },
      required,
    );
    expect(result.blocked).toEqual(["advertiserAdCost:NO_COST_METRICS"]);
    expect(result.missing).toEqual({});
  });
});

describe("applyGaCatalogCheck", () => {
  const required = gaCatalogRequiredFields();

  it("drops reports with missing fields but never totals or rolling users", () => {
    const result = {
      missing: {
        totals: ["sessions"],
        rolling_users: ["totalUsers"],
        landing_page: ["landingPage"],
        "week:page": ["pagePath", "pageTitle"],
      },
      deprecated: ["conversions"],
      blocked: [],
    };
    const state = applyGaCatalogCheck(emptyState(), {
      at,
      now,
      result,
      required,
    });
    expect(state.disabled).toEqual({
      landing_page: { reason: "FIELD_MISSING: landingPage", at },
      "week:page": { reason: "FIELD_MISSING: pagePath, pageTitle", at },
    });
    expect(state.check).toEqual({
      at,
      missing: result.missing,
      deprecated: ["conversions"],
      blocked: [],
    });
  });

  it("re-enables a FIELD_MISSING report as soon as its fields are back", () => {
    const state = applyGaCatalogCheck(
      emptyState({
        landing_page: { reason: "FIELD_MISSING: landingPage", at: daysAgo(1) },
      }),
      {
        at,
        now,
        result: { missing: {}, deprecated: [], blocked: [] },
        required,
      },
    );
    expect(state.disabled).toEqual({});
  });

  it("re-enables other drops only after 7 days", () => {
    const fresh = applyGaCatalogCheck(
      emptyState({ campaign: { reason: "INVALID_ARGUMENT", at: daysAgo(3) } }),
      {
        at,
        now,
        result: { missing: {}, deprecated: [], blocked: [] },
        required,
      },
    );
    expect(Object.keys(fresh.disabled)).toEqual(["campaign"]);

    const old = applyGaCatalogCheck(
      emptyState({ campaign: { reason: "INVALID_ARGUMENT", at: daysAgo(7) } }),
      {
        at,
        now,
        result: { missing: {}, deprecated: [], blocked: [] },
        required,
      },
    );
    expect(old.disabled).toEqual({});
  });

  it("re-enables an unknown key (legacy week:site_search) only after 7 days", () => {
    const legacy = (days: number) =>
      emptyState({ "week:site_search": { reason: "x", at: daysAgo(days) } });
    const empty = { missing: {}, deprecated: [], blocked: [] };
    expect(
      applyGaCatalogCheck(legacy(2), { at, now, result: empty, required })
        .disabled,
    ).toHaveProperty("week:site_search");
    expect(
      applyGaCatalogCheck(legacy(8), { at, now, result: empty, required })
        .disabled,
    ).toEqual({});
  });

  it("keeps a FIELD_MISSING report down while its fields are still missing", () => {
    const state = applyGaCatalogCheck(
      emptyState({
        landing_page: { reason: "FIELD_MISSING: landingPage", at: daysAgo(30) },
      }),
      {
        at,
        now,
        result: {
          missing: { landing_page: ["landingPage"] },
          deprecated: [],
          blocked: [],
        },
        required,
      },
    );
    expect(state.disabled.landing_page).toEqual({
      reason: "FIELD_MISSING: landingPage",
      at,
    });
  });

  it("leaves the optional report state untouched", () => {
    const optional: GaCatalogState["optional"] = {
      google_ads: { enabled: true, at: daysAgo(7), reason: null },
    };
    const state = applyGaCatalogCheck(
      { ...emptyState(), optional },
      {
        at,
        now,
        result: { missing: {}, deprecated: [], blocked: [] },
        required,
      },
    );
    expect(state.optional).toEqual(optional);
  });
});
