import "server-only";

import type {
  GscDimension,
  GscFilter,
  GscQueryRequest,
  GscSearchType,
} from "@/lib/seo/catalog";
import { addDays, dayRange, gscToday, maxDay, minDay } from "@/lib/seo/dates";
import { GoogleApiError } from "@/server/integrations/google/errors";

import type { GscSitemapInfo } from "./sitemaps";
import { propertyTypeOf, type GscSiteInfo } from "./sites";

// Mock modu (AGENTELSE_PROVIDER_MODE=mock; CI ve yerel geliştirme): Google'a
// hiçbir çağrı gitmez, istek gövdesinden belirlenimci yapay Search Analytics
// yanıtı (ham API JSON'u) üretilir. Değerler (siteUrl, gün, sorgu) başına
// sabittir; hafta sonu düşüktür ve 2025-01-01'den önce veri yoktur.
//
// Kurallar (docs/search-analytics.md, testlerle sabit):
// - final yanıtı bugün(PT)−3'e, all yanıtı bugün−1'e kadar gider; all
//   aralık bugün−2'ye ulaşırsa metadata.first_incomplete_date = bugün−2.
// - Sorgu boyutu ya da sorgu süzgeci olmayan isteklerde toplamlar sorgu
//   satırlarının 1,18 katıdır (Google'ın gizlediği anonim sorgular).
// - Sorgu×sayfa satırları sorgu satırlarıyla tutarlıdır (her sorgu iki
//   sayfaya tam sayılarla bölünür).
// - news/discover/googleNews boş, image/video küçük döner.

export const MOCK_GSC_BRAND_TERM = "acme";

const FIRST_DAY = "2025-01-01";
const ANONYMOUS_FACTOR = 1.18;

type MockQuery = {
  text: string;
  impressions: number;
  ctr: number;
  position: number;
  // MOCK_PAGES içindeki birincil ve ikincil sayfa.
  page: number;
  alt: number;
};

const MOCK_PAGES = [
  "/",
  "/products/running-shoes",
  "/products/hiking-boots",
  "/blog/clean-white-sneakers",
  "/size-guide",
  "/sale?ref=abc",
  "/blog/marathon-training",
  "/contact",
];

// PII örnekleri (e-posta, telefon) ve Türkçe karakterli markasız sorgu
// bilerek vardır: maskeleme ve marka ayrımı bunlarla denenir.
const MOCK_QUERIES: MockQuery[] = [
  {
    text: "acme shoes",
    impressions: 420,
    ctr: 0.21,
    position: 1.3,
    page: 0,
    alt: 1,
  },
  {
    text: "acme store near me",
    impressions: 160,
    ctr: 0.12,
    position: 2.1,
    page: 7,
    alt: 0,
  },
  {
    text: "running shoes",
    impressions: 900,
    ctr: 0.012,
    position: 9.4,
    page: 1,
    alt: 6,
  },
  {
    text: "best trail running shoes",
    impressions: 520,
    ctr: 0.018,
    position: 7.6,
    page: 1,
    alt: 2,
  },
  {
    text: "waterproof hiking boots",
    impressions: 380,
    ctr: 0.022,
    position: 6.8,
    page: 2,
    alt: 5,
  },
  {
    text: "how to clean white sneakers",
    impressions: 610,
    ctr: 0.031,
    position: 4.9,
    page: 3,
    alt: 0,
  },
  {
    text: "shoe size guide",
    impressions: 300,
    ctr: 0.028,
    position: 5.2,
    page: 4,
    alt: 1,
  },
  {
    text: "marathon training plan",
    impressions: 450,
    ctr: 0.009,
    position: 12.4,
    page: 6,
    alt: 1,
  },
  {
    text: "kids sneakers sale",
    impressions: 260,
    ctr: 0.025,
    position: 6.1,
    page: 5,
    alt: 1,
  },
  {
    text: "ışıklı ayakkabı fiyatları",
    impressions: 140,
    ctr: 0.015,
    position: 11.3,
    page: 5,
    alt: 0,
  },
  {
    text: "john.doe@example.com order status",
    impressions: 30,
    ctr: 0.1,
    position: 3.2,
    page: 7,
    alt: 0,
  },
  {
    text: "call +90 555 123 45 67 shoe repair",
    impressions: 25,
    ctr: 0.04,
    position: 8.7,
    page: 7,
    alt: 0,
  },
  {
    text: "leather boots care",
    impressions: 210,
    ctr: 0.02,
    position: 8.1,
    page: 2,
    alt: 3,
  },
  {
    text: "sneaker cleaning kit",
    impressions: 180,
    ctr: 0.017,
    position: 10.2,
    page: 3,
    alt: 5,
  },
];

