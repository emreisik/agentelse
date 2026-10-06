import {
  SEO_CRAWLER_TOKEN,
  SEO_VERIFY_META_NAME,
} from "@/lib/seo/audit-constants";
import {
  fnv1a64Hex,
  fnv1a64Parts,
  normalizeCrawlUrl,
} from "@/lib/seo/crawl-url";
import { inspectJsonLd, type JsonLdResult } from "@/lib/seo/jsonld";

// Sayfa denetiminin HTML katmanı (docs/google-search-console-plan.md SC-F3,
// SK4): bağımlılıksız, elle yazılmış doğrusal bir belirteçleyici ve onun
// üstünde sayfa olguları (başlık, meta, canonical, linkler, metin, JSON-LD).
// Tarayıcının yaptığı gibi bağışlayıcıdır: kapanmamış etiketler, tırnaksız
// öznitelikler ve bozuk varlıklar hata fırlatmaz; bozuk sayfa yalnız daha az
// olgu verir. Girdi 2.000.000 karakter ve belirteç sayısıyla sınırlıdır.

export type HtmlToken =
  | {
      type: "open";
      name: string;
      attrs: Record<string, string>;
      selfClosing: boolean;
    }
  | { type: "close"; name: string }
  | { type: "text"; text: string }
  | { type: "raw"; name: string; text: string };

export const HTML_MAX_CHARS = 2_000_000;
const DEFAULT_MAX_TOKENS = 20_000;
const FACTS_MAX_TOKENS = 100_000;

// İçeriği etiket olarak okunmayan öğeler. Belirteçleyici bunlar için sırayla
// "open", tek bir "raw" (içerik) ve "close" üretir; "raw" belirteci
// öznitelikleri taşımadığından (script src, type) açılış belirteci korunur.
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "noscript",
  "template",
]);
// title ve textarea RCDATA'dır: içlerindeki varlıklar çözülür.
const RCDATA = new Set(["title", "textarea"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  shy: "­",
};

function codePointText(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return "�";
  if (value >= 0xd800 && value <= 0xdfff) return "�";
  return String.fromCodePoint(value);
}

function isAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

// Doğrusal varlık çözücü: adlandırılmış (yaygın alt küme; noktalı virgülsüz
// &amp &lt &gt &quot de), ondalık ve onaltılık sayısal varlıklar.
export function decodeHtmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  let out = "";
  let position = 0;
  while (position < value.length) {
    const amp = value.indexOf("&", position);
    if (amp < 0) {
      out += value.slice(position);
      break;
    }
    out += value.slice(position, amp);
    let cursor = amp + 1;
    if (value[cursor] === "#") {
      cursor += 1;
      const hex = value[cursor] === "x" || value[cursor] === "X";
      if (hex) cursor += 1;
      const start = cursor;
      while (
        cursor < value.length &&
        cursor - start < 8 &&
        (hex
          ? /[0-9a-f]/i.test(value[cursor] ?? "")
          : /[0-9]/.test(value[cursor] ?? ""))
      ) {
        cursor += 1;
      }
      if (cursor === start) {
        out += "&";
        position = amp + 1;
        continue;
      }
      out += codePointText(parseInt(value.slice(start, cursor), hex ? 16 : 10));
      position = value[cursor] === ";" ? cursor + 1 : cursor;
      continue;
    }
    const start = cursor;
    while (
      cursor < value.length &&
      cursor - start < 10 &&
      isAlnum(value.charCodeAt(cursor))
    )
      cursor += 1;
    const name = value.slice(start, cursor);
    if (value[cursor] === ";" && Object.hasOwn(NAMED_ENTITIES, name)) {
      out += NAMED_ENTITIES[name];
      position = cursor + 1;
      continue;
    }
    const lower = name.toLowerCase();
    if (
      value[cursor] !== ";" &&
      ["amp", "lt", "gt", "quot"].includes(lower) &&
      name === lower
    ) {
      out += NAMED_ENTITIES[lower];
      position = cursor;
      continue;
    }
    out += "&";
    position = amp + 1;
  }
  return out;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// "<" bir etiket başlatıyor mu (harf, "/" + harf, "!" ya da "?").
function startsTag(html: string, lt: number): boolean {
  const next = html.charCodeAt(lt + 1);
  if (isLetter(next) || next === 33 || next === 63) return true;
  return next === 47 && isLetter(html.charCodeAt(lt + 2));
}

function readName(html: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    const code = html.charCodeAt(cursor);
    if (isSpace(code) || code === 47 || code === 62) break;
    cursor += 1;
  }
  return cursor;
}

