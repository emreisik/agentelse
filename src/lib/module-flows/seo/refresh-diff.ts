import { foldForMatch } from "@/lib/text-fold";

import { articleStats } from "./markdown";
import type { SeoArticle, SeoOutlineSection, SeoTarget } from "./state";

// Sayfa tazeleme kipinin "ne değişti" özeti (SC-F6): sayfanın bugünkü hali
// (tarayıcımızın okuduğu anlık görüntü) ile yeniden yazılan makale arasındaki
// fark. Saf ve izomorfik; kart bunu fark görünümünde gösterir.

export type RefreshDiff = {
  titleChanged: boolean;
  metaChanged: boolean;
  headingsAdded: string[];
  headingsRemoved: string[];
  headingsKept: number;
  wordsBefore: number | null;
  wordsAfter: number;
  // Yüzde, tam sayıya yuvarlı (+25 = yüzde yirmi beş artış); eski sayı yoksa null.
  wordsChangePct: number | null;
};

function key(text: string): string {
  return foldForMatch(text).replace(/\s+/g, " ").trim();
}

function differs(before: string | null, after: string): boolean {
  return key(before ?? "") !== key(after);
}

// Katlamaya göre tekilleştirilmiş, ilk görülen yazımla.
function distinct(values: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const value of values) {
    const k = key(value);
    if (k && !out.has(k)) out.set(k, value.trim());
  }
  return out;
}

export function refreshDiff(input: {
  target: SeoTarget;
  article: SeoArticle;
  outline: readonly SeoOutlineSection[];
}): RefreshDiff {
  const { target, article, outline } = input;
  const stats = articleStats(article.markdown);

  // Sonraki başlıklar makalenin kendi H2'leri; makalede başlık yoksa plan taslağı.
  const afterHeadings = distinct(
    stats.h2.length > 0 ? stats.h2 : outline.map((section) => section.h2),
  );
  const beforeHeadings = distinct(target.h2);

  const headingsAdded: string[] = [];
  for (const [k, text] of afterHeadings) {
    if (!beforeHeadings.has(k)) headingsAdded.push(text);
  }
  const headingsRemoved: string[] = [];
  let headingsKept = 0;
  for (const [k, text] of beforeHeadings) {
    if (afterHeadings.has(k)) headingsKept += 1;
    else headingsRemoved.push(text);
  }

  const wordsBefore = target.wordCount;
  const wordsAfter = stats.words;
  return {
    titleChanged: differs(target.title, article.title),
    metaChanged: differs(target.metaDescription, article.metaDescription),
    headingsAdded,
    headingsRemoved,
    headingsKept,
    wordsBefore,
    wordsAfter,
    wordsChangePct:
      wordsBefore !== null && wordsBefore > 0
        ? Math.round(((wordsAfter - wordsBefore) / wordsBefore) * 100)
        : null,
  };
}
