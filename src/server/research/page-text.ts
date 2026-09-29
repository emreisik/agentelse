import { decodeEntities } from "@/server/brand/site-scan/extract";

// Pure HTML helpers for reading a web page as TEXT (the site scan, extract.ts,
// reads it for colours and logos). Regex-based on purpose: this only has to
// pull readable prose out of a marketing page for an LLM to summarise, not
// render it, and pages are already size-capped by safeFetch.

const STRIP_BLOCKS =
  /<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
// Tags that end a visual line; turned into newlines so paragraphs, list items
// and headings don't run together into one sentence.
const BLOCK_TAGS =
  /<\/?(p|div|section|article|header|footer|main|nav|aside|ul|ol|li|h[1-6]|br|tr|table|blockquote|figure|figcaption|form)\b[^>]*>/gi;
const ANY_TAG = /<[^>]+>/g;

// The named entities real pages still use for spaces, punctuation and the
// accented letters of the languages the clients write in (older Turkish and
// German sites often spell ü, ö and ç this way). decodeEntities covers the XML
// five and numeric references; anything not listed here is left as written.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  laquo: "«",
  raquo: "»",
  Ccedil: "Ç",
  ccedil: "ç",
  Ouml: "Ö",
  ouml: "ö",
  Uuml: "Ü",
  uuml: "ü",
  Auml: "Ä",
  auml: "ä",
  szlig: "ß",
  Eacute: "É",
  eacute: "é",
  Egrave: "È",
  egrave: "è",
  Agrave: "À",
  agrave: "à",
  Acirc: "Â",
  acirc: "â",
  Ecirc: "Ê",
  ecirc: "ê",
  Icirc: "Î",
  icirc: "î",
  Ocirc: "Ô",
  ocirc: "ô",
  Ucirc: "Û",
  ucirc: "û",
  Ntilde: "Ñ",
  ntilde: "ñ",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
};

function decodeNamedEntities(value: string): string {
  return value.replace(
    /&([a-zA-Z][a-zA-Z0-9]{1,8});/g,
    (whole, name: string) => NAMED_ENTITIES[name] ?? whole,
  );
}

// Readable text of an HTML page, whitespace collapsed, cut to `maxChars` at a
// word boundary. Menus and footers stay in (they name the products and pages
// too); repeated short lines are dropped so a nav bar doesn't eat the budget.
export function htmlToText(html: string, maxChars: number): string {
  const withBreaks = html
    .replace(COMMENTS, " ")
    .replace(STRIP_BLOCKS, " ")
    // A newline in the SOURCE is only whitespace in HTML; a paragraph wrapped
    // over three source lines is still one sentence. Only block tags end a
    // line, so flatten first and add the breaks afterwards.
    .replace(/\s+/g, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(ANY_TAG, " ");
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of decodeNamedEntities(decodeEntities(withBreaks)).split(
    "\n",
  )) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 2) continue;
    if (line.length < 40) {
      // Short lines are usually chrome (menu items, buttons); keep the first
      // occurrence only.
      if (seen.has(line)) continue;
      seen.add(line);
    }
    lines.push(line);
  }
  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function pageTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]
    ? decodeEntities(match[1]).replace(/\s+/g, " ").trim()
    : "";
  return title || undefined;
}

// Keywords (Turkish and English, since the clients are) that mark the pages
// worth reading beyond the home page, in priority order.
const SECTION_KEYWORDS: readonly RegExp[] = [
  /(^|[/-])(about|about-us|hakkimizda|hakkinda|kurumsal|biz-kimiz|who-we-are|our-story)([/-]|$)/i,
  /(^|[/-])(services|hizmetler|solutions|cozumler|products|urunler|urun|what-we-do)([/-]|$)/i,
  /(^|[/-])(pricing|fiyat|fiyatlar|plans|paketler)([/-]|$)/i,
];
const NOT_A_PAGE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|mp4|xml)$/i;

function sameSite(a: string, b: string): boolean {
  const strip = (host: string) => host.replace(/^www\./i, "").toLowerCase();
  return strip(a) === strip(b);
}

// Up to `max` same-site pages worth reading next to the home page: an about
// page, what they sell, what it costs. Absolute URLs without query or
// fragment, ordered by the keyword list above.
export function sectionLinks(html: string, baseUrl: string, max = 2): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const found = new Map<string, number>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1]!.trim()), base);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!sameSite(url.hostname, base.hostname)) continue;
    if (NOT_A_PAGE.test(url.pathname)) continue;
    if (url.pathname === "/" || url.pathname === base.pathname) continue;
    url.search = "";
    url.hash = "";
    const rank = SECTION_KEYWORDS.findIndex((re) => re.test(url.pathname));
    if (rank === -1) continue;
    const key = url.toString();
    found.set(key, Math.min(found.get(key) ?? rank, rank));
  }
  return [...found.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([url]) => url);
}