// Ham metin öğesinin kapanışı ("</script" büyük-küçük harf duyarsız). Arama
// hep ileri gider; her "</" bir kez ziyaret edilir.
function findRawClose(html: string, from: number, name: string): number {
  let cursor = from;
  while (cursor < html.length) {
    const lt = html.indexOf("</", cursor);
    if (lt < 0) return -1;
    const candidate = html.slice(lt + 2, lt + 2 + name.length).toLowerCase();
    const after = html.charCodeAt(lt + 2 + name.length);
    if (
      candidate === name &&
      (Number.isNaN(after) || isSpace(after) || after === 47 || after === 62)
    ) {
      return lt;
    }
    cursor = lt + 2;
  }
  return -1;
}

type TagParse = { token: HtmlToken | null; next: number };

// "<" konumundan bir açılış etiketi okur; öznitelikler tırnaklı, tırnaksız
// ya da değersiz olabilir. İlk görülen öznitelik kazanır (tarayıcı gibi).
function parseOpenTag(html: string, lt: number): TagParse {
  const nameEnd = readName(html, lt + 1, html.length);
  const name = html.slice(lt + 1, nameEnd).toLowerCase();
  const attrs = new Map<string, string>();
  let cursor = nameEnd;
  let selfClosing = false;
  while (cursor < html.length) {
    const code = html.charCodeAt(cursor);
    if (isSpace(code)) {
      cursor += 1;
      continue;
    }
    if (code === 62) {
      cursor += 1;
      return {
        token: {
          type: "open",
          name,
          attrs: Object.fromEntries(attrs),
          selfClosing,
        },
        next: cursor,
      };
    }
    if (code === 47) {
      selfClosing = html.charCodeAt(cursor + 1) === 62;
      cursor += 1;
      continue;
    }
    selfClosing = false;
    const attrStart = cursor;
    cursor += 1;
    while (cursor < html.length) {
      const inner = html.charCodeAt(cursor);
      if (isSpace(inner) || inner === 47 || inner === 62 || inner === 61) break;
      cursor += 1;
    }
    const attrName = html.slice(attrStart, cursor).toLowerCase();
    while (cursor < html.length && isSpace(html.charCodeAt(cursor)))
      cursor += 1;
    let value = "";
    if (html.charCodeAt(cursor) === 61) {
      cursor += 1;
      while (cursor < html.length && isSpace(html.charCodeAt(cursor)))
        cursor += 1;
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, cursor + 1);
        if (close < 0) return { token: null, next: html.length };
        value = html.slice(cursor + 1, close);
        cursor = close + 1;
      } else {
        const valueStart = cursor;
        while (cursor < html.length) {
          const inner = html.charCodeAt(cursor);
          if (isSpace(inner) || inner === 62) break;
          cursor += 1;
        }
        value = html.slice(valueStart, cursor);
      }
    }
    if (attrName && !attrs.has(attrName))
      attrs.set(attrName, decodeHtmlEntities(value));
  }
  // Dosya etiketin içinde bitti: tarayıcı da bu etiketi atar.
  return { token: null, next: html.length };
}

