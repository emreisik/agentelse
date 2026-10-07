// Başlık ve meta açıklama desenleri (docs/search-agency.md "Bölünmüş testler").
// Yalnız dört bilinen belirteç vardır: {title} {h1} {site} {year}. Kullanıcı
// metninden RegExp kurulmaz; belirteçler sabit bir ayrıştırıcıyla bulunur. Saf.

const TOKEN_NAMES = ["title", "h1", "site", "year"] as const;
type TokenName = (typeof TOKEN_NAMES)[number];

const MAX_TOKENS = 3;

function tokenNameOf(value: string): TokenName | null {
  return TOKEN_NAMES.find((name) => name === value) ?? null;
}

type Part = { text: string } | { token: TokenName };

// Desen geçersizse null: bilinmeyen belirteç, eşleşmeyen ya da iç içe süslü
// parantez.
function parts(pattern: string): Part[] | null {
  const out: Part[] = [];
  let text = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "}") return null;
    if (char !== "{") {
      text += char;
      continue;
    }
    const close = pattern.indexOf("}", index + 1);
    if (close === -1) return null;
    const name = tokenNameOf(pattern.slice(index + 1, close));
    if (!name) return null;
    if (text) out.push({ text });
    text = "";
    out.push({ token: name });
    index = close;
  }
  if (text) out.push({ text });
  return out;
}

export function validatePattern(pattern: string, max: number): boolean {
  if (pattern.length === 0 || pattern.length > max) return false;
  const list = parts(pattern);
  if (!list) return false;
  const tokens = list.filter((part) => "token" in part).length;
  return tokens <= MAX_TOKENS;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Desenin sonucu; gereken bir belirteç boşsa ya da sonuç max'tan uzunsa null
// (sayfa atlanır, metin sessizce kesilmez).
export function applyTitlePattern(
  pattern: string,
  ctx: { title: string | null; h1: string | null; site: string; year: number },
  max: number,
): string | null {
  const list = parts(pattern);
  if (!list) return null;
  let result = "";
  for (const part of list) {
    if ("text" in part) {
      result += part.text;
      continue;
    }
    const value =
      part.token === "year"
        ? String(ctx.year)
        : part.token === "title"
          ? ctx.title
          : part.token === "h1"
            ? ctx.h1
            : ctx.site;
    const clean = value === null ? "" : collapse(value);
    if (!clean) return null;
    result += clean;
  }
  const final = collapse(result);
  if (!final || final.length > max) return null;
  return final;
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function bare(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

// Sayfa adresi kapsam alan adlarından biriyle aynı mı (büyük/küçük harf ve
// baştaki www. yok sayılır). Adres başına denetim: depo, doğrulayıcı ve CMS
// yolu bunu kullanır.
export function sameSite(
  pageUrl: string,
  scopeHosts: readonly string[],
): boolean {
  const host = hostOf(pageUrl);
  if (!host) return false;
  const wanted = bare(host);
  return scopeHosts.some(
    (scope) => scope.trim() !== "" && bare(scope) === wanted,
  );
}
