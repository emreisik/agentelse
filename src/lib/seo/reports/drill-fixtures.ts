import type { GscTotals } from "@/lib/seo/totals";

import type {
  DiagnoseInput,
  DiagnosePage,
  DiagnosePair,
  DiagnoseRow,
  DiagnoseStepKey,
} from "./types";

// Teşhis ağacının drill girdileri (docs/search-reports.md "Teşhis drill'i").
// Test desteğidir: sağlıklı bir 28 günlük taban ve her adım için tek nedenli
// düşüş. Her drill'de toplam yaklaşık %30 düşer ve yalnız ilgili adım "yes"
// olur; diğer adımlar "no" kalır. Yan sunucu testleri de aynı girdileri
// kullanır. Saf; saat ya da veritabanı yok.

const TODAY = "2026-10-07";
const FINAL_THROUGH = "2026-10-05";
// Pazartesi hizalı, 28'er günlük iki pencere.
const CURRENT = { from: "2026-09-07", to: "2026-10-04" };
const PREVIOUS = { from: "2026-08-10", to: "2026-09-06" };
const PAIR_CURRENT = { from: "2026-09-21", to: "2026-10-04" };
const PAIR_PREVIOUS = { from: "2026-09-07", to: "2026-09-20" };

function totals(
  clicks: number,
  impressions: number,
  position: number,
): GscTotals {
  return { clicks, impressions, positionWeighted: impressions * position };
}

type RowSpec = {
  prev: number;
  cur: number;
  prevImpressions: number;
  curImpressions: number;
  prevPosition: number;
  curPosition: number;
};

function spec(partial: Partial<RowSpec> = {}): RowSpec {
  return {
    prev: 50,
    cur: 50,
    prevImpressions: 2000,
    curImpressions: 2000,
    prevPosition: 6,
    curPosition: 6,
    ...partial,
  };
}

function row(id: string, label: string, s: RowSpec): DiagnoseRow {
  return {
    id,
    label,
    previous: totals(s.prev, s.prevImpressions, s.prevPosition),
    current: totals(s.cur, s.curImpressions, s.curPosition),
  };
}

function queryRows(count: number, make: (index: number) => RowSpec) {
  return Array.from({ length: count }, (_, index) =>
    row(`q${index + 1}`, `sample search ${index + 1}`, make(index)),
  );
}

type PageOptions = {
  status?: number | null;
  noindex?: boolean | null;
  indexed?: boolean | null;
};

function pageRow(
  id: string,
  path: string,
  s: RowSpec,
  options: PageOptions = {},
): DiagnosePage {
  return {
    ...row(id, path, s),
    status: options.status === undefined ? 200 : options.status,
    noindex: options.noindex === undefined ? false : options.noindex,
    indexed: options.indexed === undefined ? true : options.indexed,
  };
}

function pageRows(
  count: number,
  make: (index: number) => RowSpec,
  options: (index: number) => PageOptions = () => ({}),
): DiagnosePage[] {
  return Array.from({ length: count }, (_, index) =>
    pageRow(`p${index + 1}`, `/page-${index + 1}`, make(index), options(index)),
  );
}

// İlk beş sorgu iki sayfaya %70 / %30 bölünür; paylar iki dönemde de aynıdır.
function stablePairs(queries: readonly DiagnoseRow[]): DiagnosePair[] {
  const pairs: DiagnosePair[] = [];
  for (const query of queries.slice(0, 5)) {
    const split = (clicks: number, share: number) =>
      totals(Math.round(clicks * share), 0, 0);
    pairs.push(
      {
        queryId: query.id,
        pageId: "p1",
        path: "/page-1",
        previous: split(query.previous.clicks, 0.7),
        current: split(query.current.clicks, 0.7),
      },
      {
        queryId: query.id,
        pageId: "p2",
        path: "/page-2",
        previous: split(query.previous.clicks, 0.3),
        current: split(query.current.clicks, 0.3),
      },
    );
  }
  return pairs;
}

