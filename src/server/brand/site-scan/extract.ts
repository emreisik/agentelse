// Pure HTML / CSS fact extraction for the brand site scan. No network, no
// dependencies: regex-level parsing is deliberate — we only need a handful of
// well-known tags and declarations, and a hostile or malformed page must
// degrade to "less data", never to an exception or a hang.

const MAX_ATTR_TAGS = 4000; // hard ceiling on tags inspected per kind

// --- attribute + tag helpers -------------------------------------------------

export function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const body = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1]!.toLowerCase();
    if (name in attrs) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16) || 32),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number(dec) || 32),
    );
}

function tags(html: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return (html.match(re) ?? []).slice(0, MAX_ATTR_TAGS);
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (
    !trimmed ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:")
  ) {
    return undefined;
  }
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

// --- colours ------------------------------------------------------------------

export type Rgb = { r: number; g: number; b: number };

export function hexToRgb(hex: string): Rgb | null {
  let h = hex.replace(/^#/, "").toLowerCase();
  if (h.length === 3 || h.length === 4) {
    h = [...h].map((c) => c + c).join("");
  }
  if (h.length === 8) h = h.slice(0, 6); // drop alpha
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// Parses a CSS colour literal (#hex, rgb[a](), hsl[a]()) to a normalized
// lowercase 6-digit hex, or null. Mostly-transparent colours are ignored:
// they are shadows/overlays, not brand colours.
export function cssColorToHex(literal: string): string | null {
  const value = literal.trim().toLowerCase();
  if (value.startsWith("#")) {
    const rgb = hexToRgb(value);
    if (!rgb) return null;
    if (value.length === 9 && parseInt(value.slice(7, 9), 16) < 128)
      return null;
    if (value.length === 5 && parseInt(value[4]! + value[4]!, 16) < 128)
      return null;
    return rgbToHex(rgb);
  }
  const rgbMatch = value.match(
    /^rgba?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/,
  );
  if (rgbMatch) {
    const alpha = rgbMatch[4];
    if (alpha !== undefined) {
      const a = alpha.endsWith("%")
        ? parseFloat(alpha) / 100
        : parseFloat(alpha);
      if (a < 0.5) return null;
    }
    return rgbToHex({
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    });
  }
  const hslMatch = value.match(
    /^hsla?\(\s*(\d{1,3}(?:\.\d+)?)(?:deg)?[\s,]+(\d{1,3}(?:\.\d+)?)%[\s,]+(\d{1,3}(?:\.\d+)?)%(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/,
  );
  if (hslMatch) {
    const alpha = hslMatch[4];
    if (alpha !== undefined) {
      const a = alpha.endsWith("%")
        ? parseFloat(alpha) / 100
        : parseFloat(alpha);
      if (a < 0.5) return null;
    }
    return rgbToHex(
      hslToRgb(
        Number(hslMatch[1]) % 360,
        Number(hslMatch[2]) / 100,
        Number(hslMatch[3]) / 100,
      ),
    );
  }
  return null;
}

function saturation({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return 0;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Whites, blacks and greys: legitimate page colours, but not a brand's
// identity colours.
export function isNeutral(rgb: Rgb): boolean {
  return saturation(rgb) < 0.14 || luminance(rgb) > 245 || luminance(rgb) < 12;
}

const COLOR_RE =
  /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{4}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]{5,60}\)|hsla?\([^)]{5,60}\)/g;

export type ColorSignal = { hex: string; weight: number; source: string };
export type ColorCandidate = { hex: string; weight: number; sources: string[] };

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

function hueLightness({ r, g, b }: Rgb): { hue: number; lightness: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return { hue: 0, lightness };
  const d = max - min;
  const hue =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
      : max === gn
        ? ((bn - rn) / d + 2) * 60
        : ((rn - gn) / d + 4) * 60;
  return { hue, lightness };
}

// Two colours are "the same brand colour" when they are nearly identical, or
// when they share a hue and differ mainly in lightness — a base colour and
// its hover / dark / tint variants, which sites define as separate literals.
function sameFamily(a: Rgb, b: Rgb, mergeDistance: number): boolean {
  if (distance(a, b) <= mergeDistance) return true;
  if (isNeutral(a) || isNeutral(b)) return false;
  const ha = hueLightness(a);
  const hb = hueLightness(b);
  const hueGap = Math.min(
    Math.abs(ha.hue - hb.hue),
    360 - Math.abs(ha.hue - hb.hue),
  );
  // A hover / pressed variant is only slightly darker (~0.1 lightness); a
  // lighter or deeper shade of the same hue that differs by more is usually
  // a DIFFERENT role (an accent next to the logo colour), so it stays apart.
  return hueGap <= 12 && Math.abs(ha.lightness - hb.lightness) <= 0.12;
}

// Merges near-identical colours (site CSS is full of #0a58ca / #0b5ed7 /
// #0d6efd style siblings) into one candidate whose hex is the heaviest member.
export function rankColors(
  signals: readonly ColorSignal[],
  options: { limit?: number; mergeDistance?: number } = {},
): { chromatic: ColorCandidate[]; neutrals: ColorCandidate[] } {
  const limit = options.limit ?? 8;
  const mergeDistance = options.mergeDistance ?? 26;

  type Cluster = {
    hex: string;
    rgb: Rgb;
    top: number;
    weight: number;
    sources: Set<string>;
  };
  const clusters: Cluster[] = [];
  for (const signal of signals) {
    const rgb = hexToRgb(signal.hex);
    if (!rgb) continue;
    const hex = rgbToHex(rgb);
    const target = clusters.find((c) => sameFamily(c.rgb, rgb, mergeDistance));
    if (target) {
      target.weight += signal.weight;
      target.sources.add(signal.source);
      if (signal.weight > target.top) {
        target.top = signal.weight;
        target.hex = hex;
        target.rgb = rgb;
      }
    } else {
      clusters.push({
        hex,
        rgb,
        top: signal.weight,
        weight: signal.weight,
        sources: new Set([signal.source]),
      });
    }
  }

  const toCandidate = (c: Cluster): ColorCandidate => ({
    hex: c.hex,
    weight: Math.round(c.weight),
    sources: [...c.sources],
  });
  const sorted = clusters.sort((a, b) => b.weight - a.weight);
  return {
    chromatic: sorted
      .filter((c) => !isNeutral(c.rgb))
      .slice(0, limit)
      .map(toCandidate),
    neutrals: sorted
      .filter((c) => isNeutral(c.rgb))
      .slice(0, 3)
      .map(toCandidate),
  };
}

// --- CSS -----------------------------------------------------------------------

const BRANDISH = /(primary|brand|accent|main|theme|highlight|cta|secondary)/i;
const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "inherit",
  "initial",
  "unset",
  "revert",
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "helvetica",
  "helvetica neue",
  "arial",
  "roboto",
  "oxygen",
  "ubuntu",
  "cantarell",
  "fira sans",
  "droid sans",
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
  "times new roman",
  "times",
  "courier new",
  "courier",
  "georgia",
  "verdana",
  "tahoma",
]);

function cleanFontName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (!name || name.length > 60 || /^var\(|^\d/.test(name)) return null;
  if (GENERIC_FONTS.has(name.toLowerCase())) return null;
  return name;
}

export type CssFacts = {
  colorSignals: ColorSignal[];
  fonts: { name: string; count: number }[];
};

export function extractCssFacts(css: string, source = "css"): CssFacts {
  const signals: ColorSignal[] = [];

  // Custom properties: the strongest hint of intent (--brand-primary: #...).
  const varRe = /--([a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)[;}]/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = varRe.exec(css)) !== null && guard++ < 3000) {
    const hex = cssColorToHex(match[2]!.trim());
    if (hex) {
      signals.push({
        hex,
        weight: BRANDISH.test(match[1]!) ? 30 : 3,
        source: `${source}:--${match[1]}`,
      });
    }
  }

  // Every literal, by frequency (capped so one repeated grey can't dominate).
  const counts = new Map<string, number>();
  guard = 0;
  while ((match = COLOR_RE.exec(css)) !== null && guard++ < 20000) {
    const hex = cssColorToHex(match[0]);
    if (hex) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const [hex, count] of counts) {
    signals.push({ hex, weight: Math.min(count, 25), source });
  }

  // Fonts.
  const fontCounts = new Map<string, number>();
  const bump = (name: string | null, by = 1) => {
    if (name) fontCounts.set(name, (fontCounts.get(name) ?? 0) + by);
  };
  const familyRe = /font-family\s*:\s*([^;}{]+)/gi;
  guard = 0;
  while ((match = familyRe.exec(css)) !== null && guard++ < 5000) {
    const families = match[1]!.split(",");
    bump(cleanFontName(families[0]!));
  }
  const faceRe = /@font-face\s*\{[^}]*?font-family\s*:\s*([^;}]+)/gi;
  guard = 0;
  while ((match = faceRe.exec(css)) !== null && guard++ < 200) {
    bump(cleanFontName(match[1]!), 3);
  }

  return {
    colorSignals: signals,
    fonts: [...fontCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// "family=Playfair+Display:wght@400;700&family=Inter" -> ["Playfair Display","Inter"]
export function googleFontFamilies(href: string): string[] {
  const names: string[] = [];
  const re = /[?&]family=([^&:]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(href)) !== null) {
    try {
      names.push(decodeURIComponent(match[1]!.replace(/\+/g, " ")));
    } catch {
      // Ignore a malformed family parameter.
    }
  }
  return names;
}

// --- HTML ------------------------------------------------------------------------

export type LogoCandidate =
  | { kind: "img"; url: string; score: number; alt?: string }
  | { kind: "svg"; svg: string; score: number };

export type IconCandidate = { url: string; size: number };

export type HtmlFacts = {
  title?: string;
  siteName?: string;
  description?: string;
  language?: string;
  themeColor?: string;
  tileColor?: string;
  ogImage?: string;
  manifestUrl?: string;
  icons: IconCandidate[];
  logoCandidates: LogoCandidate[];
  stylesheetUrls: string[];
  inlineCss: string;
  googleFonts: string[];
};

const MAX_INLINE_SVG = 20_000;

function iconSize(sizes: string | undefined, rel: string): number {
  const first = sizes?.split(/\s+/)[0]?.match(/^(\d+)x(\d+)$/);
  if (first) return Number(first[1]);
  return rel.includes("apple-touch-icon") ? 180 : 32;
}

function logoScore(input: {
  haystack: string;
  inHeader: boolean;
  inHomeLink: boolean;
  isSvg: boolean;
}): number {
  const h = input.haystack.toLowerCase();
  let score = 0;
  if (/logo/.test(h)) score += 6;
  if (/brand|wordmark|logotype|marka/.test(h)) score += 2;
  if (input.inHeader) score += 4;
  if (input.inHomeLink) score += 3;
  if (input.isSvg) score += 1;
  if (
    /sprite|avatar|banner|hero|slide|thumb|icon-|social|footer|partner|client|testimonial|payment/.test(
      h,
    )
  ) {
    score -= 6;
  }
  return score;
}

function sanitizeSvg(svg: string): string | null {
  if (svg.length > MAX_INLINE_SVG) return null;
  const cleaned = svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
  return /<svg\b/i.test(cleaned) ? cleaned : null;
}

// Region regexes below scan forward to a closing tag; a huge page full of
// unclosed tags could make that quadratic, so only the first part of the
// document (where head, header and nav live) is ever looked at.
const MAX_HTML_CHARS = 600_000;

export function extractHtmlFacts(rawHtml: string, baseUrl: string): HtmlFacts {
  const html = rawHtml.slice(0, MAX_HTML_CHARS);
  const facts: HtmlFacts = {
    icons: [],
    logoCandidates: [],
    stylesheetUrls: [],
    inlineCss: "",
    googleFonts: [],
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch)
    facts.title = decodeEntities(
      titleMatch[1]!.replace(/\s+/g, " ").trim(),
    ).slice(0, 200);
  const langMatch = html.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i);
  if (langMatch) facts.language = langMatch[1]!.toLowerCase();

  for (const tag of tags(html, "meta")) {
    const a = parseAttrs(tag);
    const key = (a.name ?? a.property ?? "").toLowerCase();
    const content = a.content?.trim();
    if (!content) continue;
    if (key === "theme-color" && cssColorToHex(content))
      facts.themeColor ??= cssColorToHex(content)!;
    else if (key === "msapplication-tilecolor" && cssColorToHex(content))
      facts.tileColor ??= cssColorToHex(content)!;
    else if (key === "og:site_name") facts.siteName ??= content.slice(0, 120);
    else if (key === "og:image" || key === "og:image:url")
      facts.ogImage ??= absolute(content, baseUrl);
    else if (key === "description" || key === "og:description")
      facts.description ??= content.slice(0, 400);
  }

  for (const tag of tags(html, "link")) {
    const a = parseAttrs(tag);
    const rel = (a.rel ?? "").toLowerCase();
    const href = absolute(a.href, baseUrl);
    if (!href) continue;
    if (rel.includes("manifest")) facts.manifestUrl ??= href;
    else if (rel.includes("icon")) {
      facts.icons.push({ url: href, size: iconSize(a.sizes, rel) });
    } else if (rel.includes("stylesheet")) {
      if (href.includes("fonts.googleapis.com")) {
        facts.googleFonts.push(...googleFontFamilies(href));
      } else if (facts.stylesheetUrls.length < 3) {
        facts.stylesheetUrls.push(href);
      }
    }
  }

  const styleBlocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  facts.inlineCss = styleBlocks
    .map((block) => block.replace(/^<style[^>]*>|<\/style>$/gi, ""))
    .join("\n")
    .slice(0, 300_000);
  for (const importMatch of facts.inlineCss.matchAll(
    /@import\s+url\(["']?([^"')]+fonts\.googleapis\.com[^"')]*)["']?\)/gi,
  )) {
    facts.googleFonts.push(...googleFontFamilies(importMatch[1]!));
  }
  facts.googleFonts = [...new Set(facts.googleFonts)].slice(0, 6);

  // Logo candidates: <img> and inline <svg>, scored by where they sit and what
  // they are called. Header / nav regions and a link back to "/" are the
  // strongest positional signals.
  const regions: { start: number; end: number }[] = [];
  for (const m of html.matchAll(/<(header|nav)\b[\s\S]*?<\/\1>/gi)) {
    regions.push({ start: m.index!, end: m.index! + m[0].length });
  }
  const inHeader = (index: number) =>
    regions.some((r) => index >= r.start && index < r.end);
  const homeLinkRanges: { start: number; end: number }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const href = parseAttrs(m[0].match(/^<a\b[^>]*>/i)![0]).href ?? "";
    if (href === "/" || /^https?:\/\/[^/]+\/?$/.test(href)) {
      homeLinkRanges.push({ start: m.index!, end: m.index! + m[0].length });
    }
  }
  const inHomeLink = (index: number) =>
    homeLinkRanges.some((r) => index >= r.start && index < r.end);

  let imgCount = 0;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (imgCount++ > 400) break;
    const a = parseAttrs(m[0]);
    const src = absolute(a.src ?? a["data-src"] ?? a["data-lazy-src"], baseUrl);
    if (!src) continue;
    const haystack = `${a.class ?? ""} ${a.id ?? ""} ${a.alt ?? ""} ${src}`;
    const score = logoScore({
      haystack,
      inHeader: inHeader(m.index!),
      inHomeLink: inHomeLink(m.index!),
      isSvg: /\.svg(\?|$)/i.test(src),
    });
    if (score > 0)
      facts.logoCandidates.push({
        kind: "img",
        url: src,
        score,
        alt: a.alt?.slice(0, 80),
      });
  }
  let svgCount = 0;
  for (const m of html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
    if (svgCount++ > 60) break;
    const open = m[0].match(/^<svg\b[^>]*>/i)![0];
    const a = parseAttrs(open);
    const haystack = `${a.class ?? ""} ${a.id ?? ""} ${a["aria-label"] ?? ""}`;
    const score = logoScore({
      haystack,
      inHeader: inHeader(m.index!),
      inHomeLink: inHomeLink(m.index!),
      isSvg: true,
    });
    const svg = sanitizeSvg(m[0]);
    if (svg && score >= 6)
      facts.logoCandidates.push({ kind: "svg", svg, score });
  }
  facts.logoCandidates.sort((a, b) => b.score - a.score);
  facts.logoCandidates = facts.logoCandidates.slice(0, 6);
  facts.icons.sort((a, b) => b.size - a.size);

  return facts;
}