export function tokenizeHtml(
  html: string,
  options?: { maxTokens?: number },
): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const maxTokens = Math.max(1, options?.maxTokens ?? DEFAULT_MAX_TOKENS);
  const source =
    html.length > HTML_MAX_CHARS ? html.slice(0, HTML_MAX_CHARS) : html;
  const push = (token: HtmlToken) => {
    if (tokens.length < maxTokens) tokens.push(token);
  };
  try {
    let position = 0;
    while (position < source.length && tokens.length < maxTokens) {
      let lt = source.indexOf("<", position);
      while (lt >= 0 && !startsTag(source, lt))
        lt = source.indexOf("<", lt + 1);
      if (lt < 0) {
        push({
          type: "text",
          text: decodeHtmlEntities(source.slice(position)),
        });
        break;
      }
      if (lt > position)
        push({
          type: "text",
          text: decodeHtmlEntities(source.slice(position, lt)),
        });
      if (source.startsWith("<!--", lt)) {
        const end = source.indexOf("-->", lt + 4);
        position = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", lt)) {
        const end = source.indexOf("]]>", lt + 9);
        position = end < 0 ? source.length : end + 3;
        continue;
      }
      const marker = source[lt + 1];
      if (marker === "!" || marker === "?") {
        const end = source.indexOf(">", lt + 2);
        position = end < 0 ? source.length : end + 1;
        continue;
      }
      if (marker === "/") {
        const nameEnd = readName(source, lt + 2, source.length);
        const name = source.slice(lt + 2, nameEnd).toLowerCase();
        const end = source.indexOf(">", nameEnd);
        if (end < 0) break;
        push({ type: "close", name });
        position = end + 1;
        continue;
      }
      const parsed = parseOpenTag(source, lt);
      position = parsed.next;
      if (!parsed.token || parsed.token.type !== "open") break;
      push(parsed.token);
      const name = parsed.token.name;
      if (RAW_TEXT.has(name) && !parsed.token.selfClosing) {
        const close = findRawClose(source, position, name);
        const stop = close < 0 ? source.length : close;
        const text = source.slice(position, stop);
        push({
          type: "raw",
          name,
          text: RCDATA.has(name) ? decodeHtmlEntities(text) : text,
        });
        if (close < 0) {
          position = source.length;
          break;
        }
        push({ type: "close", name });
        const end = source.indexOf(">", close);
        position = end < 0 ? source.length : end + 1;
      }
    }
  } catch {
    // Beklenmeyen girdi: o ana kadarki belirteçler döner.
  }
  return tokens;
}

export type PageFacts = {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  robotsMeta: string | null;
  noindex: boolean;
  nofollow: boolean;
  canonical: string | null;
  canonicalCount: number;
  canonicalResolved: string | null;
  canonicalRelative: boolean;
  baseHref: string | null;
  lang: string | null;
  hreflang: { lang: string; href: string }[];
  h1: string[];
  h2: string[];
  wordCount: number;
  textHash: string;
  textSimhash: string;
  links: { href: string; anchor: string; nofollow: boolean }[];
  imagesTotal: number;
  imagesNoAlt: number;
  jsonLd: JsonLdResult;
  openGraph: {
    title: string | null;
    description: string | null;
    image: string | null;
    type: string | null;
  };
  scripts: { external: number; inlineBytes: number; srcs: string[] };
  stylesheets: string[];
  mixedContent: string[];
  metaRefresh: string | null;
  verificationTokens: string[];
  renderRisk: boolean;
  bytes: number;
  truncated: boolean;
};

const TEXT_MAX = 300;
const HEADING_MAX = 200;
const HEADINGS_MAX = 20;
const LINKS_MAX = 1_000;
const ANCHOR_MAX = 200;
const HREFLANG_MAX = 50;
const LIST_MAX = 20;
const JSONLD_BLOCKS_MAX = 20;
const SPA_ROOT_IDS = new Set(["root", "app", "__next", "__nuxt"]);
const ROBOTS_META_NAMES = new Set([
  "robots",
  "googlebot",
  SEO_CRAWLER_TOKEN.toLowerCase(),
]);
const NOFOLLOW_RELS = new Set(["nofollow", "ugc", "sponsored"]);
// Karma içerik sayılan alt kaynaklar (öznitelik adıyla).
const SUBRESOURCE_ATTR: Record<string, string> = {
  img: "src",
  script: "src",
  iframe: "src",
  source: "src",
  video: "src",
  audio: "src",
  embed: "src",
};
// Satır içi öğeler kelimeleri ayırmaz ("foo<b>bar</b>" tek kelime).
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "dfn",
  "em",
  "i",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