const HEALTHY_DATA: DiagnoseInput["data"] = {
  linkHealth: "OK",
  finalThrough: FINAL_THROUGH,
  missingDays: 0,
  freshDays: 0,
  backfillDone: true,
  alertKinds: [],
};

// Sağlıklı taban: önceki 1.000, şimdiki 980 tıklama (−%2); sorgu ve sayfa
// konumları ve CTR sabit; sağlık açık ve uyarısız; güncelleme geçmişi boş.
export function drillInput(
  overrides: Partial<DiagnoseInput> = {},
): DiagnoseInput {
  const queries = queryRows(20, () => spec({ cur: 49 }));
  const pages = pageRows(10, () =>
    spec({ prev: 100, cur: 98, prevImpressions: 4000, curImpressions: 4000 }),
  );
  const total = {
    current: totals(980, 40_000, 6),
    previous: totals(1000, 40_000, 6),
  };
  return {
    metric: "clicks",
    today: TODAY,
    window: { current: { ...CURRENT }, previous: { ...PREVIOUS } },
    tables: {
      grain: "WEEK",
      current: { ...CURRENT },
      previous: { ...PREVIOUS },
      fallback: false,
    },
    pairWeeks: { current: { ...PAIR_CURRENT }, previous: { ...PAIR_PREVIOUS } },
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    yearAgo: {
      current: totals(1000, 40_000, 6),
      previous: totals(1000, 40_000, 6),
    },
    data: { ...HEALTHY_DATA, alertKinds: [] },
    health: { available: true, alerts: [], coverage: null },
    updatesAvailable: true,
    updates: [],
    queries,
    pages,
    pairs: stablePairs(queries),
    ...overrides,
  };
}

export const NO_DROP_DRILL: DiagnoseInput = drillInput();

// Toplamı düşüren, ama satırların düz kaldığı girdi: veri, indeksleme, teknik
// ve güncelleme drill'leri yalnız toplamı ve kendi nedenini değiştirir.
function flatDrill(overrides: Partial<DiagnoseInput>): DiagnoseInput {
  const queries = queryRows(20, () => spec());
  const total = {
    current: totals(700, 40_000, 6),
    previous: totals(1000, 40_000, 6),
  };
  return drillInput({
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    queries,
    pages: pageRows(10, () =>
      spec({
        prev: 100,
        cur: 100,
        prevImpressions: 4000,
        curImpressions: 4000,
      }),
    ),
    pairs: stablePairs(queries),
    ...overrides,
  });
}

// Üç sayfa tıklamasının tamamını kaybeder (toplam −%30).
function lostThreePages(
  options: (index: number) => PageOptions,
): DiagnosePage[] {
  return pageRows(
    10,
    (index) =>
      index < 3
        ? spec({
            prev: 100,
            cur: 0,
            prevImpressions: 4000,
            curImpressions: 0,
          })
        : spec({
            prev: 100,
            cur: 100,
            prevImpressions: 4000,
            curImpressions: 4000,
          }),
    options,
  );
}

function demandDrill(): DiagnoseInput {
  // Eşleşen sorguların gösterimi −%35, konum ve CTR aynı.
  const queries = queryRows(20, () => spec({ cur: 33, curImpressions: 1300 }));
  const total = {
    current: totals(660, 26_000, 6),
    previous: totals(1000, 40_000, 6),
  };
  return drillInput({
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    queries,
    pages: pageRows(10, () =>
      spec({ prev: 100, cur: 66, prevImpressions: 4000, curImpressions: 2600 }),
    ),
    pairs: stablePairs(queries),
  });
}

function rankingDrill(): DiagnoseInput {
  // Konum 6 → 9; gösterim aynı, bu yüzden CTR de aynı oranda düşer.
  const queries = queryRows(20, () => spec({ cur: 35, curPosition: 9 }));
  const total = {
    current: totals(700, 40_000, 9),
    previous: totals(1000, 40_000, 6),
  };
  return drillInput({
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    queries,
    pages: pageRows(10, () =>
      spec({
        prev: 100,
        cur: 70,
        prevImpressions: 4000,
        curImpressions: 4000,
        curPosition: 9,
      }),
    ),
    pairs: stablePairs(queries),
  });
}