// ISO-3166 alfa-3 küçük harf; 60'tan fazla ülke: ilk 50 kırpması denenir.
const COUNTRIES = [
  "tur",
  "deu",
  "usa",
  "gbr",
  "mkd",
  "nld",
  "fra",
  "aut",
  "bel",
  "che",
  "ita",
  "esp",
  "prt",
  "pol",
  "swe",
  "nor",
  "dnk",
  "fin",
  "irl",
  "grc",
  "bgr",
  "rou",
  "srb",
  "alb",
  "hrv",
  "svn",
  "bih",
  "mne",
  "cze",
  "svk",
  "hun",
  "ukr",
  "aze",
  "geo",
  "arm",
  "cyp",
  "isr",
  "are",
  "sau",
  "qat",
  "kwt",
  "egy",
  "mar",
  "tun",
  "dza",
  "ind",
  "pak",
  "jpn",
  "kor",
  "aus",
  "nzl",
  "can",
  "mex",
  "bra",
  "arg",
  "chl",
  "col",
  "zaf",
  "nga",
  "idn",
  "mys",
  "sgp",
  "tha",
  "vnm",
  "phl",
];

// Ülke payları: 1/(sıra) ile azalan, toplamı 1.
const COUNTRY_SHARES = ((): number[] => {
  const raw = COUNTRIES.map((_, index) => 1 / (index + 1));
  const sum = raw.reduce((total, value) => total + value, 0);
  return raw.map((value) => value / sum);
})();

// Boyut anahtarları ve payları. Arama görünümünün payları 1'e tamamlanmaz:
// sonuçların yalnız bir kısmı zengin görünümle çıkar.
const WEIGHTS: Record<
  "country" | "device" | "searchAppearance",
  [string, number][]
> = {
  country: COUNTRIES.map((code, index) => [code, COUNTRY_SHARES[index]!]),
  device: [
    ["MOBILE", 0.58],
    ["DESKTOP", 0.38],
    ["TABLET", 0.04],
  ],
  searchAppearance: [
    ["PRODUCT_SNIPPETS", 0.18],
    ["REVIEW_SNIPPET", 0.09],
    ["FAQ_RICH_RESULT", 0.06],
    ["VIDEO", 0.03],
  ],
};

const TYPE_FACTOR: Record<GscSearchType, number> = {
  web: 1,
  image: 0.08,
  video: 0.03,
  news: 0,
  discover: 0,
  googleNews: 0,
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

// Sitenin mock sayfa kökeni: "sc-domain:example.com" → https://www.example.com
function mockOrigin(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) {
    return `https://www.${siteUrl.slice("sc-domain:".length)}`;
  }
  try {
    return new URL(siteUrl).origin;
  } catch {
    return "https://www.example.com";
  }
}

type Atom = { clicks: number; impressions: number; positionWeighted: number };