function collapse(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function resolveUrl(href: string, base: string): URL | null {
  try {
    return new URL(href.trim(), base);
  } catch {
    return null;
  }
}

function hasScheme(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href.trim()) || href.trim().startsWith("//")
  );
}

function relTokens(value: string | undefined): string[] {
  return (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function directives(value: string): string[] {
  return value
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

// Unicode boşluklarına göre bölünür; harf ya da rakam içeren parçalar kelimedir.
export function visibleWords(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word && WORD_CHAR.test(word));
}

const ZERO_SIMHASH = "0000000000000000";
const encoder = new TextEncoder();

// 3 kelimelik kayan parçalar (shingle), her biri FNV-1a 64 ile özetlenir;
// bit sayımları iki 32 bit yarımla tutulur, sonuç BigInt ile birleştirilir.
export function simhash64(words: readonly string[]): string {
  if (!words.length) return ZERO_SIMHASH;
  const counts = new Array<number>(64).fill(0);
  const shingles = Math.max(1, words.length - 2);
  for (let index = 0; index < shingles; index += 1) {
    const { hi, lo } = fnv1a64Parts(
      encoder.encode(words.slice(index, index + 3).join(" ")),
    );
    for (let bit = 0; bit < 32; bit += 1) {
      counts[bit] = (counts[bit] ?? 0) + ((lo >>> bit) & 1 ? 1 : -1);
      counts[bit + 32] = (counts[bit + 32] ?? 0) + ((hi >>> bit) & 1 ? 1 : -1);
    }
  }
  let value = BigInt(0);
  for (let bit = 63; bit >= 0; bit -= 1) {
    value =
      (value << BigInt(1)) | ((counts[bit] ?? 0) > 0 ? BigInt(1) : BigInt(0));
  }
  return value.toString(16).padStart(16, "0");
}

function popcount32(value: number): number {
  let v = value >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// İki simhash arasındaki farklı bit sayısı; bozuk girdi 64 (en uzak).
export function simhashDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  const hi = parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16);
  const lo = parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16);
  return popcount32(hi) + popcount32(lo);
}

// X-Robots-Tag başlıkları (Google biçimi): her değer virgülle bölünür; "ua:"
// öneki aynı değerde ardından gelen yönergelere uygulanır. Öneksiz yönergeler,
// "googlebot:" ve kendi belirtecimiz sayılır; başka botlar yok sayılır.
const VALUE_DIRECTIVES = new Set([
  "unavailable_after",
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
]);

export function parseXRobotsTag(
  values: readonly string[],
  token: string = SEO_CRAWLER_TOKEN,
): { noindex: boolean; nofollow: boolean; raw: string | null } {
  const own = token.toLowerCase();
  let noindex = false;
  let nofollow = false;
  const raws: string[] = [];
  for (const value of values) {
    if (!value.trim()) continue;
    raws.push(value.trim());
    let agent: string | null = null;
    for (const part of value.split(",")) {
      let directive = part.trim().toLowerCase();
      if (!directive) continue;
      const colon = directive.indexOf(":");
      if (colon > 0) {
        const prefix = directive.slice(0, colon).trim();
        if (!VALUE_DIRECTIVES.has(prefix)) {
          agent = prefix;
          directive = directive.slice(colon + 1).trim();
        }
      }
      const applies = agent === null || agent === "googlebot" || agent === own;
      if (!applies || !directive) continue;
      if (directive === "noindex" || directive === "none") noindex = true;
      if (directive === "nofollow" || directive === "none") nofollow = true;
    }
  }
  return {
    noindex,
    nofollow,
    raw: raws.length ? raws.join(", ").slice(0, 500) : null,
  };
}

