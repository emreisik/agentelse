import { addDays, daysInRange } from "@/lib/website-analytics/days";

import { isValidGaEventName } from "./config";

// GA4 dışa aktarım tablolarını okuyan SQL kurucuları (GA-F8). Saf modül.
//
// GA4 dışa aktarım gerçekleri (gerçek veri kümesinde doğrulanmalı):
//  - ga_session_id ve page_location üst düzey SÜTUN DEĞİL, event_params
//    girdileridir; iç SELECT'te UNNEST(event_params) alt sorgusuyla okunur.
//  - event_date mülkün saat dilimindeki gündür ve "YYYYMMDD" dizesidir.
//  - events_intraday_* tabloları _TABLE_SUFFIX'in 8 rakam olma koşuluyla dışarıda kalır.
// Tarihler SQL'e asla gömülmez: @from_suffix / @to_suffix parametreleridir. Tanımlayıcılar
// SC-F9'un kurallarıyla aynı kurallarla yeniden doğrulanıp ters tırnağa alınır; geçersizse null.

export type GaBqStatement = {
  purpose: "ga.daily" | "ga.events" | "ga.pages";
  sql: string;
  params: { name: string; type: "STRING"; value: string }[];
  maxRows: number;
};

export type GaBqStatements = {
  daily: GaBqStatement;
  events: GaBqStatement;
  pages: GaBqStatement;
};

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET_ID = /^[A-Za-z0-9_]{1,1024}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const GA_TOP_EVENTS_PER_DAY = 20;
export const GA_TOP_PAGES_PER_DAY = 50;
// Sorgu etiketleri (BigQuery etiket değeri [a-z0-9_-] olacak şekilde SC-F9'da temizlenir).
export const GA_BQ_PURPOSES = ["ga.daily", "ga.events", "ga.pages"] as const;

export function exportRangeDays(fromDay: string, toDay: string): number {
  if (!DAY_KEY.test(fromDay) || !DAY_KEY.test(toDay)) return 0;
  return daysInRange(fromDay, toDay);
}

function suffixOf(day: string): string {
  return day.replace(/-/g, "");
}

// events_* tarayan iç SELECT'in ortak WHERE'i (budama _TABLE_SUFFIX BETWEEN ile).
const SUFFIX_WHERE = `_TABLE_SUFFIX BETWEEN @from_suffix AND @to_suffix
    AND REGEXP_CONTAINS(_TABLE_SUFFIX, r'^[0-9]{8}$')`;