function ctrDrill(): DiagnoseInput {
  // Konum ve gösterim aynı, tıklama −%34: CTR −%34.
  const queries = queryRows(20, () => spec({ cur: 33 }));
  const total = {
    current: totals(660, 40_000, 6),
    previous: totals(1000, 40_000, 6),
  };
  return drillInput({
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    queries,
    pages: pageRows(10, () =>
      spec({ prev: 100, cur: 66, prevImpressions: 4000, curImpressions: 4000 }),
    ),
    pairs: stablePairs(queries),
  });
}

function cannibalizationDrill(): DiagnoseInput {
  // Yamyamlanan 3 sorgu 1.000 tıklamanın 300'ünü taşır ve 120 kaybeder; eşleşen
  // CTR yaklaşık −%12 (−%15 eşiğinin üstünde), konum ve gösterim aynı. Toplamın
  // geri kalan düşüşü listelenen satırların dışındaki uzun kuyrukta.
  const queries = queryRows(17, (index) =>
    index < 3
      ? spec({
          prev: 100,
          cur: 60,
          prevImpressions: 4000,
          curImpressions: 4000,
        })
      : spec(),
  );
  const pages: DiagnosePage[] = [
    pageRow(
      "p-old",
      "/old",
      spec({ prev: 240, cur: 60, prevImpressions: 4000, curImpressions: 4000 }),
    ),
    pageRow(
      "p-new",
      "/new",
      spec({ prev: 60, cur: 120, prevImpressions: 4000, curImpressions: 4000 }),
    ),
    ...pageRows(7, () =>
      spec({
        prev: 100,
        cur: 100,
        prevImpressions: 4000,
        curImpressions: 4000,
      }),
    ),
  ];
  const moved: DiagnosePair[] = queries.slice(0, 3).flatMap((query) => [
    {
      queryId: query.id,
      pageId: "p-old",
      path: "/old",
      previous: totals(80, 0, 0),
      current: totals(20, 0, 0),
    },
    {
      queryId: query.id,
      pageId: "p-new",
      path: "/new",
      previous: totals(20, 0, 0),
      current: totals(40, 0, 0),
    },
  ]);
  const stable = stablePairs(queries.slice(3));
  const total = {
    current: totals(980, 56_000, 6),
    previous: totals(1400, 56_000, 6),
  };
  return drillInput({
    totals: total,
    allTotals: {
      current: { ...total.current },
      previous: { ...total.previous },
    },
    queries,
    pages,
    pairs: [...moved, ...stable],
  });
}

export const DIAGNOSE_DRILLS: Readonly<Record<DiagnoseStepKey, DiagnoseInput>> =
  {
    data: flatDrill({
      data: { ...HEALTHY_DATA, missingDays: 3, alertKinds: [] },
    }),
    indexing: flatDrill({
      pages: lostThreePages((index) => (index < 3 ? { indexed: false } : {})),
      health: {
        available: true,
        alerts: [
          {
            kind: "GSC_INDEX_LOST",
            severity: "WARN",
            title: "Pages dropped out of Google's index",
          },
        ],
        coverage: null,
      },
    }),
    technical: flatDrill({
      pages: lostThreePages((index) =>
        index < 3 ? { noindex: true, indexed: null } : {},
      ),
      health: {
        available: true,
        alerts: [
          {
            kind: "SEO_KEY_PAGE_NOINDEX",
            severity: "CRITICAL",
            title: "A key page has a noindex tag",
          },
        ],
        coverage: null,
      },
    }),
    update: flatDrill({
      updates: [
        {
          name: "September 2026 core update",
          kind: "CORE",
          startedAt: "2026-09-20T00:00:00.000Z",
          endedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
    }),
    demand: demandDrill(),
    ranking: rankingDrill(),
    ctr: ctrDrill(),
    cannibalization: cannibalizationDrill(),
  };