function emptyFacts(bytes: number, truncated: boolean): PageFacts {
  return {
    title: null,
    titleCount: 0,
    metaDescription: null,
    metaDescriptionCount: 0,
    robotsMeta: null,
    noindex: false,
    nofollow: false,
    canonical: null,
    canonicalCount: 0,
    canonicalResolved: null,
    canonicalRelative: false,
    baseHref: null,
    lang: null,
    hreflang: [],
    h1: [],
    h2: [],
    wordCount: 0,
    textHash: fnv1a64Hex(""),
    textSimhash: ZERO_SIMHASH,
    links: [],
    imagesTotal: 0,
    imagesNoAlt: 0,
    jsonLd: { types: [], errors: [], items: [] },
    openGraph: { title: null, description: null, image: null, type: null },
    scripts: { external: 0, inlineBytes: 0, srcs: [] },
    stylesheets: [],
    mixedContent: [],
    metaRefresh: null,
    verificationTokens: [],
    renderRisk: false,
    bytes,
    truncated,
  };
}

function isJsonLdType(type: string | undefined): boolean {
  return (
    (type ?? "").split(";")[0]?.trim().toLowerCase() === "application/ld+json"
  );
}

// Çalıştırılan script türleri (veri blokları satır içi JS sayılmaz).
function isExecutableScript(type: string | undefined): boolean {
  const value = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    value === "" ||
    value === "module" ||
    value.includes("javascript") ||
    value.includes("ecmascript")
  );
}

type Capture = { kind: "h1" | "h2"; parts: string[] };
type AnchorCapture = {
  href: string | null;
  nofollow: boolean;
  parts: string[];
  alt: string | null;
};

export function extractPageFacts(
  html: string,
  pageUrl: string,
  options?: { truncated?: boolean },
): PageFacts {
  const bytes = utf8Length(html);
  const truncated = Boolean(options?.truncated) || html.length > HTML_MAX_CHARS;
  try {
    return extract(html, pageUrl, bytes, truncated);
  } catch {
    return emptyFacts(bytes, truncated);
  }
}