export function buildGaStatements(
  ref: { projectId: string; datasetId: string },
  range: {
    fromDay: string;
    toDay: string;
    keyEventNames: readonly string[];
  },
): GaBqStatements | null {
  if (!PROJECT_ID.test(ref.projectId) || !DATASET_ID.test(ref.datasetId)) {
    return null;
  }
  if (!DAY_KEY.test(range.fromDay) || !DAY_KEY.test(range.toDay)) return null;
  const days = exportRangeDays(range.fromDay, range.toDay);
  if (days < 1) return null;

  const table = `\`${ref.projectId}.${ref.datasetId}.events_*\``;
  const base = [
    { name: "from_suffix", type: "STRING" as const, value: suffixOf(range.fromDay) },
    { name: "to_suffix", type: "STRING" as const, value: suffixOf(range.toDay) },
  ];
  // Geçersiz adlar atılır; virgül içeren ad zaten geçersizdir.
  const keyEvents = range.keyEventNames.filter(isValidGaEventName).join(",");

  // Üç ifade event_params / olay sütunlarını ayrı ayrı tarar: event_params en ağır
  // sütundur ve BigQuery başvurulan sütunu tarama başına tam faturalar; bu yüzden
  // günlük + sayfa ifadeleri birlikte tek taramanın yaklaşık üç katına mal olur.
  const daily = `SELECT
  event_date AS day,
  COUNT(*) AS events,
  COUNT(DISTINCT user_pseudo_id) AS users,
  COUNT(DISTINCT CONCAT(user_pseudo_id, '.', CAST(ga_session_id AS STRING))) AS sessions,
  COUNTIF(event_name IN UNNEST(SPLIT(@key_events, ','))) AS key_events,
  CAST(ROUND(IFNULL(SUM(purchase_revenue), 0) * 1000000) AS INT64) AS revenue_micros
FROM (
  SELECT
    event_date,
    event_name,
    user_pseudo_id,
    (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id') AS ga_session_id,
    ecommerce.purchase_revenue AS purchase_revenue
  FROM ${table}
  WHERE ${SUFFIX_WHERE}
)
GROUP BY event_date
ORDER BY event_date`;

  const events = `SELECT day, event_name, events
FROM (
  SELECT
    event_date AS day,
    event_name,
    COUNT(*) AS events,
    ROW_NUMBER() OVER (PARTITION BY event_date ORDER BY COUNT(*) DESC, event_name) AS rn
  FROM (
    SELECT event_date, event_name
    FROM ${table}
    WHERE ${SUFFIX_WHERE}
  )
  GROUP BY event_date, event_name
)
WHERE rn <= ${GA_TOP_EVENTS_PER_DAY}
ORDER BY day, rn`;

  const pages = `SELECT day, path, views, users
FROM (
  SELECT
    day,
    path,
    COUNT(*) AS views,
    COUNT(DISTINCT user_pseudo_id) AS users,
    ROW_NUMBER() OVER (PARTITION BY day ORDER BY COUNT(*) DESC, path) AS rn
  FROM (
    SELECT
      event_date AS day,
      user_pseudo_id,
      REGEXP_EXTRACT(page_location, r'^https?://[^/]+(/[^?#]*)') AS path
    FROM (
      SELECT
        event_date,
        user_pseudo_id,
        (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location') AS page_location
      FROM ${table}
      WHERE ${SUFFIX_WHERE}
        AND event_name = 'page_view'
    )
  )
  WHERE path IS NOT NULL
  GROUP BY day, path
)
WHERE rn <= ${GA_TOP_PAGES_PER_DAY}
ORDER BY day, rn`;

  return {
    daily: {
      purpose: "ga.daily",
      sql: daily,
      params: [
        ...base,
        { name: "key_events", type: "STRING", value: keyEvents },
      ],
      maxRows: days + 2,
    },
    events: {
      purpose: "ga.events",
      sql: events,
      params: base,
      maxRows: days * GA_TOP_EVENTS_PER_DAY + GA_TOP_EVENTS_PER_DAY,
    },
    pages: {
      purpose: "ga.pages",
      sql: pages,
      params: base,
      maxRows: days * GA_TOP_PAGES_PER_DAY + GA_TOP_PAGES_PER_DAY,
    },
  };
}

// [fromDay, toDay] aralığını en çok `chunks` ardışık parçaya böler (gün sayısı
// kadar parçadan fazlası olmaz); her parça sorgu başına bayt sınırına sığsın diye.
export function splitDayRange(
  fromDay: string,
  toDay: string,
  chunks: number,
): { fromDay: string; toDay: string }[] {
  const days = exportRangeDays(fromDay, toDay);
  if (days < 1 || !Number.isFinite(chunks) || chunks < 1) return [];
  const count = Math.min(Math.floor(chunks), days);
  const size = Math.ceil(days / count);
  const out: { fromDay: string; toDay: string }[] = [];
  for (let offset = 0; offset < days; offset += size) {
    const length = Math.min(size, days - offset);
    out.push({
      fromDay: addDays(fromDay, offset),
      toDay: addDays(fromDay, offset + length - 1),
    });
  }
  return out;
}

// Tahmini toplam bayttan (üç ifadenin toplamı) kaç parça gerektiği: her parça
// toplamın bölüşülmüş payı sınıra sığsın. 0 gün => 0 parça; en çok gün sayısı kadar.
export function planChunks(input: {
  days: number;
  estimatedBytes: number;
  capBytes: number;
}): number {
  const { days, estimatedBytes, capBytes } = input;
  if (!Number.isFinite(days) || days < 1) return 0;
  const wholeDays = Math.floor(days);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) return 1;
  if (!Number.isFinite(capBytes) || capBytes <= 0) return wholeDays;
  return Math.min(wholeDays, Math.max(1, Math.ceil(estimatedBytes / capBytes)));
}
