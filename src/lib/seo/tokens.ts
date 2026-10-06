import { foldForMatch, tokenizeFolded } from "@/lib/text-fold";

// Sorgu sözcükleri (docs/google-search-console-plan.md SC-F4): katlanmış
// anlamlı sözcükler (içerik açığı, küme adı, sayfa başlığı karşılaştırması)
// ve katlanmış sözcük dizisi eşleştirme (niyet ve yer belirteçleri). Saf ve
// izomorfik.

const MIN_TOKEN_LENGTH = 3;

// İngilizce ve Türkçe dolgu sözcükleri (katlanmış). 3 harften kısalar zaten
// atıldığı için burada yalnız uzunlar anlamlıdır, kısalar okunurluk için.
const STOPWORDS: ReadonlySet<string> = new Set(
  [
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "these",
    "those",
    "what",
    "which",
    "who",
    "whom",
    "how",
    "why",
    "when",
    "where",
    "are",
    "was",
    "were",
    "can",
    "does",
    "did",
    "your",
    "you",
    "our",
    "its",
    "into",
    "about",
    "near",
    "best",
    "top",
    "not",
    "but",
    "all",
    "any",
    "has",
    "have",
    "will",
    "ve",
    "ile",
    "için",
    "bir",
    "bu",
    "şu",
    "o",
    "da",
    "de",
    "ki",
    "mi",
    "mı",
    "mu",
    "mü",
    "ne",
    "nedir",
    "nasıl",
    "neden",
    "niçin",
    "hangi",
    "gibi",
    "daha",
    "çok",
    "veya",
    "ya",
    "en",
    "ise",
    "olan",
    "olarak",
    "kadar",
    "sonra",
    "önce",
  ].map(foldForMatch),
);

// Katlanmış, sırası korunmuş, tekil anlamlı sözcükler. `exclude` (ör. marka
// terimleri) katlanıp sözcüklerine ayrılır ve bütünüyle (ayraçsız) de dışlanır.
export function meaningfulTokens(
  text: string,
  exclude: readonly string[] = [],
): string[] {
  const excluded = new Set<string>();
  for (const term of exclude) {
    const tokens = tokenizeFolded(term);
    for (const token of tokens) excluded.add(token);
    if (tokens.length > 1) excluded.add(tokens.join(""));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenizeFolded(text)) {
    if (Array.from(token).length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(token) || excluded.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

// Katlanmış sözcük dizisi `phrase` (katlanmış, boşlukla ayrılmış) `tokens`
// içinde art arda geçiyor mu; sözcük sınırıyla eşleşir.
export function hasPhrase(tokens: readonly string[], phrase: string): boolean {
  const parts = phrase.split(" ").filter(Boolean);
  if (parts.length === 0 || parts.length > tokens.length) return false;
  for (let start = 0; start + parts.length <= tokens.length; start += 1) {
    if (parts.every((part, offset) => tokens[start + offset] === part)) {
      return true;
    }
  }
  return false;
}