// --- social profile links ------------------------------------------------------

export type SocialPlatform =
  "instagram" | "facebook" | "linkedin" | "tiktok" | "youtube" | "x";
export type SocialLink = { platform: SocialPlatform; url: string };

const MAX_SOCIAL_LINKS = 6;
const MAX_ANCHORS = 4000;

const RESERVED_SEGMENTS = new Set([
  "share",
  "sharer",
  "sharer.php",
  "intent",
  "login",
  "login.php",
  "plugins",
  "dialog",
  "explore",
  "home",
  "search",
  "hashtag",
  "settings",
  "privacy",
  "policies",
  "help",
  "about",
  "p",
  "reel",
  "reels",
  "stories",
  "accounts",
  "direct",
  "tv",
  "i",
  "tos",
  "watch",
  "events",
  "groups",
  "marketplace",
  "tr",
  "developer",
]);

// One rule per platform: the hosts that count, and what a PROFILE path looks
// like. Anything else on these hosts (a post, a share dialog, a login page, a
// tracking pixel) is not a profile and is dropped.
const SOCIAL_RULES: {
  platform: SocialPlatform;
  hosts: readonly string[];
  path: (segments: string[]) => boolean;
}[] = [
  {
    platform: "instagram",
    hosts: ["instagram.com", "www.instagram.com"],
    path: (s) =>
      s.length === 1 &&
      /^[A-Za-z0-9._]{1,30}$/.test(s[0]!) &&
      !RESERVED_SEGMENTS.has(s[0]!.toLowerCase()),
  },
  {
    platform: "facebook",
    hosts: ["facebook.com", "www.facebook.com"],
    path: (s) =>
      (s.length === 1 &&
        /^[A-Za-z0-9.-]{3,80}$/.test(s[0]!) &&
        !RESERVED_SEGMENTS.has(s[0]!.toLowerCase())) ||
      (s.length === 3 && s[0] === "pages" && /^\d+$/.test(s[2]!)),
  },
  {
    platform: "linkedin",
    hosts: ["linkedin.com", "www.linkedin.com"],
    path: (s) =>
      s.length === 2 &&
      ["company", "in", "school"].includes(s[0]!.toLowerCase()) &&
      /^[^\s/]{1,100}$/.test(s[1]!),
  },
  {
    platform: "tiktok",
    hosts: ["tiktok.com", "www.tiktok.com"],
    path: (s) => s.length === 1 && /^@[A-Za-z0-9._]{2,24}$/.test(s[0]!),
  },
  {
    platform: "youtube",
    hosts: ["youtube.com", "www.youtube.com"],
    path: (s) =>
      (s.length === 1 && /^@[\w.-]{2,60}$/.test(s[0]!)) ||
      (s.length === 2 &&
        ["channel", "c", "user"].includes(s[0]!) &&
        /^[\w.-]{1,100}$/.test(s[1]!)),
  },
  {
    platform: "x",
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    path: (s) =>
      s.length === 1 &&
      /^[A-Za-z0-9_]{1,15}$/.test(s[0]!) &&
      !RESERVED_SEGMENTS.has(s[0]!.toLowerCase()),
  },
];

