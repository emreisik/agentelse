import { foldForMatch } from "@/lib/text-fold";

import type { AdsLaunchSpec } from "./launch-spec";

// Marka kapısının saf kısmı (docs/meta-ads-autonomy.md): reklamın söylediği
// her metin ve markanın "asla yapma" kuralları. Anlamsal denetim (onaysız
// iddia) sunucuda tek bir model çağrısıdır (server/ads/brand-gate.ts); burada
// yalnız kesin, tekrarlanabilir eşleşmeler vardır.

export type AdText = { field: string; text: string };

export function adTextsOf(spec: AdsLaunchSpec): AdText[] {
  const texts: AdText[] = [];
  spec.ads.forEach((ad, index) => {
    const base = `ads.${index}.creative`;
    texts.push({ field: `${base}.message`, text: ad.creative.message });
    if (ad.creative.headline) {
      texts.push({ field: `${base}.headline`, text: ad.creative.headline });
    }
    ad.creative.cards?.forEach((card, cardIndex) => {
      if (card.headline) {
        texts.push({ field: `${base}.cards.${cardIndex}.headline`, text: card.headline });
      }
      if (card.description) {
        texts.push({ field: `${base}.cards.${cardIndex}.description`, text: card.description });
      }
    });
  });
  return texts.filter((t) => t.text.trim().length > 0);
}

export type RuleHit = { field: string; rule: string };

// Kural, metinde (aksan ve büyük/küçük harf farkı olmadan) kelime sınırında
// geçiyorsa isabettir. Çok kısa kurallar ("ve") ve uzun cümle kuralları
// ("Asla garanti sonuç vaat etme") eşleşmez: o ikincisini model denetler.
export function literalRuleHits(
  texts: readonly AdText[],
  rules: readonly string[],
): RuleHit[] {
  const hits: RuleHit[] = [];
  const phrases = rules
    .map((rule) => ({ rule, folded: foldForMatch(rule).trim() }))
    .filter((r) => r.folded.length >= 4 && r.folded.split(/\s+/u).length <= 6);
  for (const { field, text } of texts) {
    const haystack = ` ${foldForMatch(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
    for (const { rule, folded } of phrases) {
      const needle = ` ${folded.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
      if (needle.trim().length >= 4 && haystack.includes(needle)) {
        hits.push({ field, rule });
      }
    }
  }
  return hits;
}
