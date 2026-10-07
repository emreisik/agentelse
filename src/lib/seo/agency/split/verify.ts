import { measuringFields } from "@/lib/seo/actions/lifecycle";
import type { VerificationCheck } from "@/lib/seo/actions/types";
import { sameText, type ObservedPage } from "@/lib/seo/actions/verify-checks";

import { splitFixKind } from "./evaluate";
import type { SplitChange, SplitChangeKind, SplitVerification } from "./types";

// Bölünmüş testin değişiklik doğrulaması (kendi tarayıcımızla örnek sayfalar).
// Yalnız TITLE_META ve SCHEMA tarayıcıyla doğrulanır; öteki türler kullanıcının
// beyanıyla ölçüme geçer. Saf; ağ ve veritabanı yok. Sunucu tarafı içindir
// (verify-checks node:crypto'ya dayanan crawl-url'yi içe aktarır).

export type SampleSnapshot = {
  pageId: string;
  title: string | null;
  metaDescription: string | null;
  schemaTypes: string[];
};

// Değişikliğin görünmesi için örneklerin en az bu oranı beklenir.
export const SPLIT_VERIFY_RATIO = 0.6;

export const SPLIT_CRAWLER_KINDS: readonly SplitChangeKind[] = [
  "TITLE_META",
  "SCHEMA",
];

export function isCrawlerKind(kind: SplitChangeKind): boolean {
  return SPLIT_CRAWLER_KINDS.includes(kind);
}

type VerifyResult = {
  verified: boolean;
  checks: VerificationCheck[];
  fetchFailed: boolean;
  reason: SplitVerification["reason"];
};

// Getirilmiş ve 200 dönmüş sayfa; başarısız getirme "gözlenmedi" sayılır.
function usable(page: ObservedPage | null): ObservedPage | null {
  if (!page || page.fetchError || page.robotsBlocked) return null;
  return page.status === 200 ? page : null;
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

function check(
  key: string,
  label: string,
  ok: boolean,
  part: number,
  total: number,
): VerificationCheck {
  return { key, label, ok, observed: `${part} of ${total} pages` };
}

// Başlık ya da meta, uygulamadan önceki hâlinden farklı mı. Desenin kendi
// sonucu da baz hâlinden farklı olacağından ayrıca desen eşlemesi gerekmez;
// yalnız desen verilen alan sayılır, hiçbiri verilmediyse ikisine de bakılır.
function changedFromBaseline(
  change: SplitChange,
  baseline: SampleSnapshot,
  page: ObservedPage,
): boolean {
  const titleOnly = change.titlePattern !== null && change.metaPattern === null;
  const metaOnly = change.metaPattern !== null && change.titlePattern === null;
  const titleChanged = !sameText(page.title, baseline.title);
  const metaChanged = !sameText(page.metaDescription, baseline.metaDescription);
  if (titleOnly) return titleChanged;
  if (metaOnly) return metaChanged;
  return titleChanged || metaChanged;
}

function tally(
  observed: readonly (ObservedPage | null)[],
  predicate: (page: ObservedPage, index: number) => boolean,
): { fetched: number; hits: number } {
  let fetched = 0;
  let hits = 0;
  observed.forEach((raw, index) => {
    const page = usable(raw);
    if (!page) return;
    fetched += 1;
    if (predicate(page, index)) hits += 1;
  });
  return { fetched, hits };
}

// observedTest/observedControl, baseline.test/baseline.control ile AYNI
// sırada hizalıdır (null: getirilemedi).
export function verifySplitSample(input: {
  kind: SplitChangeKind;
  change: SplitChange;
  baseline: { test: SampleSnapshot[]; control: SampleSnapshot[] } | null;
  observedTest: (ObservedPage | null)[];
  observedControl: (ObservedPage | null)[];
}): VerifyResult {
  const { kind, change, baseline } = input;
  if (!isCrawlerKind(kind)) {
    return { verified: false, checks: [], fetchFailed: false, reason: null };
  }

  let testHit: (page: ObservedPage, index: number) => boolean;
  let controlHit: (page: ObservedPage, index: number) => boolean;
  let testLabel: string;
  let controlLabel: string;
  if (kind === "SCHEMA") {
    const wanted = change.schemaType?.toLowerCase() ?? null;
    const has = (page: ObservedPage) =>
      wanted !== null &&
      page.schemaTypes.some((type) => type.toLowerCase() === wanted);
    testHit = (page) => has(page);
    controlHit = (page) => !has(page);
    testLabel = "Test pages show the new markup";
    controlLabel = "Control pages don't have it";
  } else {
    if (!baseline) {
      return {
        verified: false,
        checks: [],
        fetchFailed: false,
        reason: "NOT_SEEN",
      };
    }
    testHit = (page, index) => {
      const before = baseline.test[index];
      return before ? changedFromBaseline(change, before, page) : false;
    };
    // Kontrolde "isabet" = değişmemiş.
    controlHit = (page, index) => {
      const before = baseline.control[index];
      return before ? !changedFromBaseline(change, before, page) : false;
    };
    testLabel = "Test pages show the change";
    controlLabel = "Control pages are unchanged";
  }

  const test = tally(input.observedTest, testHit);
  const control = tally(input.observedControl, controlHit);
  const checks = [
    check(
      "test_changed",
      testLabel,
      ratio(test.hits, test.fetched) >= SPLIT_VERIFY_RATIO,
      test.hits,
      test.fetched,
    ),
    check(
      "control_untouched",
      controlLabel,
      control.fetched === 0 ||
        ratio(control.hits, control.fetched) >= SPLIT_VERIFY_RATIO,
      control.hits,
      control.fetched,
    ),
  ];

  if (test.fetched === 0) {
    return {
      verified: false,
      checks,
      fetchFailed: true,
      reason: "FETCH_FAILED",
    };
  }
  const testOk = ratio(test.hits, test.fetched) >= SPLIT_VERIFY_RATIO;
  // Kontrol sayfalarının çoğu da değiştiyse test kirlenmiştir.
  const controlOk =
    control.fetched === 0 ||
    ratio(control.hits, control.fetched) >= SPLIT_VERIFY_RATIO;
  if (testOk && controlOk) {
    return { verified: true, checks, fetchFailed: false, reason: null };
  }
  return {
    verified: false,
    checks,
    fetchFailed: false,
    reason: testOk && !controlOk ? "CONTROL_CHANGED" : "NOT_SEEN",
  };
}

// Ölçüme geçişin TEK hesabı: depo (kullanıcı beyanı) ve doğrulayıcı (tarayıcı,
// CMS) buradan geçer. CMS yolunda çapa, son değişikliğin doğrulandığı andır.
export function splitMeasuring(input: {
  kind: SplitChangeKind;
  appliedAt: Date;
  verifiedAt: Date;
  method: "CRAWLER" | "USER" | "CMS";
}): ReturnType<typeof measuringFields> {
  return measuringFields({
    kind: splitFixKind(input.kind),
    appliedAt: input.appliedAt,
    verifiedAt: input.verifiedAt,
    googleCrawlAt: null,
    method: input.method === "USER" ? "USER" : null,
    fromAlert: false,
  });
}
