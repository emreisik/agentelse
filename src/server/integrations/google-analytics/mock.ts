import "server-only";

import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import { addDays, daysInRange } from "@/lib/website-analytics/days";
import type { GaRawReport } from "@/lib/website-analytics/response";

import type { GaPropertyDetails } from "./admin-api";

// Mock modu (AGENTELSE_PROVIDER_MODE=mock; CI ve yerel geliştirme): Google'a
// ve token ucuna hiçbir çağrı gitmez, istek gövdesinden belirlenimci yapay
// veri üretilir. Website sayfası, raporlar ve kurallar gerçek bir mülk
// olmadan geliştirilip denenebilir. Mock bağlantılar isMock ile işaretlenir.

const VALUES: Record<string, string[]> = {
  sessionDefaultChannelGroup: [
    "Organic Search",
    "Direct",
    "Organic Social",
    "Referral",
    "Paid Search",
    "Email",
  ],
  defaultChannelGroup: ["Organic Search", "Direct", "Paid Search", "Email"],
  sessionSource: ["google", "(direct)", "instagram.com", "newsletter"],
  sessionMedium: ["organic", "(none)", "referral", "email"],
  sessionCampaignName: ["autumn_sale", "newsletter_october"],
  sessionManualAdContent: ["(not set)", "banner_a"],
  landingPage: ["/", "/pricing", "/blog/how-to-start", "/contact", "/about"],
  pagePath: ["/", "/pricing", "/blog/how-to-start", "/contact", "/about"],
  pageTitle: ["Home", "Pricing", "How to start", "Contact", "About us"],
  eventName: [
    "page_view",
    "session_start",
    "user_engagement",
    "scroll",
    "generate_lead",
  ],
  isKeyEvent: ["false", "false", "false", "false", "true"],
  deviceCategory: ["desktop", "mobile", "tablet"],
  country: ["Turkey", "Germany", "United States"],
  newVsReturning: ["new", "returning"],
};

// Basit belirlenimci "rastgele": aynı girdi aynı sayıyı verir.
function seeded(...parts: (string | number)[]): number {
  let hash = 2166136261;
  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function daySessions(propertyId: string, day: string): number {
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.7 : 1;
  return Math.round((180 + 120 * seeded(propertyId, day)) * weekend);
}

function metricValue(
  name: string,
  sessions: number,
  share: number,
  seed: number,
): number {
  const base = sessions * share;
  switch (name) {
    case "sessions":
      return Math.round(base);
    case "engagedSessions":
      return Math.round(base * 0.62);
    case "activeUsers":
    case "totalUsers":
      return Math.round(base * 0.8);
    case "newUsers":
      return Math.round(base * 0.55);
    case "screenPageViews":
      return Math.round(base * 2.4);
    case "eventCount":
      return Math.round(base * 9);
    case "userEngagementDuration":
      return Math.round(base * 70);
    case "averageSessionDuration":
      return 95 + 30 * seed;
    case "keyEvents":
      return Math.round(base * 0.04);
    case "transactions":
      return Math.round(base * 0.01);
    case "totalRevenue":
      return Math.round(base * 0.01 * 45 * 100) / 100;
    default:
      return Math.round(base);
  }
}

function expandDays(request: GaRunReportRequest): string[] {
  const range = request.dateRanges[0];
  if (!range) return [];
  const count = Math.min(daysInRange(range.startDate, range.endDate), 500);
  return Array.from({ length: count }, (_, index) =>
    addDays(range.startDate, index),
  );
}

export function mockGaReport(
  propertyId: string,
  request: GaRunReportRequest,
): GaRawReport {
  const dimensions = (request.dimensions ?? []).map((d) => d.name);
  const metrics = request.metrics.map((m) => m.name);
  const rows: NonNullable<GaRawReport["rows"]> = [];

  if (request.dateRanges.length > 1 || dimensions.length === 0) {
    // Adlı aralıklar (kayan kullanıcılar, aylar): her aralık bir satır.
    for (const range of request.dateRanges) {
      const days = daysInRange(range.startDate, range.endDate);
      const sessions = days * daySessions(propertyId, range.endDate);
      rows.push({
        dimensionValues:
          request.dateRanges.length > 1 ? [{ value: range.name ?? "" }] : [],
        metricValues: metrics.map((name) => ({
          // Tekil kullanıcı, günlük değerlerin toplamından azdır.
          value: String(
            metricValue(name, sessions, name.endsWith("Users") ? 0.35 : 1, 0.5),
          ),
        })),
      });
    }
    return {
      dimensionHeaders:
        request.dateRanges.length > 1 ? [{ name: "dateRange" }] : [],
      metricHeaders: metrics.map((name) => ({ name })),
      rows,
      rowCount: rows.length,
      metadata: { currencyCode: "USD", timeZone: "Europe/Istanbul" },
      propertyQuota: mockQuota(),
    };
  }

  const others = dimensions.filter((name) => name !== "date");
  const width = Math.max(1, ...others.map((name) => VALUES[name]?.length ?? 1));
  for (const day of expandDays(request)) {
    const sessions = daySessions(propertyId, day);
    const variants = others.length === 0 ? 1 : width;
    for (let index = 0; index < variants; index += 1) {
      const share = others.length === 0 ? 1 : 1 / (index + 1.6);
      const seed = seeded(propertyId, day, index);
      rows.push({
        dimensionValues: dimensions.map((name) => ({
          value:
            name === "date"
              ? day.replaceAll("-", "")
              : (VALUES[name]?.[index % (VALUES[name]?.length ?? 1)] ??
                "(not set)"),
        })),
        metricValues: metrics.map((name) => ({
          value: String(metricValue(name, sessions, share, seed)),
        })),
      });
    }
  }
  return {
    dimensionHeaders: dimensions.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name })),
    rows,
    rowCount: rows.length,
    metadata: { currencyCode: "USD", timeZone: "Europe/Istanbul" },
    propertyQuota: mockQuota(),
  };
}

function mockQuota(): GaRawReport["propertyQuota"] {
  return {
    tokensPerDay: { consumed: 10, remaining: 199_990 },
    tokensPerHour: { consumed: 10, remaining: 39_990 },
    tokensPerProjectPerHour: { consumed: 10, remaining: 13_990 },
    concurrentRequests: { consumed: 0, remaining: 10 },
    serverErrorsPerProjectPerHour: { consumed: 0, remaining: 10 },
  };
}

export function mockGaPropertyDetails(propertyId: string): GaPropertyDetails {
  return {
    propertyName: `Mock property ${propertyId}`,
    accountId: "mock-account",
    timeZone: "Europe/Istanbul",
    currencyCode: "USD",
    industryCategory: "BUSINESS_AND_INDUSTRIAL_MARKETS",
    serviceLevel: "GOOGLE_ANALYTICS_STANDARD",
    createTime: "2025-01-01T00:00:00Z",
    streams: [
      {
        streamId: "mock-stream",
        measurementId: "G-MOCK0000",
        uri: "https://example.com",
      },
    ],
    keyEvents: [
      {
        eventName: "generate_lead",
        countingMethod: "ONCE_PER_EVENT",
        createTime: "2025-01-02T00:00:00Z",
      },
    ],
    dataRetention: "FOURTEEN_MONTHS",
    googleAdsLinks: 0,
  };
}
