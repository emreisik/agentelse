import { addDays } from "@/lib/website-analytics/days";
import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import type { GaParsedReport } from "@/lib/website-analytics/response";
import { containsGooglePii } from "@/server/integrations/google/pii";

import type { GaPiiProbeResult } from "./types";

// GA-F3 MH12 PII yoklaması (docs/measurement-health.md "PII yoklaması"):
// haftada bir (ve 'I fixed it' ile bugün için) tek runReport. Google'a
// e-posta ya da kişisel parametre içeren pagePathPlusQueryString satırlarını
// sorarız; yanıt yalnız bellekte değerlendirilir. Sonuçta yalnız sayılar ve
// izinli parametre adları kalır: adres, değer ya da kişisel veri asla
// saklanmaz ve loglanmaz.

export const PII_PARAM_NAMES: readonly string[] = [
  "email",
  "e-mail",
  "mail",
  "phone",
  "tel",
  "mobile",
  "name",
  "firstname",
  "first_name",
  "lastname",
  "last_name",
  "token",
  "password",
  "pass",
  "pwd",
];

export const PII_EMAIL_FILTER_REGEX =
  "[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
export const PII_PARAM_FILTER_REGEX =
  "[?&](e-?mail|mail|phone|tel|mobile|(first_?|last_?)?name|token|password|pass|pwd)=";

const EMAIL = new RegExp(PII_EMAIL_FILTER_REGEX);
// pii.ts ile aynı uluslararası telefon kalıbı (+ ile başlar).
const PHONE = /\+\d[\d\s().-]{7,}\d/;

// Zamanlanmış yoklama dünü de kapsayan son 7 günü tarar; önceki temiz
// yoklama daha geç bir günden başladıysa (ör. 'I fixed it' ile bugün) ondan
// öncesi yeniden taranmaz: düzeltme öncesi günler hatayı geri getirmesin.
export function piiProbeRange(input: {
  today: string;
  force: boolean;
  previous: GaPiiProbeResult | null;
}): { from: string; to: string } {
  if (input.force) return { from: input.today, to: input.today };
  const to = addDays(input.today, -1);
  const weekAgo = addDays(input.today, -7);
  const previous = input.previous;
  const cleanPrev =
    previous?.outcome === "ok" &&
    !previous.email &&
    !previous.phone &&
    previous.params.length === 0;
  const start = cleanPrev && previous.from > weekAgo ? previous.from : weekAgo;
  return { from: start > to ? to : start, to };
}

// Sözleşmedeki JSON'un birebiri (caseSensitive stringFilter'ın içinde).
export function piiProbeRequest(from: string, to: string): GaRunReportRequest {
  return {
    dimensions: [{ name: "pagePathPlusQueryString" }],
    metrics: [{ name: "screenPageViews" }],
    dateRanges: [{ startDate: from, endDate: to }],
    dimensionFilter: {
      orGroup: {
        expressions: [
          {
            filter: {
              fieldName: "pagePathPlusQueryString",
              stringFilter: {
                matchType: "PARTIAL_REGEXP",
                value: PII_EMAIL_FILTER_REGEX,
                caseSensitive: false,
              },
            },
          },
          {
            filter: {
              fieldName: "pagePathPlusQueryString",
              stringFilter: {
                matchType: "PARTIAL_REGEXP",
                value: PII_PARAM_FILTER_REGEX,
                caseSensitive: false,
              },
            },
          },
        ],
      },
    },
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 100,
    returnPropertyQuota: true,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Sorgu dizesindeki izinli kişisel parametre adları (küçük harfle).
// Ayrıştırma ham değer üzerinde yapılır: kodlanmış %26 yeni parametre
// açmasın.
function piiParamsOf(value: string): string[] {
  const query = value.split("#")[0]?.split("?").slice(1).join("?") ?? "";
  if (!query) return [];
  const names: string[] = [];
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    const name = safeDecode(pair.slice(0, equals)).trim().toLowerCase();
    if (PII_PARAM_NAMES.includes(name)) names.push(name);
  }
  return names;
}

export function evaluatePiiProbe(
  report: GaParsedReport,
  input: { at: string; from: string; to: string; forced: boolean },
): GaPiiProbeResult {
  const pathIndex = Math.max(
    0,
    report.dimensionHeaders.indexOf("pagePathPlusQueryString"),
  );
  const viewsIndex = Math.max(
    0,
    report.metricHeaders.indexOf("screenPageViews"),
  );
  let pages = 0;
  let views = 0;
  let email = false;
  let phone = false;
  const params = new Set<string>();

  for (const row of report.rows) {
    const raw = row.dimensions[pathIndex] ?? "";
    if (!raw) continue;
    const value = safeDecode(raw);
    const rowEmail = EMAIL.test(value) || EMAIL.test(raw);
    const rowPhone = containsGooglePii(raw) && PHONE.test(value);
    const rowParams = piiParamsOf(raw);
    if (!rowEmail && !rowPhone && rowParams.length === 0) continue;
    pages += 1;
    const rowViews = row.metrics[viewsIndex] ?? 0;
    views += Number.isFinite(rowViews) ? rowViews : 0;
    if (rowEmail) email = true;
    if (rowPhone) phone = true;
    for (const name of rowParams) params.add(name);
  }

  return {
    v: 1,
    at: input.at,
    from: input.from,
    to: input.to,
    forced: input.forced,
    outcome: "ok",
    pages,
    views,
    params: Array.from(params).sort(),
    email,
    phone,
  };
}
