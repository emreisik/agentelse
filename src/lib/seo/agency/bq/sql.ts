import {
  bqTable,
  assertReadOnlySql,
} from "@/server/integrations/google/bigquery/identifiers";
import type { BqParam } from "@/server/integrations/google/bigquery/types";

import { BQ_TABLE_LOG, BQ_TABLE_SITE, BQ_TABLE_URL } from "./limits";
import { normalizeSiteUrl } from "./rows";

// Search Console dışa aktarım SQL kurucuları (docs/search-agency.md). Burası
// güvenlik açısından kritik dosyadır:
// - tanımlayıcılar yalnız bqTable() ile girer (geçersiz kimlik SQL oluşmadan
//   fırlatır); müşteri değerleri YALNIZ adlandırılmış parametredir
//   (@from, @to, @since, @site_url, @site, @limit);
// - ilk satır `-- agentelse:<amaç>` yorumudur (iş etiketi ve sahte arka uç
//   yönlendirmesi);
// - SELECT * yoktur; dışa aktarım tablolarındaki her sorguda data_date
//   bölüm süzgeci ve TEK mülk kısıtı vardır (aynı veri kümesindeki başka
//   siteler okunmaz, sayılmaz, listelenmez);
// - her kurucu çıktısını assertReadOnlySql'den geçirir.

// Google'ın dışa aktarım şeması: sütun adları belleğe dayanır ve doğrulanmalıdır.
// Bir ad yanlışsa tek satır düzeltme yeter; bilinmeyen sütun hatası INVALID_QUERY
// olarak yüzeye çıkar (durum ERROR), çökme olmaz.
const COL = {
  date: "data_date",
  site: "site_url",
  searchType: "search_type",
  query: "query",
  url: "url",
  anonymized: "is_anonymized_query",
  clicks: "clicks",
  impressions: "impressions",
  // Sıfır tabanlı konum toplamları: site tablosunda en üst, URL tablosunda sayfa.
  sumPositionSite: "sum_top_position",
  sumPositionUrl: "sum_position",
  logAgenda: "agenda",
  logDate: "data_date",
} as const;

// ExportLog'daki ajanda adları ve arama türü değeri.
const AGENDA_SITE = "SEARCHDATA_SITE_IMPRESSION";
const AGENDA_URL = "SEARCHDATA_URL_IMPRESSION";
const SEARCH_TYPE_WEB = "WEB";

export type BqSql = { purpose: string; sql: string; params: BqParam[] };
export type BqTarget = { projectId: string; dataset: string };
export type BqPeriodKind = "query" | "page" | "query_page";

function finish(purpose: string, body: string, params: BqParam[]): BqSql {
  const sql = `-- agentelse:${purpose}\n${body.trim()}`;
  assertReadOnlySql(sql);
  return { purpose, sql, params };
}

function table(t: BqTarget, name: string): string {
  return bqTable({ projectId: t.projectId, dataset: t.dataset, table: name });
}

const date = (name: string, value: string): BqParam => ({
  name,
  type: "DATE",
  value,
});
const text = (name: string, value: string): BqParam => ({
  name,
  type: "STRING",
  value,
});

// Dışa aktarımın kapsadığı günler (ExportLog: site verisi taşımaz).
export function coverageLogSql(t: BqTarget): BqSql {
  return finish(
    "gsc.coverage.log",
    `SELECT ${COL.logAgenda}, MIN(${COL.logDate}) AS first_day, MAX(${COL.logDate}) AS last_day, COUNT(DISTINCT ${COL.logDate}) AS days
FROM ${table(t, BQ_TABLE_LOG)}
WHERE ${COL.logAgenda} IN ('${AGENDA_SITE}', '${AGENDA_URL}')
GROUP BY ${COL.logAgenda}`,
    [],
  );
}

// ExportLog yoksa yedek: tablonun kendisinden yalnız bu mülkün gün aralığı.
export function coverageTableSql(
  t: BqTarget,
  which: "site" | "url",
  since: string,
  siteUrl: string,
): BqSql {
  const name = which === "site" ? BQ_TABLE_SITE : BQ_TABLE_URL;
  return finish(
    "gsc.coverage.table",
    `SELECT MIN(${COL.date}) AS first_day, MAX(${COL.date}) AS last_day, COUNT(DISTINCT ${COL.date}) AS days
FROM ${table(t, name)}
WHERE ${COL.date} >= @since AND ${COL.site} = @site_url`,
    [date("since", since), text("site_url", siteUrl)],
  );
}

