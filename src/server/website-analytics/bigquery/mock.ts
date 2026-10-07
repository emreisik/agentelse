import "server-only";

import {
  registerBigQueryMockHandler,
  type BigQueryMockHandler,
  type BqCell,
  type BqColumn,
  type BqQueryRequest,
  type BqQueryResult,
} from "@/server/integrations/google/bigquery";

import { defaultExportDataset } from "@/lib/website-analytics/bigquery/config";
import { addDays } from "@/lib/website-analytics/days";

// Mock mod BigQuery uç noktası (GA-F8): SC-F9'un sahte arka ucuna 'ga.' önekiyle
// kaydolur ve gerçek ifadelerle aynı sütun adlarını döndürür. Google'a hiç
// gidilmez. Yönlendirme HAM amaç dizesindedir (ga.daily | ga.events | ga.pages);
// gerçek REST arka ucu etiketi [a-z0-9_-]'e temizler (ga_daily ...), bu yüzden
// amaçlar temizlendikten sonra da benzersiz kalmalıdır (testte sabitlenir).

export const GA_MOCK_PREFIX = "ga.";
const MOCK_BYTES = 20_000_000;
const MAX_MOCK_DAYS = 400;

// Mülk için dışa aktarım anahtarı = veri kümesi adı (SQL'den ayrıştırılan değer).
export function mockExportKeyFor(propertyId: string): string {
  return defaultExportDataset(propertyId);
}

function hashOf(text: string): number {
  // FNV-1a 32 bit
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Aynı (anahtar, gün) her zaman aynı sayıları verir; entegrasyon testi GaDailyTotal'ı
// aynı sayılarla besler ve karşılaştırma tam "close" çıkar. `day` YYYY-MM-DD ya da YYYYMMDD.
export function mockBigQueryDayNumbers(
  exportKey: string,
  day: string,
): { events: number; users: number; sessions: number; keyEvents: number } {
  const key = day.replace(/-/g, "");
  const hash = hashOf(`${exportKey}|${key}`);
  const users = 40 + (hash % 60);
  const sessions = users + 10 + ((hash >>> 8) % 30);
  const events = sessions * (6 + ((hash >>> 12) % 4));
  const keyEvents = (hash >>> 16) % 12;
  return { events, users, sessions, keyEvents };
}

const MOCK_EVENT_NAMES = [
  "page_view",
  "session_start",
  "user_engagement",
  "scroll",
  "click",
] as const;
const MOCK_PATHS = ["/", "/pricing", "/blog/launch-notes", "/contact"] as const;

function paramValue(request: BqQueryRequest, name: string): string {
  const found = request.params.find((param) => param.name === name);
  return typeof found?.value === "string" ? found.value : "";
}

// `...`proje.veri_kumesi.events_*` içinden veri kümesi adı.
function datasetOf(sql: string): string | null {
  const match = /`[^`.]+\.([^`.]+)\.events_\*`/.exec(sql);
  return match?.[1] ?? null;
}

function suffixToDay(suffix: string): string | null {
  if (!/^\d{8}$/.test(suffix)) return null;
  return `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}`;
}

function dayRange(request: BqQueryRequest): string[] {
  const from = suffixToDay(paramValue(request, "from_suffix"));
  const to = suffixToDay(paramValue(request, "to_suffix"));
  if (!from || !to || from > to) return [];
  const days: string[] = [];
  for (let day = from; day <= to && days.length < MAX_MOCK_DAYS; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

const col = (name: string, type: BqColumn["type"]): BqColumn => ({ name, type });

function result(columns: BqColumn[], rows: BqCell[][]): BqQueryResult {
  return {
    columns,
    rows,
    totalRows: rows.length,
    truncated: false,
    bytesProcessed: MOCK_BYTES,
    bytesBilled: MOCK_BYTES,
    cacheHit: false,
  };
}

function split(total: number, parts: number): number[] {
  // Büyükten küçüğe, toplamı koruyan deterministik pay.
  const weights = Array.from({ length: parts }, (_, index) => parts - index);
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((weight) => Math.floor((total * weight) / sum));
  shares[0] = (shares[0] ?? 0) + (total - shares.reduce((a, b) => a + b, 0));
  return shares;
}

export const gaBigQueryMockHandler: BigQueryMockHandler = {
  query(request: BqQueryRequest): BqQueryResult {
    const dataset = datasetOf(request.sql);
    if (!dataset) throw new Error("ga mock: no export table in the statement");
    const days = dayRange(request);
    const keyed = (day: string) => mockBigQueryDayNumbers(dataset, day);

    if (request.purpose === "ga.daily") {
      return result(
        [
          col("day", "STRING"),
          col("events", "INTEGER"),
          col("users", "INTEGER"),
          col("sessions", "INTEGER"),
          col("key_events", "INTEGER"),
          col("revenue_micros", "INTEGER"),
        ],
        days.map((day) => {
          const n = keyed(day);
          return [day.replace(/-/g, ""), n.events, n.users, n.sessions, n.keyEvents, 0];
        }),
      );
    }
    if (request.purpose === "ga.events") {
      const rows: BqCell[][] = [];
      for (const day of days) {
        const shares = split(keyed(day).events, MOCK_EVENT_NAMES.length);
        MOCK_EVENT_NAMES.forEach((name, index) => {
          rows.push([day.replace(/-/g, ""), name, shares[index] ?? 0]);
        });
      }
      return result(
        [col("day", "STRING"), col("event_name", "STRING"), col("events", "INTEGER")],
        rows,
      );
    }
    if (request.purpose === "ga.pages") {
      const rows: BqCell[][] = [];
      for (const day of days) {
        const n = keyed(day);
        const shares = split(Math.max(n.events - n.sessions, n.sessions), MOCK_PATHS.length);
        MOCK_PATHS.forEach((path, index) => {
          const views = shares[index] ?? 0;
          rows.push([day.replace(/-/g, ""), path, views, Math.max(1, Math.floor(views / 2))]);
        });
      }
      return result(
        [
          col("day", "STRING"),
          col("path", "STRING"),
          col("views", "INTEGER"),
          col("users", "INTEGER"),
        ],
        rows,
      );
    }
    throw new Error("ga mock: unknown purpose");
  },
};

// Eşsiz ön ek; yeniden kaydı zararsızdır (aynı işleyici aynı önekin yerine geçer).
// resetBigQueryMock() işleyicileri sildiyse bayrak yüzünden kayıt kaybolmasın diye
// bayrak tutulmaz; SC-F9'un kayıt çağrısı bir ek yineleme hatası verirse yutulur.
export function registerGaBigQueryMock(): void {
  try {
    registerBigQueryMockHandler(GA_MOCK_PREFIX, gaBigQueryMockHandler);
  } catch {
    // Zaten kayıtlı
  }
}
