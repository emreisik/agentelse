import { pathOf } from "@/lib/seo/crawl-url";

// Kaybolan adresler ve 301 haritası (docs/google-search-console-plan.md
// SH27): taşınan ya da silinen sayfa için en yakın yeni sayfa, yol + başlık
// + H1 kelimelerinin Jaccard benzerliğiyle bulunur. Harita isteğe bağlı
// hesaplanır, saklanmaz. Saf modül.

export type LostReason =
  | "NOT_FOUND"
  | "GONE"
  | "SERVER_ERROR"
  | "TO_HOMEPAGE"
  | "TO_UNRELATED"
  | "NOINDEX";
export type LostUrl = {
  url: string;
  title: string | null;
  clicks: number;
  reason: LostReason;
};
export type RedirectTarget = {
  url: string;
  title: string | null;
  h1: string | null;
};

// Aksan kaldırıldıktan sonraki biçimleriyle (ş → s, ı → i) küçük bir İngilizce
// ve Türkçe dolgu kelimesi listesi; adres parçaları da (www, html) dahil.
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "you",
  "your",
  "our",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "an",
  "is",
  "it",
  "or",
  "as",
  "be",
  "how",
  "what",
  "why",
  "about",
  "into",
  "all",
  "new",
  "ve",
  "ile",
  "bir",
  "bu",
  "icin",
  "da",
  "de",
  "mi",
  "mu",
  "ne",
  "gibi",
  "daha",
  "en",
  "cok",
  "olan",
  "olarak",
  "ama",
  "veya",
  "ya",
  "hem",
  "ki",
  "her",
  "nasil",
  "neden",
  "nedir",
  "ise",
  "www",
  "html",
  "htm",
  "php",
  "aspx",
  "index",
]);

const MIN_RELATED = 0.15;
const DEFAULT_MIN_SCORE = 0.3;

// Unicode küçük harf, aksanlar atılır; harf/rakam dışı her karakterde (- _ /
// dahil) bölünür; tek karakterli ve dolgu kelimeleri atılır; tekrarlar bir kez.
export function textTokens(text: string): string[] {
  const folded = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ı/g, "i");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (
      Array.from(token).length <= 1 ||
      STOPWORDS.has(token) ||
      seen.has(token)
    )
      continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function tokenSimilarity(
  a: readonly string[],
  b: readonly string[],
): number {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size && !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function pathname(url: string): string | null {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return null;
  }
}

function decodedPath(url: string): string {
  const path = pathOf(url);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function pageTokens(url: string, ...texts: (string | null)[]): string[] {
  return textTokens([decodedPath(url), ...texts.filter(Boolean)].join(" "));
}

// Ana sayfaya ya da ilgisiz bir sayfaya yönlenen adres, Google için çoğu
// zaman "soft 404"tür.
export function isUnrelatedRedirect(input: {
  fromUrl: string;
  fromTitle: string | null;
  toUrl: string;
  toTitle: string | null;
}): LostReason | null {
  const fromPath = pathname(input.fromUrl);
  const toPath = pathname(input.toUrl);
  if (fromPath === null || toPath === null) return null;
  if (fromPath !== "/" && toPath === "/") return "TO_HOMEPAGE";
  const from = pageTokens(input.fromUrl, input.fromTitle);
  if (!from.length) return null;
  const to = pageTokens(input.toUrl, input.toTitle);
  return tokenSimilarity(from, to) < MIN_RELATED ? "TO_UNRELATED" : null;
}

// Tıklaması çok olandan aza doğru; hedefler birden çok eski adrese verilebilir.
export function buildRedirectMap(
  lost: readonly LostUrl[],
  targets: readonly RedirectTarget[],
  options?: { minScore?: number },
): { from: string; to: string | null; score: number }[] {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
  const prepared = targets.map((target) => ({
    url: target.url,
    tokens: pageTokens(target.url, target.title, target.h1),
  }));
  const ordered = lost
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.clicks - a.entry.clicks || a.index - b.index)
    .map(({ entry }) => entry);
  return ordered.map((entry) => {
    const tokens = pageTokens(entry.url, entry.title);
    let best: { url: string; score: number } | null = null;
    for (const target of prepared) {
      if (target.url === entry.url) continue;
      const score = tokenSimilarity(tokens, target.tokens);
      if (!best || score > best.score) best = { url: target.url, score };
    }
    const score = best ? Math.round(best.score * 1000) / 1000 : 0;
    return {
      from: entry.url,
      to: best && best.score >= minScore ? best.url : null,
      score,
    };
  });
}

// Sunucu yapılandırmasına yapıştırılacak düz metin: "<eski yol> <yeni adres>".
export function redirectMapText(
  map: readonly { from: string; to: string | null }[],
): string {
  return map
    .map((row) =>
      row.to === null
        ? `# ${pathOf(row.from)}: no close match`
        : `${pathOf(row.from)} ${row.to}`,
    )
    .join("\n");
}