// Bağın kendi mülkü veri kümesinde var mı: YALNIZ normalleştirilmiş tek
// değer eşleşen satırlar döner; veri kümesindeki başka siteler asla listelenmez.
export function siteMatchSql(
  t: BqTarget,
  since: string,
  normalizedSiteUrl: string,
): BqSql {
  return finish(
    "gsc.sites",
    `SELECT ${COL.site}, SUM(${COL.clicks}) AS clicks, SUM(${COL.impressions}) AS impressions
FROM ${table(t, BQ_TABLE_SITE)}
WHERE ${COL.date} >= @since AND ${COL.searchType} = '${SEARCH_TYPE_WEB}' AND LOWER(RTRIM(${COL.site}, '/')) = @site
GROUP BY ${COL.site}`,
    [date("since", since), text("site", normalizeSiteUrl(normalizedSiteUrl))],
  );
}

// Mutabakat: günlük web toplamları (API ile karşılaştırılır).
export function reconcileDaysSql(
  t: BqTarget,
  siteUrl: string,
  from: string,
  to: string,
): BqSql {
  return finish(
    "gsc.reconcile.days",
    `SELECT ${COL.date}, SUM(${COL.clicks}) AS clicks, SUM(${COL.impressions}) AS impressions
FROM ${table(t, BQ_TABLE_SITE)}
WHERE ${COL.date} BETWEEN @from AND @to AND ${COL.site} = @site_url AND ${COL.searchType} = '${SEARCH_TYPE_WEB}'
GROUP BY ${COL.date}
ORDER BY ${COL.date}`,
    [date("from", from), date("to", to), text("site_url", siteUrl)],
  );
}

const PURPOSE: Record<BqPeriodKind, string> = {
  query: "gsc.period.query",
  page: "gsc.period.page",
  query_page: "gsc.period.pair",
};

// Dönem özeti. Sütun sırası sabittir (okuyucu konuma göre okur):
// [anahtar..., tıklama, gösterim, sıfır tabanlı konum toplamı]. Cap + 1 satır
// istenir: fazladan satır kırpılmayı görünür kılar. Anonim sorgular sorgu
// anahtarlarında dışarıda, sayfa anahtarında içeridedir.
export function periodSql(
  t: BqTarget,
  key: BqPeriodKind,
  siteUrl: string,
  from: string,
  to: string,
  cap: number,
): BqSql {
  const params: BqParam[] = [
    date("from", from),
    date("to", to),
    text("site_url", siteUrl),
    { name: "limit", type: "INT64", value: Math.floor(cap) + 1 },
  ];
  const range = `${COL.date} BETWEEN @from AND @to AND ${COL.site} = @site_url AND ${COL.searchType} = '${SEARCH_TYPE_WEB}'`;
  const order = "ORDER BY n_clicks DESC, n_impressions DESC";
  if (key === "query") {
    return finish(
      PURPOSE.query,
      `SELECT ${COL.query}, SUM(${COL.clicks}) AS n_clicks, SUM(${COL.impressions}) AS n_impressions, SUM(IFNULL(${COL.sumPositionSite}, 0)) AS pos_sum
FROM ${table(t, BQ_TABLE_SITE)}
WHERE ${range} AND ${COL.anonymized} = FALSE AND ${COL.query} IS NOT NULL
GROUP BY ${COL.query}
HAVING SUM(${COL.impressions}) > 0
${order}, ${COL.query} ASC
LIMIT @limit`,
      params,
    );
  }
  if (key === "page") {
    return finish(
      PURPOSE.page,
      `SELECT ${COL.url}, SUM(${COL.clicks}) AS n_clicks, SUM(${COL.impressions}) AS n_impressions, SUM(IFNULL(${COL.sumPositionUrl}, 0)) AS pos_sum
FROM ${table(t, BQ_TABLE_URL)}
WHERE ${range} AND ${COL.url} IS NOT NULL
GROUP BY ${COL.url}
HAVING SUM(${COL.impressions}) > 0
${order}, ${COL.url} ASC
LIMIT @limit`,
      params,
    );
  }
  return finish(
    PURPOSE.query_page,
    `SELECT ${COL.query}, ${COL.url}, SUM(${COL.clicks}) AS n_clicks, SUM(${COL.impressions}) AS n_impressions, SUM(IFNULL(${COL.sumPositionUrl}, 0)) AS pos_sum
FROM ${table(t, BQ_TABLE_URL)}
WHERE ${range} AND ${COL.anonymized} = FALSE AND ${COL.query} IS NOT NULL AND ${COL.url} IS NOT NULL
GROUP BY ${COL.query}, ${COL.url}
HAVING SUM(${COL.impressions}) > 0
${order}, ${COL.query} ASC, ${COL.url} ASC
LIMIT @limit`,
    params,
  );
}