// (site, gün, sorgu) başına tam sayılı değerler.
function atom(
  siteUrl: string,
  day: string,
  index: number,
  type: GscSearchType,
): Atom {
  const query = MOCK_QUERIES[index]!;
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 0.75 : 1;
  const impressions = Math.round(
    query.impressions *
      TYPE_FACTOR[type] *
      weekend *
      (0.7 + 0.6 * seeded(siteUrl, day, index, "i")),
  );
  const clicks = Math.min(
    impressions,
    Math.round(
      impressions * query.ctr * (0.8 + 0.4 * seeded(siteUrl, day, index, "c")),
    ),
  );
  const position =
    Math.round(
      query.position * (0.85 + 0.3 * seeded(siteUrl, day, index, "p")) * 10,
    ) / 10;
  return { clicks, impressions, positionWeighted: position * impressions };
}

// Sorgunun sayfalara bölünmesi (tam sayı; toplamı sorgu satırına eşit).
function splitAtom(value: Atom): [Atom, Atom] {
  const clicks = Math.round(value.clicks * 0.75);
  const impressions = Math.round(value.impressions * 0.75);
  const share = value.impressions > 0 ? impressions / value.impressions : 0;
  return [
    {
      clicks,
      impressions,
      positionWeighted: value.positionWeighted * share,
    },
    {
      clicks: value.clicks - clicks,
      impressions: value.impressions - impressions,
      positionWeighted: value.positionWeighted * (1 - share),
    },
  ];
}

function invalid(message: string): GoogleApiError {
  return new GoogleApiError(message, "INVALID_ARGUMENT", { httpStatus: 400 });
}

// Google RE2 ifadesi; JS'te baştaki "(?i)" atılıp "iu" bayraklarıyla
// çalıştırılır.
function regexOf(expression: string): RegExp {
  try {
    return new RegExp(expression.replace(/^\(\?i\)/, ""), "iu");
  } catch {
    throw invalid(`Invalid regular expression: ${expression}`);
  }
}

function matcher(filter: GscFilter): (value: string) => boolean {
  const expression = filter.expression;
  switch (filter.operator) {
    case "equals":
      return (value) => value === expression;
    case "notEquals":
      return (value) => value !== expression;
    case "contains":
      return (value) => value.toLowerCase().includes(expression.toLowerCase());
    case "notContains":
      return (value) => !value.toLowerCase().includes(expression.toLowerCase());
    case "includingRegex": {
      const regex = regexOf(expression);
      return (value) => regex.test(value);
    }
    case "excludingRegex": {
      const regex = regexOf(expression);
      return (value) => !regex.test(value);
    }
  }
}

type Cell = { keys: Partial<Record<GscDimension, string>>; value: Atom };

function scale(value: Atom, factor: number): Atom {
  return {
    clicks: value.clicks * factor,
    impressions: value.impressions * factor,
    positionWeighted: value.positionWeighted * factor,
  };
}

// Bir istekteki boyut/süzgeç için hücreler: gün × sorgu (× sayfa) (× ülke,
// cihaz, görünüm payları).
function cellsFor(
  siteUrl: string,
  request: GscQueryRequest,
  days: string[],
  needed: ReadonlySet<GscDimension>,
): Cell[] {
  const origin = mockOrigin(siteUrl);
  let cells: Cell[] = [];
  for (const day of days) {
    MOCK_QUERIES.forEach((query, index) => {
      const value = atom(siteUrl, day, index, request.type);
      if (value.impressions <= 0) return;
      const keys = { date: day, query: query.text };
      if (!needed.has("page")) {
        cells.push({ keys, value });
        return;
      }
      const [primary, secondary] = splitAtom(value);
      cells.push({
        keys: { ...keys, page: `${origin}${MOCK_PAGES[query.page]}` },
        value: primary,
      });
      cells.push({
        keys: { ...keys, page: `${origin}${MOCK_PAGES[query.alt]}` },
        value: secondary,
      });
    });
  }
  for (const dimension of ["country", "device", "searchAppearance"] as const) {
    if (!needed.has(dimension)) continue;
    cells = cells.flatMap((cell) =>
      WEIGHTS[dimension].map(([key, weight]) => ({
        keys: { ...cell.keys, [dimension]: key },
        value: scale(cell.value, weight),
      })),
    );
  }
  return cells;
}

type RawRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export function mockSearchAnalytics(
  siteUrl: string,
  request: GscQueryRequest,
  now: Date = new Date(),
): unknown {
  const today = gscToday(now);
  const cutoff = addDays(today, request.dataState === "final" ? -3 : -1);
  const start = maxDay(request.startDate, FIRST_DAY)!;
  const end = minDay(request.endDate, cutoff)!;
  const filters = (request.dimensionFilterGroups ?? []).flatMap(
    (group) => group.filters,
  );
  const needed = new Set<GscDimension>([
    ...request.dimensions,
    ...filters.map((filter) => filter.dimension),
  ]);
  const tests = filters.map((filter) => ({
    dimension: filter.dimension,
    test: matcher(filter),
  }));

  const cells = cellsFor(siteUrl, request, dayRange(start, end), needed).filter(
    (cell) =>
      tests.every(({ dimension, test }) => test(cell.keys[dimension] ?? "")),
  );
  // Sorgu düzeyine inmeyen yanıtlar anonim sorguları da içerir.
  const factor = needed.has("query") ? 1 : ANONYMOUS_FACTOR;

  const groups = new Map<string, { keys: string[]; value: Atom }>();
  for (const cell of cells) {
    const keys = request.dimensions.map(
      (dimension) => cell.keys[dimension] ?? "",
    );
    const id = JSON.stringify(keys);
    const group = groups.get(id) ?? {
      keys,
      value: { clicks: 0, impressions: 0, positionWeighted: 0 },
    };
    group.value.clicks += cell.value.clicks;
    group.value.impressions += cell.value.impressions;
    group.value.positionWeighted += cell.value.positionWeighted;
    groups.set(id, group);
  }

  const rows: RawRow[] = [];
  for (const { keys, value } of groups.values()) {
    const impressions = Math.round(value.impressions * factor);
    if (impressions <= 0) continue;
    const clicks = Math.min(impressions, Math.round(value.clicks * factor));
    rows.push({
      keys,
      clicks,
      impressions,
      ctr: clicks / impressions,
      position:
        value.impressions > 0
          ? Math.round((value.positionWeighted / value.impressions) * 100) / 100
          : 0,
    });
  }
  const dateIndex = request.dimensions.indexOf("date");
  rows.sort((a, b) => {
    if (dateIndex >= 0) {
      const byDate = a.keys[dateIndex]!.localeCompare(b.keys[dateIndex]!);
      if (byDate !== 0) return byDate;
    }
    return (
      b.clicks - a.clicks ||
      b.impressions - a.impressions ||
      a.keys.join("\u0000").localeCompare(b.keys.join("\u0000"))
    );
  });

  const page = rows.slice(
    request.startRow,
    request.startRow + request.rowLimit,
  );
  const incomplete = addDays(today, -2);
  const body: {
    rows?: RawRow[];
    responseAggregationType: string;
    metadata?: { first_incomplete_date: string };
  } = { responseAggregationType: request.aggregationType };
  if (page.length > 0) body.rows = page;
  if (
    request.dataState === "all" &&
    request.startDate <= incomplete &&
    request.endDate >= incomplete
  ) {
    body.metadata = { first_incomplete_date: incomplete };
  }
  return body;
}

export function mockSite(siteUrl: string): GscSiteInfo {
  return {
    siteUrl,
    permissionLevel: "siteOwner",
    propertyType: propertyTypeOf(siteUrl),
  };
}

export function mockSitemaps(siteUrl: string): GscSitemapInfo[] {
  return [
    {
      path: `${mockOrigin(siteUrl)}/sitemap.xml`,
      type: "sitemap",
      isIndex: false,
      isPending: false,
      lastSubmitted: "2026-01-15T09:00:00.000Z",
      lastDownloaded: "2026-01-16T03:00:00.000Z",
      errors: 0,
      warnings: 0,
      contents: [{ type: "web", submitted: 42 }],
    },
  ];
}