function extract(
  html: string,
  pageUrl: string,
  bytes: number,
  truncated: boolean,
): PageFacts {
  const facts = emptyFacts(bytes, truncated);
  const tokens = tokenizeHtml(html, { maxTokens: FACTS_MAX_TOKENS });
  const pageIsHttps = pageUrl.trim().toLowerCase().startsWith("https:");

  // <base href> bütün göreli adresleri etkiler; ilk geçerli olan sayılır.
  let base = pageUrl;
  for (const token of tokens) {
    if (
      token.type === "open" &&
      token.name === "base" &&
      token.attrs.href !== undefined
    ) {
      const resolved = resolveUrl(token.attrs.href, pageUrl);
      if (resolved) {
        facts.baseHref = token.attrs.href.trim();
        base = resolved.href;
      }
      break;
    }
  }

  const text: string[] = [];
  const robotsContents: string[] = [];
  const jsonBlocks: string[] = [];
  const headings: Capture[] = [];
  let anchor: AnchorCapture | null = null;
  let inHead = false;
  let svgDepth = 0;
  let spaRootEmpty = false;
  const hidden = () => inHead || svgDepth > 0;

  const finishAnchor = () => {
    if (!anchor) return;
    const current = anchor;
    anchor = null;
    if (!current.href || facts.links.length >= LINKS_MAX) return;
    const label =
      collapse(current.parts.join(" "), ANCHOR_MAX) ||
      collapse(current.alt ?? "", ANCHOR_MAX);
    facts.links.push({
      href: current.href,
      anchor: label,
      nofollow: current.nofollow,
    });
  };
  const finishHeading = (kind: "h1" | "h2") => {
    const index = headings.findIndex((capture) => capture.kind === kind);
    if (index < 0) return;
    const [capture] = headings.splice(index, 1);
    const list = kind === "h1" ? facts.h1 : facts.h2;
    if (capture && list.length < HEADINGS_MAX)
      list.push(collapse(capture.parts.join(" "), HEADING_MAX));
  };
  const addMixed = (url: URL | null) => {
    if (!pageIsHttps || !url || url.protocol !== "http:") return;
    if (
      facts.mixedContent.length < LIST_MAX &&
      !facts.mixedContent.includes(url.href)
    ) {
      facts.mixedContent.push(url.href);
    }
  };
  const addText = (value: string) => {
    if (anchor) anchor.parts.push(value);
    for (const capture of headings) capture.parts.push(value);
    if (!hidden()) text.push(value);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.type === "text") {
      addText(token.text);
      continue;
    }
    if (token.type === "raw") {
      if (token.name === "title" && svgDepth === 0) {
        facts.titleCount += 1;
        const title = collapse(token.text, TEXT_MAX);
        if (facts.title === null && title) facts.title = title;
      } else if (token.name === "textarea") {
        addText(token.text);
      }
      continue;
    }
    const name = token.name;
    if (token.type === "close") {
      if (name === "head") inHead = false;
      else if (name === "svg") svgDepth = Math.max(0, svgDepth - 1);
      else if (name === "a") finishAnchor();
      else if (name === "h1" || name === "h2") finishHeading(name);
      if (!INLINE.has(name)) text.push(" ");
      continue;
    }

    const attrs = token.attrs;
    if (!INLINE.has(name)) text.push(" ");
    switch (name) {
      case "html":
        if (facts.lang === null && attrs.lang?.trim())
          facts.lang = attrs.lang.trim().slice(0, 35);
        break;
      case "head":
        if (!token.selfClosing) inHead = true;
        break;
      case "body":
        inHead = false;
        break;
      case "svg":
        if (!token.selfClosing) svgDepth += 1;
        break;
      case "h1":
      case "h2":
        finishHeading(name);
        if (!token.selfClosing) headings.push({ kind: name, parts: [] });
        break;
      case "meta": {
        const metaName = (attrs.name ?? "").trim().toLowerCase();
        const property = (attrs.property ?? "").trim().toLowerCase();
        const content = attrs.content ?? "";
        if (metaName === "description") {
          facts.metaDescriptionCount += 1;
          const description = collapse(content, TEXT_MAX);
          if (facts.metaDescription === null && description)
            facts.metaDescription = description;
        } else if (ROBOTS_META_NAMES.has(metaName)) {
          if (content.trim()) robotsContents.push(content.trim());
        } else if (metaName === SEO_VERIFY_META_NAME) {
          if (content.trim() && facts.verificationTokens.length < LIST_MAX) {
            facts.verificationTokens.push(content.trim().slice(0, 200));
          }
        }
        const og = property.startsWith("og:")
          ? property
          : metaName.startsWith("og:")
            ? metaName
            : "";
        const ogValue = collapse(content, TEXT_MAX) || null;
        if (og === "og:title" && facts.openGraph.title === null)
          facts.openGraph.title = ogValue;
        if (og === "og:description" && facts.openGraph.description === null)
          facts.openGraph.description = ogValue;
        if (og === "og:image" && facts.openGraph.image === null)
          facts.openGraph.image = ogValue;
        if (og === "og:type" && facts.openGraph.type === null)
          facts.openGraph.type = ogValue;
        if (
          (attrs["http-equiv"] ?? "").trim().toLowerCase() === "refresh" &&
          facts.metaRefresh === null
        ) {
          facts.metaRefresh = content.trim().slice(0, TEXT_MAX);
        }
        break;
      }
      case "link": {
        const rels = relTokens(attrs.rel);
        const href = attrs.href;
        if (href === undefined) break;
        if (rels.includes("canonical")) {
          facts.canonicalCount += 1;
          if (facts.canonical === null) {
            facts.canonical = href.trim();
            facts.canonicalRelative = !hasScheme(href);
            facts.canonicalResolved = normalizeCrawlUrl(href, base);
          }
        }
        if (
          rels.includes("alternate") &&
          attrs.hreflang !== undefined &&
          facts.hreflang.length < HREFLANG_MAX
        ) {
          const resolved = normalizeCrawlUrl(href, base);
          facts.hreflang.push({
            lang: attrs.hreflang.trim(),
            href: resolved ?? href.trim(),
          });
        }
        if (rels.includes("stylesheet")) {
          const resolved = resolveUrl(href, base);
          if (resolved && facts.stylesheets.length < LIST_MAX)
            facts.stylesheets.push(resolved.href);
          addMixed(resolved);
        }
        break;
      }
      case "a":
      case "area": {
        if (name === "a") finishAnchor();
        const href = attrs.href;
        const resolved =
          href === undefined ? null : normalizeCrawlUrl(href, base);
        const nofollow = relTokens(attrs.rel).some((rel) =>
          NOFOLLOW_RELS.has(rel),
        );
        if (name === "area") {
          if (resolved && facts.links.length < LINKS_MAX) {
            facts.links.push({
              href: resolved,
              anchor: collapse(attrs.alt ?? "", ANCHOR_MAX),
              nofollow,
            });
          }
        } else if (!token.selfClosing) {
          anchor = { href: resolved, nofollow, parts: [], alt: null };
        }
        break;
      }
      case "img":
        facts.imagesTotal += 1;
        // alt="" süs görseli için doğrudur; yalnız özniteliği hiç olmayan sayılır.
        if (attrs.alt === undefined) facts.imagesNoAlt += 1;
        else if (anchor && anchor.alt === null && attrs.alt.trim())
          anchor.alt = attrs.alt;
        break;
      case "script": {
        const raw = tokens[index + 1];
        const body =
          raw && raw.type === "raw" && raw.name === "script" ? raw.text : "";
        if (isJsonLdType(attrs.type)) {
          if (jsonBlocks.length < JSONLD_BLOCKS_MAX && body.trim())
            jsonBlocks.push(body);
        } else if (attrs.src !== undefined && attrs.src.trim()) {
          facts.scripts.external += 1;
          const resolved = resolveUrl(attrs.src, base);
          if (resolved && facts.scripts.srcs.length < LIST_MAX)
            facts.scripts.srcs.push(resolved.href);
          addMixed(resolved);
        } else if (isExecutableScript(attrs.type)) {
          facts.scripts.inlineBytes += utf8Length(body);
        }
        break;
      }
      default:
        break;
    }
    const subresource = SUBRESOURCE_ATTR[name];
    if (subresource && name !== "script" && attrs[subresource] !== undefined) {
      addMixed(resolveUrl(attrs[subresource] ?? "", base));
    }
    // Boş SPA kökü: <div id="root"></div> (ardından yalnız boşluk ve kapanış).
    const id = (attrs.id ?? "").trim();
    if (SPA_ROOT_IDS.has(id) && !facts.renderRisk) {
      let cursor = index + 1;
      while (cursor < tokens.length) {
        const next = tokens[cursor];
        if (next?.type === "text" && !next.text.trim()) {
          cursor += 1;
          continue;
        }
        break;
      }
      const next = tokens[cursor];
      if (
        token.selfClosing ||
        !next ||
        (next.type === "close" && next.name === name)
      ) {
        spaRootEmpty = true;
      }
    }
  }
  finishAnchor();
  finishHeading("h1");
  finishHeading("h2");

  if (robotsContents.length) {
    facts.robotsMeta = robotsContents.join(", ").slice(0, TEXT_MAX);
    for (const directive of directives(facts.robotsMeta)) {
      if (directive === "noindex" || directive === "none") facts.noindex = true;
      if (directive === "nofollow" || directive === "none")
        facts.nofollow = true;
    }
  }

  const visible = text.join("").replace(/\s+/gu, " ").trim();
  const words = visibleWords(visible);
  facts.wordCount = words.length;
  const lowered = words.map((word) => word.toLowerCase());
  facts.textHash = fnv1a64Hex(visible.toLowerCase());
  facts.textSimhash = simhash64(lowered);
  facts.jsonLd = inspectJsonLd(jsonBlocks);
  facts.renderRisk =
    facts.wordCount < 150 &&
    (facts.scripts.external >= 3 ||
      facts.scripts.inlineBytes > 100_000 ||
      spaRootEmpty);
  return facts;
}
