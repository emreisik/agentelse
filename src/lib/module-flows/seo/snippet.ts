import { foldForMatch } from "@/lib/text-fold";

import { cleanModelLine } from "./plan";
import { containsKeyword } from "./on-page";
import type { SeoSnippetVariant } from "./state";

// Başlık/meta düzeltme kipinin saf yardımcıları (SC-F6, SEO Manager "Fix a
// snippet"): modelin üç varyantını temizler, uzunluk kontrollerini ve arama
// sonucu önizlemesinin kesilmiş halini üretir. Sunucu otoritedir, kart aynı
// kontrolleri gösterir; izomorfiktir.

// title/meta: hedef uzunluk (kontroller bunu arar), titleMax/metaMax: temizlikte
// kelime sınırından kesilen üst sınır.
export const SNIPPET_LIMITS = {
  title: 60,
  titleMax: 70,
  meta: 155,
  metaMax: 170,
  variants: 3,
} as const;

// LLM'e giden sorgu özeti: Google verisidir, çağırandan en çok 10 maskelenmiş
// satır gelir (llm-budget).
export type SeoPromptQuery = {
  text: string;
  impressions: number;
  clicks: number;
  position: number | null;
};

const ANGLE_MAX = 40;

function pointsOf(text: string): string[] {
  return Array.from(text);
}

// En çok `max` karakter (Unicode kod noktası); sınır bir kelimenin ortasına
// düşerse son boşluğa kadar geri gelir. Sondaki ayraç işaretleri atılır.
function clampAtWord(text: string, max: number): string {
  const points = pointsOf(text);
  if (points.length <= max) return text;
  let cut = points.slice(0, max);
  // Sınırdaki karakter boşluksa kesim zaten kelime sonudur.
  if (!/\s/u.test(points[max] ?? "")) {
    const space = cut.findLastIndex((char) => /\s/u.test(char));
    if (space >= Math.floor(max / 2)) cut = cut.slice(0, space);
  }
  return cut
    .join("")
    .replace(/[\s,;:\-–—|/]+$/u, "")
    .trim();
}

function clampLine(raw: unknown, max: number): string {
  return clampAtWord(cleanModelLine(raw, max * 4), max);
}

// Modelin varyantları kartın varyantlarına: tek satır, kelime sınırından
// kırpılmış, boşları ve mevcut başlığın aynısını atılmış, başlığa göre
// tekilleştirilmiş, en çok üç. Mevcut başlığı olduğu gibi bırakan varyant
// atılır: doğrulama "yeni başlık sitede" diye bakar, değişmeyen başlık onu
// boşuna geçirirdi.
export function cleanSnippetVariants(
  raw: readonly { title: string; metaDescription: string; angle: string }[],
  current: { title: string | null; metaDescription: string | null },
): SeoSnippetVariant[] {
  const currentTitle = current.title ? foldForMatch(current.title).trim() : "";
  const seen = new Set<string>();
  const out: SeoSnippetVariant[] = [];
  for (const item of raw) {
    const title = clampLine(item.title, SNIPPET_LIMITS.titleMax);
    const metaDescription = clampLine(
      item.metaDescription,
      SNIPPET_LIMITS.metaMax,
    );
    if (!title || !metaDescription) continue;
    const key = foldForMatch(title).trim();
    if (key === currentTitle || seen.has(key)) continue;
    seen.add(key);
    const angle =
      clampLine(item.angle, ANGLE_MAX) || `Option ${out.length + 1}`;
    out.push({ title, metaDescription, angle });
    if (out.length >= SNIPPET_LIMITS.variants) break;
  }
  return out;
}

export type SnippetCheck = {
  id: "title_length" | "meta_length" | "keyword_in_title";
  ok: boolean;
};

// Kart her varyantın yanında bu üç işareti gösterir; anahtar kelime yoksa
// (hedef sorgu bilinmiyor) üçüncü kontrol hiç eklenmez.
export function snippetChecks(
  variant: { title: string; metaDescription: string },
  keyword: string | null,
): SnippetCheck[] {
  const titleLength = pointsOf(variant.title.trim()).length;
  const metaLength = pointsOf(variant.metaDescription.trim()).length;
  const checks: SnippetCheck[] = [
    {
      id: "title_length",
      ok: titleLength > 0 && titleLength <= SNIPPET_LIMITS.title,
    },
    {
      id: "meta_length",
      ok: metaLength > 0 && metaLength <= SNIPPET_LIMITS.meta,
    },
  ];
  const word = keyword?.trim();
  if (word) {
    checks.push({
      id: "keyword_in_title",
      ok: containsKeyword(variant.title, word),
    });
  }
  return checks;
}

// Arama sonucunda görünecek hali: sığmayan kısım "…" ile biter.
export function serpTitle(title: string): string {
  const text = title.trim();
  if (pointsOf(text).length <= SNIPPET_LIMITS.title) return text;
  return `${clampAtWord(text, SNIPPET_LIMITS.title - 1)}…`;
}

export function serpMeta(meta: string): string {
  const text = meta.trim();
  if (pointsOf(text).length <= SNIPPET_LIMITS.meta) return text;
  return `${clampAtWord(text, SNIPPET_LIMITS.meta - 1)}…`;
}
