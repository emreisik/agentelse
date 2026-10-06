import { foldForMatch, tokenizeFolded } from "@/lib/text-fold";

import { LOCAL_MARKERS, PLACE_NAMES } from "./places";
import { hasPhrase } from "./tokens";

// Kural tabanlı arama niyeti ve yerel niyet (docs/google-search-console-plan.md
// SC-F4). Kurallar önce sınıflar; karar veremediği (null) sorgular yeterince
// gösterimliyse LLM'e gider. Eşleştirme katlanmış sözcüklerle ve sözcük
// sınırıyla yapılır: "İndirim", "indirim" ve "INDIRIM" aynıdır, "stop" "top"
// değildir. Saf ve izomorfik.

// SEO_INTENTS ile aynı dizgiler.
export type SeoQueryIntent =
  "informational" | "commercial" | "transactional" | "navigational";

function phrases(values: readonly string[]): string[] {
  return values.map((value) => foldForMatch(value).replace(/\s+/g, " ").trim());
}

const TRANSACTIONAL = phrases([
  "buy",
  "price",
  "cost",
  "cheap",
  "discount",
  "coupon",
  "order",
  "book",
  "hire",
  "quote",
  "fiyat",
  "fiyatı",
  "satın al",
  "ucuz",
  "indirim",
  "sipariş",
  "randevu",
  "kirala",
]);

const COMMERCIAL = phrases([
  "best",
  "top",
  "vs",
  "versus",
  "review",
  "reviews",
  "compare",
  "comparison",
  "alternative",
  "en iyi",
  "karşılaştırma",
  "yorum",
  "yorumları",
  "önerileri",
]);

// Sorgunun başındaki soru sözcükleri.
const QUESTION_STARTS = phrases([
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "can",
  "does",
  "do",
  "is",
  "are",
  "should",
  "nasıl",
  "neden",
  "niçin",
  "ne",
  "nedir",
  "nerede",
  "kim",
  "hangi",
  "kaç",
]);

// Türkçe soru eki (katlanınca mı/mi → "mi", mu/mü → "mu").
const TURKISH_QUESTION_PARTICLES: ReadonlySet<string> = new Set(["mi", "mu"]);

function anyPhrase(
  tokens: readonly string[],
  list: readonly string[],
): boolean {
  return list.some((phrase) => hasPhrase(tokens, phrase));
}

export function ruleIntent(
  query: string,
  options: { isBrand: boolean },
): SeoQueryIntent | null {
  if (options.isBrand) return "navigational";
  const tokens = tokenizeFolded(query);
  if (tokens.length === 0) return null;
  if (anyPhrase(tokens, TRANSACTIONAL)) return "transactional";
  if (anyPhrase(tokens, COMMERCIAL)) return "commercial";
  if (QUESTION_STARTS.includes(tokens[0]!)) return "informational";
  if (query.trim().endsWith("?")) return "informational";
  if (tokens.some((token) => TURKISH_QUESTION_PARTICLES.has(token))) {
    return "informational";
  }
  return null;
}

// Sorgudaki yerleşik yer adları (katlanmış), ilk geçiş sırasıyla.
export function placesIn(query: string): string[] {
  const tokens = tokenizeFolded(query);
  if (tokens.length === 0) return [];
  const found: { place: string; index: number }[] = [];
  for (const place of PLACE_NAMES) {
    const parts = place.split(" ");
    for (let start = 0; start + parts.length <= tokens.length; start += 1) {
      if (parts.every((part, offset) => tokens[start + offset] === part)) {
        found.push({ place, index: start });
        break;
      }
    }
  }
  return found
    .sort((a, b) => a.index - b.index || a.place.localeCompare(b.place))
    .map((item) => item.place);
}

// Yakınlık belirteci ya da bilinen bir yer adı içeren sorgu.
export function isLocalQuery(query: string): boolean {
  const tokens = tokenizeFolded(query);
  if (tokens.length === 0) return false;
  if (anyPhrase(tokens, LOCAL_MARKERS)) return true;
  return placesIn(query).length > 0;
}
