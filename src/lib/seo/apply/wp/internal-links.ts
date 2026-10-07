// SC-F8: mevcut bir sayfanın ham içeriğine (content.raw) iç bağlantı ekler.
// Doğrusal bir tarayıcı kullanır: kullanıcı metninden RegExp üretilmez, büyük/küçük
// harf duyarsız arama uzunluğu koruyan bir katlama ile yapılır (Türkçe i/İ dahil).
// Kurallar (docs/search-actions.md SC-F8):
//  - BLOCK kipi (içerikte "<!-- wp:" var): yalnız <p> içindeki metin.
//  - CLASSIC kipi (blok yorumu yok): boş satırla ayrılmış, blok düzeyi etiketle
//    başlamayan parçalar paragraftır; <p> eklenmeden satır içi <a> yazılır.
//  - a, h1-h6, button, code, pre, script, style ve etiket/öznitelik içine asla.
//  - Her bağlantı için ilk uygun tam-sözcük eşleşmesi; aynı bağlantı iki kez yok.
//  - Hedefe zaten bağlantı varsa tamam sayılır (idempotent).
//  - Sayfa oluşturucu (Elementor, Divi, WPBakery, Fusion, Beaver) işaretleri varsa red.
// Saf modül; node:crypto kullanan crawl-url'e dayanır (yalnız sunucu tarafı).

import { normalizeCrawlUrl } from "@/lib/seo/crawl-url";

export type InsertLinksResult =
  | {
      ok: true;
      raw: string;
      inserted: { toUrl: string; anchor: string }[];
      // Hedefe zaten bağlantı bulunan bağlantıların çapa metinleri.
      alreadyLinked: string[];
    }
  | {
      ok: false;
      code: "builder_page" | "anchor_not_found" | "empty_content" | "too_large";
      // Bulunamayan çapa metinleri.
      missing: string[];
    };

type LinkInput = { toUrl: string; anchor: string };

const CONTENT_RAW_MAX = 200_000;

const FORBIDDEN_TAGS = new Set([
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "button",
  "code",
  "pre",
  "script",
  "style",
  "textarea",
  "svg",
  "iframe",
]);

// Klasik kipte bu etiketlerle başlayan parça paragraf sayılmaz.
const CLASSIC_BLOCK_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "table",
  "div",
  "blockquote",
  "figure",
  "pre",
  "hr",
  "section",
  "article",
  "aside",
  "form",
  "iframe",
  "script",
  "style",
]);

// İçindeki <p> metnine dokunulmaması gereken Gutenberg blokları.
const BLOCKED_WP_BLOCKS = new Set([
  "html",
  "shortcode",
  "code",
  "preformatted",
  "verse",
  "button",
  "buttons",
  "table",
]);