// Profile links of the brand's own social accounts, from <a href> only (never
// from scripts, JSON-LD or meta: those are harder to trust and to bound). Only
// https survives after resolving against the page, the query string and hash
// are dropped, one link per platform (the first in document order), at most 6.
// Pure: no network.
export function extractSocialLinks(
  html: string,
  baseUrl: string,
): SocialLink[] {
  const found = new Map<SocialPlatform, string>();
  let inspected = 0;
  for (const match of html.slice(0, MAX_HTML_CHARS).matchAll(/<a\b[^>]*>/gi)) {
    inspected += 1;
    if (inspected > MAX_ANCHORS) break;
    const href = parseAttrs(match[0]).href?.trim();
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    if (url.port && url.port !== "443") continue;
    const host = url.hostname.toLowerCase();
    const rule = SOCIAL_RULES.find((r) => r.hosts.includes(host));
    if (!rule || found.has(rule.platform)) continue;
    let segments: string[];
    try {
      segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    } catch {
      continue;
    }
    if (!rule.path(segments)) continue;
    found.set(
      rule.platform,
      `https://${host}${url.pathname.replace(/\/+$/, "")}`,
    );
    if (found.size >= MAX_SOCIAL_LINKS) break;
  }
  return [...found].map(([platform, link]) => ({ platform, url: link }));
}
