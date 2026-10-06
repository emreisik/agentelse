import { tokenizeFolded } from "@/lib/text-fold";

// Sorgu dili tahmini (docs/google-search-console-plan.md SC-F4, SO13): önce
// yazı sistemi, Latin yazıda ayırt edici harfler ve sık sözcükler. Emin
// olunamayan sorgu null kalır (ürün adları, tek sözcükler). Saf ve izomorfik.

const CYRILLIC = /\p{Script=Cyrillic}/u;
// Makedonca'ya özgü harfler (büyük ve küçük).
const MACEDONIAN_LETTERS = /[ѓќѕљњџЃЌЅЉЊЏ]/u;
const GREEK = /\p{Script=Greek}/u;
const ARABIC = /\p{Script=Arabic}/u;
const TURKISH_LETTERS = /[ğĞıİşŞ]/u;
// ö ve ü Türkçede de var: tek başına Almanca saymaz (ğ/ı/ş'siz Türkçe
// sorgu "güzel köpek" Almanca sanılmasın); ä ve ß yalnız Almancada.
const GERMAN_LETTERS = /[äßÄ]/u;

// Katlanmış sık sözcükler (tokenizeFolded çıktısıyla karşılaştırılır).
const TURKISH_WORDS: ReadonlySet<string> = new Set([
  "ve",
  "ile",
  "icin",
  "bir",
  "bu",
  "en",
  "iyi",
  "nasil",
  "nedir",
  "ne",
  "mi",
  "mu",
  "da",
  "de",
  "ki",
  "gibi",
  "daha",
  "cok",
  "veya",
  "fiyat",
  "fiyati",
  "fiyatlari",
  "yakin",
  "yakinimda",
  "nerede",
  "neden",
  "hangi",
  "ucuz",
]);

const GERMAN_WORDS: ReadonlySet<string> = new Set([
  "der",
  "die",
  "das",
  "und",
  "ist",
  "mit",
  "fur",
  "von",
  "zu",
  "ein",
  "eine",
  "nicht",
  "wie",
  "was",
  "auf",
  "im",
  "bei",
  "kaufen",
  "gunstig",
  "preis",
]);

const ENGLISH_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "how",
  "what",
  "why",
  "when",
  "where",
  "who",
  "best",
  "near",
  "me",
  "is",
  "are",
  "vs",
  "buy",
  "cheap",
  "price",
  "review",
  "reviews",
  "free",
  "online",
]);

function hasWord(tokens: readonly string[], words: ReadonlySet<string>) {
  return tokens.some((token) => words.has(token));
}

export function detectQueryLanguage(query: string): string | null {
  if (CYRILLIC.test(query)) {
    return MACEDONIAN_LETTERS.test(query) ? "mk" : "ru";
  }
  if (GREEK.test(query)) return "el";
  if (ARABIC.test(query)) return "ar";
  const tokens = tokenizeFolded(query);
  if (TURKISH_LETTERS.test(query) || hasWord(tokens, TURKISH_WORDS)) {
    return "tr";
  }
  if (GERMAN_LETTERS.test(query) || hasWord(tokens, GERMAN_WORDS)) return "de";
  if (hasWord(tokens, ENGLISH_WORDS)) return "en";
  return null;
}