const BUILDER_MARKERS: readonly RegExp[] = [
  /data-elementor-type|elementor-(?:element|section|widget|column)|class\s*=\s*["'][^"']*\belementor\b/i,
  /\[\/?et_pb_|\bet_pb_(?:section|row|column|text)/i,
  /\[\/?vc_(?:row|column|section)|\bvc_row\b|wpb_wrapper/i,
  /fusion-builder|\[\/?fusion_builder/i,
  /fl-builder-content|\[\/?fl_builder/i,
];

export function hasBuilderMarkers(raw: string): boolean {
  return BUILDER_MARKERS.some((pattern) => pattern.test(raw));
}

// ---- Tarayıcı ---------------------------------------------------------------

type Token =
  | { kind: "text"; start: number; end: number }
  | { kind: "skip"; start: number; end: number }
  | { kind: "comment"; start: number; end: number }
  | {
      kind: "tag";
      start: number;
      end: number;
      name: string;
      closing: boolean;
      selfClosing: boolean;
    };

const TAG_NAME = /^[A-Za-z][A-Za-z0-9:-]*/;

// Etiketin kapanış ">" konumu (öznitelik tırnakları içindeki ">" sayılmaz);
// bulunamazsa içeriğin sonu.
function tagEnd(raw: string, from: number): number {
  let quote: string | null = null;
  let prev = "";
  for (let j = from; j < raw.length; j++) {
    const c = raw[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && prev === "=") {
      quote = c;
    } else if (c === ">") {
      return j + 1;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return raw.length;
}

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (upTo: number) => {
    if (upTo > textStart) tokens.push({ kind: "text", start: textStart, end: upTo });
  };

  while (i < raw.length) {
    if (raw[i] !== "<") {
      i++;
      continue;
    }
    if (raw.startsWith("<!--", i)) {
      flushText(i);
      const close = raw.indexOf("-->", i + 4);
      const end = close < 0 ? raw.length : close + 3;
      tokens.push({ kind: "comment", start: i, end });
      i = end;
      textStart = i;
      continue;
    }
    const next = raw[i + 1] ?? "";
    const closing = next === "/";
    const nameStart = closing ? i + 2 : i + 1;
    const nameMatch = TAG_NAME.exec(raw.slice(nameStart, nameStart + 40));
    const special = next === "!" || next === "?";
    if (!nameMatch && !special) {
      // "a < b" gibi düz "<": metin.
      i++;
      continue;
    }
    flushText(i);
    const end = tagEnd(raw, i + 1);
    const name = nameMatch ? nameMatch[0].toLowerCase() : "";
    const selfClosing = raw[end - 2] === "/";
    tokens.push({ kind: "tag", start: i, end, name, closing, selfClosing });
    i = end;
    textStart = i;
    // script/style gövdesi etiket sayılmaz: kapanışa kadar atlanır.
    if (!closing && !selfClosing && (name === "script" || name === "style")) {
      const closer = new RegExp(`</${name}`, "gi");
      closer.lastIndex = i;
      const found = closer.exec(raw);
      const stop = found ? found.index : raw.length;
      if (stop > i) tokens.push({ kind: "skip", start: i, end: stop });
      i = stop;
      textStart = i;
    }
  }
  flushText(raw.length);
  return tokens;
}

// ---- Büyük/küçük harf duyarsız arama ------------------------------------------

// Uzunluğu koruyan katlama: kod noktası başına toLowerCase, uzunluğu değişirse
// (İ -> "i̇") "i". turkish=true iken I -> ı ve İ -> i.
function fold(text: string, turkish: boolean): string {
  let out = "";
  for (const ch of text) {
    if (ch === "İ") out += "i";
    else if (turkish && ch === "I") out += "ı";
    else {
      const lower = ch.toLowerCase();
      out += lower.length === ch.length ? lower : ch;
    }
  }
  return out;
}

const WORD_BEFORE = /[\p{L}\p{N}\p{M}]$/u;
const WORD_AFTER = /^[\p{L}\p{N}\p{M}]/u;

function boundaryOk(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + length, index + length + 2);
  if (before && WORD_BEFORE.test(before)) return false;
  if (after && WORD_AFTER.test(after)) return false;
  // "&amp;" gibi bir varlığın içi değil.
  const prev = text[index - 1];
  if (prev === "&") return false;
  if (prev === "#" && text[index - 2] === "&") return false;
  return true;
}

// Metinde çapanın aday konumları (artan sırada), iki katlamayla.
function* anchorCandidates(text: string, anchor: string): Generator<number> {
  const textA = fold(text, false);
  const textT = fold(text, true);
  const needleA = fold(anchor, false);
  const needleT = fold(anchor, true);
  let from = 0;
  while (from <= text.length) {
    const a = textA.indexOf(needleA, from);
    const t = textT.indexOf(needleT, from);
    const found = a < 0 ? t : t < 0 ? a : Math.min(a, t);
    if (found < 0) return;
    yield found;
    from = found + 1;
  }
}

// ---- Bağlantı hedefleri -------------------------------------------------------

function linkKey(url: string, base: string): string | null {
  const normalized = normalizeCrawlUrl(url, base);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const host = parsed.host.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

function decodeAttr(value: string): string {
  return value
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, "&")
    .replace(/&quot;|&#0*34;/gi, '"');
}

const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// İçerikteki <a href> hedeflerinin anahtarları.
function linkedKeys(raw: string, base: string): Set<string> {
  const keys = new Set<string>();
  for (const token of tokenize(raw)) {
    if (token.kind !== "tag" || token.closing || token.name !== "a") continue;
    const match = HREF.exec(raw.slice(token.start, token.end));
    const href = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!href) continue;
    const key = linkKey(decodeAttr(href.trim()), base);
    if (key) keys.add(key);
  }
  return keys;
}

function alreadyLinkedBy(
  raw: string,
  links: readonly LinkInput[],
): { linked: LinkInput[]; pending: LinkInput[] } {
  const linked: LinkInput[] = [];
  const pending: LinkInput[] = [];
  // Hedef anahtarı her bağlantı için kendi adresine göre çözülür.
  const cache = new Map<string, Set<string>>();
  for (const link of links) {
    let keys = cache.get(link.toUrl);
    if (!keys) {
      keys = linkedKeys(raw, link.toUrl);
      cache.set(link.toUrl, keys);
    }
    const target = linkKey(link.toUrl, link.toUrl);
    if (target && keys.has(target)) linked.push(link);
    else pending.push(link);
  }
  return { linked, pending };
}

export function linksPresent(raw: string, links: readonly LinkInput[]): boolean {
  if (!links.length) return false;
  return alreadyLinkedBy(raw, links).pending.length === 0;
}

// ---- Klasik kip parçaları -----------------------------------------------------

type Chunk = { start: number; eligible: boolean };

function classicChunks(raw: string): Chunk[] {
  const chunks: Chunk[] = [];
  const separator = /\r?\n[ \t]*\r?\n/g;
  let start = 0;
  const push = (from: number, to: number) => {
    const text = raw.slice(from, to).trimStart();
    let eligible = text.length > 0 && !text.startsWith("[");
    if (eligible && text.startsWith("<")) {
      if (text.startsWith("<!--")) eligible = false;
      else {
        const closing = text[1] === "/";
        const name = TAG_NAME.exec(text.slice(closing ? 2 : 1, 42))?.[0];
        if (name && CLASSIC_BLOCK_TAGS.has(name.toLowerCase())) eligible = false;
      }
    }
    chunks.push({ start: from, eligible });
  };
  for (let m = separator.exec(raw); m; m = separator.exec(raw)) {
    push(start, m.index);
    start = m.index + m[0].length;
  }
  push(start, raw.length);
  return chunks;
}

function chunkEligibleAt(chunks: readonly Chunk[], index: number): boolean {
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid]!.start <= index) lo = mid;
    else hi = mid - 1;
  }
  return chunks[lo]?.eligible ?? false;
}

// ---- Ekleme -------------------------------------------------------------------

function escapeHref(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const WP_COMMENT = /^<!--\s*(\/)?wp:([a-z0-9/_-]+)/i;

// Çapanın ilk uygun konumu (ham içerikte mutlak indeks) ya da -1.
function findInsertion(raw: string, anchor: string, block: boolean): number {
  const tokens = tokenize(raw);
  const chunks = block ? [] : classicChunks(raw);
  const forbidden = new Map<string, number>();
  let forbiddenCount = 0;
  let inParagraph = false;
  const blockStack: string[] = [];
  let blockedDepth = 0;

  for (const token of tokens) {
    if (token.kind === "comment") {
      const match = WP_COMMENT.exec(raw.slice(token.start, token.start + 80));
      if (match) {
        inParagraph = false;
        const name = match[2]!.toLowerCase();
        const selfClosing = raw.slice(token.start, token.end).endsWith("/-->");
        if (match[1]) {
          const at = blockStack.lastIndexOf(name);
          if (at >= 0) {
            for (const gone of blockStack.splice(at)) {
              if (BLOCKED_WP_BLOCKS.has(gone)) blockedDepth--;
            }
          }
        } else if (!selfClosing) {
          blockStack.push(name);
          if (BLOCKED_WP_BLOCKS.has(name)) blockedDepth++;
        }
      }
      continue;
    }
    if (token.kind === "tag") {
      if (token.name === "p") {
        inParagraph = !token.closing && !token.selfClosing;
      } else if (FORBIDDEN_TAGS.has(token.name) && !token.selfClosing) {
        const count = forbidden.get(token.name) ?? 0;
        if (token.closing) {
          if (count > 0) {
            forbidden.set(token.name, count - 1);
            forbiddenCount--;
          }
        } else {
          forbidden.set(token.name, count + 1);
          forbiddenCount++;
        }
      }
      continue;
    }
    if (token.kind !== "text") continue;
    if (forbiddenCount > 0 || blockedDepth > 0) continue;
    if (block && !inParagraph) continue;

    const text = raw.slice(token.start, token.end);
    for (const index of anchorCandidates(text, anchor)) {
      if (!boundaryOk(text, index, anchor.length)) continue;
      const absolute = token.start + index;
      if (!block && !chunkEligibleAt(chunks, absolute)) continue;
      return absolute;
    }
  }
  return -1;
}

function validAnchor(anchor: string): boolean {
  return (
    anchor.trim().length > 0 &&
    anchor === anchor.trim() &&
    !/[<>\r\n]/.test(anchor)
  );
}

export function insertInternalLinks(
  raw: string,
  links: readonly LinkInput[],
): InsertLinksResult {
  if (raw.length > CONTENT_RAW_MAX) {
    return { ok: false, code: "too_large", missing: [] };
  }
  if (!raw.trim()) return { ok: false, code: "empty_content", missing: [] };
  if (hasBuilderMarkers(raw)) {
    return { ok: false, code: "builder_page", missing: [] };
  }

  const { linked, pending } = alreadyLinkedBy(raw, links);
  const alreadyLinked = linked.map((link) => link.anchor);
  if (!pending.length) return { ok: true, raw, inserted: [], alreadyLinked };

  const block = raw.includes("<!-- wp:");
  let current = raw;
  const inserted: LinkInput[] = [];
  const missing: string[] = [];

  for (const link of pending) {
    const at = validAnchor(link.anchor)
      ? findInsertion(current, link.anchor, block)
      : -1;
    if (at < 0) {
      missing.push(link.anchor);
      continue;
    }
    const end = at + link.anchor.length;
    current =
      current.slice(0, at) +
      `<a href="${escapeHref(link.toUrl)}">` +
      current.slice(at, end) +
      "</a>" +
      current.slice(end);
    inserted.push({ toUrl: link.toUrl, anchor: link.anchor });
  }

  // Ya hep ya hiç: bulunamayan çapa varsa hiçbir şey yazılmaz.
  if (missing.length) return { ok: false, code: "anchor_not_found", missing };
  return { ok: true, raw: current, inserted, alreadyLinked };
}
