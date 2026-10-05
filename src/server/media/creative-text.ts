import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { contrastRatio, relativeLuminance } from "@/lib/color-contrast";
import type { HeadlineZone, TextPlacement } from "@/lib/layout-templates";
import { parseFont, type OutlineFont } from "@/server/media/font-outline";

// The words a post carries on its picture (its headline and an optional
// sub-line), typeset by us in the layout's headline zone — never drawn by the
// image model, which misspells (Turkish letters above all) and places text
// wherever it likes. Glyphs become vector paths (font-outline.ts), so sharp
// renders them with no font installed. The colour comes from the picture
// under the words (white or the brand's dark colour, plus a soft scrim when
// the area is busy or mid-tone), the font from the brand kit when Google
// Fonts has it, else the bundled Inter.

export type OnImageText = {
  headline: string;
  // Words of the headline set in the brand's accent colour.
  highlight?: string;
  // Shorter supporting texts under the headline (at most 2 are set).
  lines?: string[];
};

export type Rect = { left: number; top: number; width: number; height: number };

type Anchor = "top" | "center" | "bottom";

// --- fonts --------------------------------------------------------------------

export type TextFonts = { headline: OutlineFont; body: OutlineFont };

const FONT_DIR = path.join(process.cwd(), "src", "server", "media", "fonts");
const bundled = new Map<string, Promise<OutlineFont>>();

// Inter (SIL OFL 1.1, rsms/inter): Latin, Latin Extended (Turkish) and
// Cyrillic, so every brand's words have glyphs.
function bundledFont(
  file: "inter-600.woff" | "inter-400.woff",
): Promise<OutlineFont> {
  let font = bundled.get(file);
  if (!font) {
    font = readFile(path.join(FONT_DIR, file)).then(parseFont);
    // A failed read is retried next time instead of failing forever.
    font.catch(() => bundled.delete(file));
    bundled.set(file, font);
  }
  return font;
}

const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 -]{1,59}$/;
const GOOGLE_TTF = /url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/;
const MAX_FONT_BYTES = 4 * 1024 * 1024;
const brandFonts = new Map<string, Promise<OutlineFont | null>>();

// A non-browser request to Google Fonts' CSS API answers with one TrueType
// file for the family; a family it does not have (or a weight the family
// lacks) answers 400. Best-effort and remembered per process.
async function fetchGoogleFont(
  family: string,
  weight: number,
): Promise<OutlineFont | null> {
  const query = encodeURIComponent(family).replace(/%20/g, "+");
  const css = await fetch(
    `https://fonts.googleapis.com/css2?family=${query}:wght@${weight}`,
    { signal: AbortSignal.timeout(4000) },
  );
  if (!css.ok) return null;
  const url = GOOGLE_TTF.exec(await css.text())?.[1];
  if (!url) return null;
  const file = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!file.ok) return null;
  const bytes = Buffer.from(await file.arrayBuffer());
  return bytes.byteLength > MAX_FONT_BYTES ? null : parseFont(bytes);
}

function brandFont(
  family: string,
  weight: 400 | 700,
): Promise<OutlineFont | null> {
  const key = `${family.toLowerCase()}:${weight}`;
  let font = brandFonts.get(key);
  if (!font) {
    font = fetchGoogleFont(family, weight).catch(() => null);
    brandFonts.set(key, font);
  }
  return font;
}

function covers(font: OutlineFont, text: string): boolean {
  for (const char of text) {
    if (/\s/.test(char)) continue;
    if (font.glyphIndex(char.codePointAt(0)!) === 0) return false;
  }
  return true;
}

// The brand's own font when it is a Google font that has every letter of
// these words; Inter otherwise.
export async function loadTextFonts(
  family: string | null | undefined,
  text: { headline: string; body: string },
): Promise<TextFonts> {
  const [interBold, interRegular] = await Promise.all([
    bundledFont("inter-600.woff"),
    bundledFont("inter-400.woff"),
  ]);
  const name = family?.trim();
  if (!name || !FAMILY.test(name)) {
    return { headline: interBold, body: interRegular };
  }
  const regular = await brandFont(name, 400);
  const bold = (await brandFont(name, 700)) ?? regular;
  return {
    headline: bold && covers(bold, text.headline) ? bold : interBold,
    body: regular && covers(regular, text.body) ? regular : interRegular,
  };
}

// --- where the words go --------------------------------------------------------

// Mirrors the gallery preview (components/brand/layout-preview.tsx): the same
// zone widths and edge offsets, as fractions of the canvas, so a post looks
// like the layout the client picked.
const ZONE_LEFT: Record<HeadlineZone, number> = {
  TOP: 0.08,
  UPPER_LEFT: 0.08,
  CENTER: 0.1,
  LEFT_COLUMN: 0.08,
  BOTTOM: 0.08,
};
const ZONE_WIDTH: Record<HeadlineZone, number> = {
  TOP: 0.84,
  UPPER_LEFT: 0.62,
  CENTER: 0.8,
  LEFT_COLUMN: 0.5,
  BOTTOM: 0.84,
};
// The most of the canvas height the words may take in each zone.
const ZONE_MAX_HEIGHT: Record<HeadlineZone, number> = {
  TOP: 0.36,
  UPPER_LEFT: 0.36,
  CENTER: 0.52,
  LEFT_COLUMN: 0.64,
  BOTTOM: 0.36,
};
const EDGE_OFFSET = 0.11; // preview: a top headline starts 11% down
const BOTTOM_OFFSET = 0.09; // ...a bottom one ends 9% up
const CLEARANCE = 0.035; // between the words and a logo / bar / UI band

export function textZone(input: {
  width: number;
  height: number;
  zone: HeadlineZone;
  // Pixels covered at the top / bottom edge: a bar or band, the platform's own
  // interface on a Story.
  topInset: number;
  bottomInset: number;
  // Where the logo was placed (null: none, or it sits on the band).
  logo: Rect | null;
}): { box: Rect; anchor: Anchor } {
  const { width: W, height: H, zone, logo } = input;
  const gap = CLEARANCE * H;
  let availTop = input.topInset + gap;
  let availBottom = H - input.bottomInset - gap;
  const left = ZONE_LEFT[zone] * W;
  const width = ZONE_WIDTH[zone] * W;

  // The words keep clear of the logo: below it when it is in the upper half,
  // above it otherwise.
  if (logo && logo.left < left + width && logo.left + logo.width > left) {
    if (logo.top + logo.height / 2 < H / 2) {
      availTop = Math.max(availTop, logo.top + logo.height + gap);
    } else {
      availBottom = Math.min(availBottom, logo.top - gap);
    }
  }
  const maxHeight = ZONE_MAX_HEIGHT[zone] * H;

  if (zone === "TOP" || zone === "UPPER_LEFT") {
    const top = Math.max(availTop, EDGE_OFFSET * H);
    const height = Math.max(0, Math.min(maxHeight, availBottom - top));
    return { box: { left, width, top, height }, anchor: "top" };
  }
  if (zone === "BOTTOM") {
    const bottom = Math.min(availBottom, (1 - BOTTOM_OFFSET) * H);
    const height = Math.max(0, Math.min(maxHeight, bottom - availTop));
    return {
      box: { left, width, top: bottom - height, height },
      anchor: "bottom",
    };
  }
  const height = Math.max(0, Math.min(maxHeight, availBottom - availTop));
  const centre = Math.min(
    Math.max(H / 2, availTop + height / 2),
    availBottom - height / 2,
  );
  return {
    box: { left, width, top: centre - height / 2, height },
    anchor: "center",
  };
}

// --- setting the words -----------------------------------------------------------

// Headline size per layout scale, as a fraction of the canvas' short side.
const SCALE_SIZE: Record<TextPlacement["scale"], number> = {
  M: 0.064,
  L: 0.08,
  XL: 0.1,
};
const MIN_SIZE_FACTOR = 0.5;
const SHRINK = 0.94;
const HEADLINE_LEADING = 1.12;
const HEADLINE_TRACKING = -0.015; // em; display sizes read tighter
const BODY_LEADING = 1.3;
const BODY_RATIO = 0.44; // sub-line size to headline size
const DESCENT = 0.24; // room under the last baseline (ğ ş ç p y), em
const MAX_SUBLINES = 2;
const ELLIPSIS = "…";

type Role = "headline" | "highlight" | "line";

type Word = { text: string; width: number; role: Role };
type Line = { words: Word[]; width: number };

export type GlyphRun = {
  font: OutlineFont;
  size: number;
  // Left end of the run on its baseline.
  x: number;
  baseline: number;
  text: string;
  tracking: number;
  role: Role;
};

export type TextLayout = {
  zone: HeadlineZone;
  // The area the words were fitted into, and their own bounds.
  box: Rect;
  block: Rect;
  headlineSize: number;
  headlineLines: number;
  runs: GlyphRun[];
};

function textWidth(
  font: OutlineFont,
  text: string,
  size: number,
  tracking: number,
): number {
  const scale = size / font.unitsPerEm;
  let width = 0;
  let count = 0;
  for (const char of text) {
    width += font.advance(font.glyphIndex(char.codePointAt(0)!)) * scale;
    count += 1;
  }
  return width + Math.max(0, count - 1) * tracking * size;
}

function wrapWords(words: Word[], maxWidth: number, space: number): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  for (const word of words) {
    if (current && current.width + space + word.width <= maxWidth) {
      current.words.push(word);
      current.width += space + word.width;
    } else {
      current = { words: [word], width: word.width };
      lines.push(current);
    }
  }
  return lines;
}

// Same number of lines, but as even as possible (no lone word on the last
// line), like CSS `text-wrap: balance`.
function balancedLines(words: Word[], maxWidth: number, space: number): Line[] {
  const greedy = wrapWords(words, maxWidth, space);
  if (greedy.length < 2) return greedy;
  let low = Math.max(...words.map((word) => word.width));
  let high = maxWidth;
  for (let i = 0; i < 16 && high - low > 1; i += 1) {
    const mid = (low + high) / 2;
    if (wrapWords(words, mid, space).length <= greedy.length) high = mid;
    else low = mid;
  }
  return wrapWords(words, high, space);
}

const normalise = (word: string) =>
  word.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]/gu, "");

function wordsOf(
  text: string,
  font: OutlineFont,
  size: number,
  tracking: number,
  role: Role,
  highlight?: ReadonlySet<string>,
): Word[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({
      text: word,
      width: textWidth(font, word, size, tracking),
      role:
        role === "headline" && highlight?.has(normalise(word))
          ? "highlight"
          : role,
    }));
}

// A word wider than the zone (a long compound, a URL) is cut into pieces that
// fit, only as a last resort at the smallest size.
function splitLongWords(
  words: Word[],
  maxWidth: number,
  font: OutlineFont,
  size: number,
  tracking: number,
): Word[] {
  return words.flatMap((word) => {
    if (word.width <= maxWidth) return [word];
    const pieces: Word[] = [];
    let piece = "";
    for (const char of word.text) {
      const next = piece + char;
      if (piece && textWidth(font, next, size, tracking) > maxWidth) {
        pieces.push({
          ...word,
          text: piece,
          width: textWidth(font, piece, size, tracking),
        });
        piece = char;
      } else {
        piece = next;
      }
    }
    if (piece) {
      pieces.push({
        ...word,
        text: piece,
        width: textWidth(font, piece, size, tracking),
      });
    }
    return pieces;
  });
}

// Keeps the first `max` lines; the last one ends in an ellipsis that fits.
function clampLines(
  lines: Line[],
  max: number,
  maxWidth: number,
  font: OutlineFont,
  size: number,
  tracking: number,
  space: number,
): Line[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  const last = kept[max - 1]!;
  const words = [...last.words];
  const ellipsisWidth = textWidth(font, ELLIPSIS, size, tracking);
  while (words.length > 1) {
    const width =
      words.reduce((sum, word) => sum + word.width, 0) +
      space * (words.length - 1);
    if (width + ellipsisWidth <= maxWidth) break;
    words.pop();
  }
  const tail = words[words.length - 1]!;
  words[words.length - 1] = {
    ...tail,
    text: `${tail.text}${ELLIPSIS}`,
    width: tail.width + ellipsisWidth,
  };
  kept[max - 1] = {
    words,
    width:
      words.reduce((sum, word) => sum + word.width, 0) +
      space * (words.length - 1),
  };
  return kept;
}

type Fitted = {
  size: number;
  headline: Line[];
  bodySize: number;
  body: Line[];
  height: number;
  fits: boolean;
};

function fitAt(
  size: number,
  text: OnImageText,
  fonts: TextFonts,
  placement: TextPlacement,
  box: Rect,
  canvasShort: number,
  lastResort: boolean,
): Fitted {
  const tracking = HEADLINE_TRACKING;
  const space = textWidth(fonts.headline, " ", size, 0);
  const highlight = new Set(
    (text.highlight ?? "").split(/\s+/).map(normalise).filter(Boolean),
  );
  let headlineWords = wordsOf(
    text.headline,
    fonts.headline,
    size,
    tracking,
    "headline",
    highlight,
  );
  if (lastResort) {
    headlineWords = splitLongWords(
      headlineWords,
      box.width,
      fonts.headline,
      size,
      tracking,
    );
  }
  let headline = balancedLines(headlineWords, box.width, space);

  const bodySize = Math.min(
    size * 0.62,
    Math.max(size * BODY_RATIO, canvasShort * 0.03),
  );
  const bodySpace = textWidth(fonts.body, " ", bodySize, 0);
  let body: Line[] = [];
  for (const line of (text.lines ?? []).slice(0, MAX_SUBLINES)) {
    let words = wordsOf(line, fonts.body, bodySize, 0, "line");
    if (lastResort)
      words = splitLongWords(words, box.width, fonts.body, bodySize, 0);
    let wrapped = balancedLines(words, box.width, bodySpace);
    if (lastResort) {
      wrapped = clampLines(
        wrapped,
        2,
        box.width,
        fonts.body,
        bodySize,
        0,
        bodySpace,
      );
    }
    body = [...body, ...wrapped];
  }
  if (lastResort) {
    headline = clampLines(
      headline,
      placement.maxLines,
      box.width,
      fonts.headline,
      size,
      tracking,
      space,
    );
  }

  const cap = (fonts.headline.capHeight / fonts.headline.unitsPerEm) * size;
  const bodyCap = (fonts.body.capHeight / fonts.body.unitsPerEm) * bodySize;
  let height =
    cap + (headline.length - 1) * size * HEADLINE_LEADING + DESCENT * size;
  if (body.length > 0) {
    height +=
      size * 0.32 +
      bodyCap +
      (body.length - 1) * bodySize * BODY_LEADING +
      DESCENT * bodySize;
  }
  const widest = Math.max(...[...headline, ...body].map((line) => line.width));
  const fits =
    headline.length <= placement.maxLines &&
    body.length <= MAX_SUBLINES * 2 &&
    height <= box.height &&
    widest <= box.width + 0.5;
  return { size, headline, bodySize, body, height, fits };
}

export function layoutText(input: {
  text: OnImageText;
  placement: TextPlacement;
  fonts: TextFonts;
  box: Rect;
  anchor: Anchor;
  canvas: { width: number; height: number };
}): TextLayout | null {
  const { text, placement, fonts, box, anchor } = input;
  if (!text.headline.trim() || box.width <= 0 || box.height <= 0) return null;
  const canvasShort = Math.min(input.canvas.width, input.canvas.height);
  const base = SCALE_SIZE[placement.scale] * canvasShort;
  const floor = base * MIN_SIZE_FACTOR;

  // The layout's size if the words fit there; else a little smaller each step;
  // at the floor, long words break and extra lines end in an ellipsis, so the
  // words never leave their zone.
  let fitted: Fitted | null = null;
  for (let size = base; size > floor; size *= SHRINK) {
    const attempt = fitAt(
      size,
      text,
      fonts,
      placement,
      box,
      canvasShort,
      false,
    );
    if (attempt.fits) {
      fitted = attempt;
      break;
    }
  }
  if (!fitted) {
    fitted = fitAt(floor, text, fonts, placement, box, canvasShort, true);
    // Not even the floor fits the height: scale down to it.
    if (fitted.height > box.height) {
      const ratio = box.height / fitted.height;
      fitted = fitAt(
        floor * ratio,
        text,
        fonts,
        placement,
        box,
        canvasShort,
        true,
      );
    }
  }

  const { size, headline, bodySize, body, height } = fitted;
  const top =
    anchor === "top"
      ? box.top
      : anchor === "bottom"
        ? box.top + box.height - height
        : box.top + (box.height - height) / 2;
  const xOf = (width: number) =>
    placement.align === "center"
      ? box.left + (box.width - width) / 2
      : box.left;

  const runs: GlyphRun[] = [];
  const cap = (fonts.headline.capHeight / fonts.headline.unitsPerEm) * size;
  const space = textWidth(fonts.headline, " ", size, 0);
  let baseline = top + cap;
  for (const line of headline) {
    let x = xOf(line.width);
    for (const word of line.words) {
      runs.push({
        font: fonts.headline,
        size,
        x,
        baseline,
        text: word.text,
        tracking: HEADLINE_TRACKING,
        role: word.role,
      });
      x += word.width + space;
    }
    baseline += size * HEADLINE_LEADING;
  }
  if (body.length > 0) {
    const bodyCap = (fonts.body.capHeight / fonts.body.unitsPerEm) * bodySize;
    const bodySpace = textWidth(fonts.body, " ", bodySize, 0);
    baseline +=
      -size * HEADLINE_LEADING + DESCENT * size + size * 0.32 + bodyCap;
    for (const line of body) {
      let x = xOf(line.width);
      for (const word of line.words) {
        runs.push({
          font: fonts.body,
          size: bodySize,
          x,
          baseline,
          text: word.text,
          tracking: 0,
          role: "line",
        });
        x += word.width + bodySpace;
      }
      baseline += bodySize * BODY_LEADING;
    }
  }

  const widest = Math.max(...[...headline, ...body].map((line) => line.width));
  return {
    zone: placement.zone,
    box,
    block: { left: xOf(widest), top, width: widest, height },
    headlineSize: size,
    headlineLines: headline.length,
    runs,
  };
}

// --- colour --------------------------------------------------------------------

export type TextColors = {
  ink: string;
  // Highlighted words; null = set in the ink colour.
  highlight: string | null;
  scrim: { color: string; opacity: number } | null;
  // A soft shadow under light words on a scrim: the last bit of separation
  // from a busy picture.
  shadow: boolean;
  // Secondary texts.
  lineOpacity: number;
};

const WHITE = "#ffffff";
const NEAR_BLACK = "#111111";
// Standard deviation (0-255) of the busiest colour channel under the words:
// above it the area is busy (detail, or the words straddle two areas).
const BUSY_SPREAD = 46;

const toHex = ([r, g, b]: readonly number[]) =>
  `#${[r, g, b]
    .map((value) =>
      Math.round(Math.min(255, Math.max(0, value ?? 0)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function mix(hexA: string, hexB: string, amount: number): string {
  const parse = (hex: string) =>
    [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const a = parse(hexA);
  const b = parse(hexB);
  return toHex(a.map((value, i) => value * (1 - amount) + b[i]! * amount));
}

// White, or the brand's own dark colour (else near-black), whichever reads
// better on the picture under the words; a soft scrim when neither reads well
// enough or the area is busy. The accent colour highlights words only where it
// stays legible.
export function pickTextColors(input: {
  meanRgb: readonly number[];
  spread: number;
  darkInk?: string | null;
  accent?: string | null;
}): TextColors {
  const background = toHex(input.meanRgb);
  const dark =
    input.darkInk &&
    /^#[0-9a-f]{6}$/i.test(input.darkInk) &&
    contrastRatio(input.darkInk, WHITE) >= 7
      ? input.darkInk.toLowerCase()
      : NEAR_BLACK;
  const onLight = contrastRatio(dark, background);
  const onDark = contrastRatio(WHITE, background);
  const busy = input.spread > BUSY_SPREAD;

  let ink: string;
  let scrim: TextColors["scrim"] = null;
  if (!busy && Math.max(onLight, onDark) >= 4.5) {
    ink = onDark >= onLight ? WHITE : dark;
  } else if (relativeLuminance(background) > 0.55) {
    ink = dark;
    scrim = { color: WHITE, opacity: 0.78 };
  } else {
    ink = WHITE;
    scrim = { color: "#000000", opacity: 0.5 };
  }

  const behind = scrim
    ? mix(background, scrim.color, scrim.opacity)
    : background;
  const accent =
    input.accent && /^#[0-9a-f]{6}$/i.test(input.accent)
      ? input.accent.toLowerCase()
      : null;
  return {
    ink,
    highlight: accent && contrastRatio(accent, behind) >= 3 ? accent : null,
    scrim,
    shadow: Boolean(scrim) && ink === WHITE,
    lineOpacity: 0.9,
  };
}

// --- the layer ---------------------------------------------------------------------

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const r2 = (value: number) => Math.round(value * 100) / 100;
const r6 = (value: number) => Math.round(value * 1e6) / 1e6;

function scrimSvg(
  layout: TextLayout,
  colors: TextColors,
  width: number,
  height: number,
): string {
  if (!colors.scrim) return "";
  const { color, opacity } = colors.scrim;
  const { block } = layout;
  const stop = (offset: number, alpha: number) =>
    `<stop offset="${r2(Math.min(1, Math.max(0, offset)))}" stop-color="${color}" stop-opacity="${r2(alpha)}"/>`;
  const fade = 0.14 * height;
  switch (layout.zone) {
    case "TOP":
    case "UPPER_LEFT": {
      const h = Math.min(height, block.top + block.height + fade);
      return `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">${stop(0, opacity)}${stop((block.top + block.height) / h, opacity * 0.8)}${stop(1, 0)}</linearGradient></defs><rect x="0" y="0" width="${width}" height="${r2(h)}" fill="url(#scrim)"/>`;
    }
    case "BOTTOM": {
      const y = Math.max(0, block.top - fade);
      const h = height - y;
      return `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">${stop(0, 0)}${stop((block.top - y) / h, opacity * 0.8)}${stop(1, opacity)}</linearGradient></defs><rect x="0" y="${r2(y)}" width="${width}" height="${r2(h)}" fill="url(#scrim)"/>`;
    }
    case "LEFT_COLUMN": {
      const w = Math.min(width, block.left + block.width + 0.22 * width);
      return `<defs><linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">${stop(0, opacity)}${stop((block.left + block.width) / w, opacity * 0.8)}${stop(1, 0)}</linearGradient></defs><rect x="0" y="0" width="${r2(w)}" height="${height}" fill="url(#scrim)"/>`;
    }
    case "CENTER":
    default: {
      // A soft ellipse whose plateau holds the whole block, fading well
      // outside it (lighter than an edge gradient: it sits mid-picture).
      const padX = block.width * 0.35 + 0.05 * width;
      const padY = block.height * 0.7 + 0.05 * height;
      const soft = opacity * 0.8;
      return `<defs><radialGradient id="scrim" cx="0.5" cy="0.5" r="0.5">${stop(0, soft)}${stop(0.5, soft * 0.9)}${stop(0.8, soft * 0.4)}${stop(1, 0)}</radialGradient></defs><rect x="${r2(block.left - padX)}" y="${r2(block.top - padY)}" width="${r2(block.width + 2 * padX)}" height="${r2(block.height + 2 * padY)}" fill="url(#scrim)"/>`;
    }
  }
}

function runPaths(run: GlyphRun, fill: string, opacity: number): string {
  const scale = run.size / run.font.unitsPerEm;
  let x = run.x;
  const paths: string[] = [];
  for (const char of run.text) {
    const glyph = run.font.glyphIndex(char.codePointAt(0)!);
    const d = run.font.pathData(glyph);
    if (d) {
      paths.push(
        `<path transform="matrix(${r6(scale)} 0 0 ${-r6(scale)} ${r2(x)} ${r2(run.baseline)})" d="${d}"/>`,
      );
    }
    x += run.font.advance(glyph) * scale + run.tracking * run.size;
  }
  const alpha = opacity < 1 ? ` fill-opacity="${opacity}"` : "";
  return `<g fill="${fill}"${alpha}>${paths.join("")}</g>`;
}

// The whole layer as one SVG the size of the canvas. The words are in the
// title / desc too (and the zone's geometry in data attributes) so the layer
// says what it draws.
export function textLayerSvg(
  layout: TextLayout,
  colors: TextColors,
  canvas: { width: number; height: number },
  text: OnImageText,
): string {
  const { width, height } = canvas;
  const { box } = layout;
  const words = layout.runs
    .map((run) =>
      runPaths(
        run,
        run.role === "highlight"
          ? (colors.highlight ?? colors.ink)
          : colors.ink,
        run.role === "line" ? colors.lineOpacity : 1,
      ),
    )
    .join("");
  const lines = (text.lines ?? []).slice(0, MAX_SUBLINES).join(" / ");
  const shadow = colors.shadow
    ? `<filter id="soft" x="-10%" y="-20%" width="120%" height="140%"><feDropShadow dx="0" dy="${r2(layout.headlineSize * 0.03)}" stdDeviation="${r2(layout.headlineSize * 0.08)}" flood-color="#000000" flood-opacity="0.45"/></filter>`
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escapeXml(text.headline)}</title>`,
    lines ? `<desc>${escapeXml(lines)}</desc>` : "",
    shadow ? `<defs>${shadow}</defs>` : "",
    scrimSvg(layout, colors, width, height),
    `<g data-zone="${layout.zone}" data-box="${r2(box.left)} ${r2(box.top)} ${r2(box.width)} ${r2(box.height)}"${shadow ? ' filter="url(#soft)"' : ""}>${words}</g>`,
    `</svg>`,
  ].join("");
}

// Everything above for one picture: where the words go, how big, which
// colour, as a layer to composite over it. Null = nothing to set (no words, or
// no room left between the logo, the band and the platform's interface).
export async function renderTextLayer(input: {
  base: Buffer;
  width: number;
  height: number;
  text: OnImageText;
  placement: TextPlacement;
  topInset: number;
  bottomInset: number;
  logo: Rect | null;
  fontFamily?: string | null;
  darkInk?: string | null;
  accent?: string | null;
}): Promise<Buffer | null> {
  const headline = input.text.headline.replace(/\s+/g, " ").trim();
  if (!headline) return null;
  const text: OnImageText = {
    ...input.text,
    headline,
    lines: (input.text.lines ?? [])
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, MAX_SUBLINES),
  };
  const fonts = await loadTextFonts(input.fontFamily, {
    headline,
    body: (text.lines ?? []).join(" "),
  });
  const zone = textZone({
    width: input.width,
    height: input.height,
    zone: input.placement.zone,
    topInset: input.topInset,
    bottomInset: input.bottomInset,
    logo: input.logo,
  });
  const short = Math.min(input.width, input.height);
  if (zone.box.height < short * 0.08 || zone.box.width < short * 0.2)
    return null;
  const layout = layoutText({
    text,
    placement: input.placement,
    fonts,
    box: zone.box,
    anchor: zone.anchor,
    canvas: { width: input.width, height: input.height },
  });
  if (!layout) return null;

  // Sample the picture under the words (a little wider than them).
  const pad = short * 0.02;
  const left = Math.max(0, Math.floor(layout.block.left - pad));
  const top = Math.max(0, Math.floor(layout.block.top - pad));
  const right = Math.min(
    input.width,
    Math.ceil(layout.block.left + layout.block.width + pad),
  );
  const bottom = Math.min(
    input.height,
    Math.ceil(layout.block.top + layout.block.height + pad),
  );
  // stats() measures the whole input, not the pipeline's extract: cut the
  // region out first.
  const region = await sharp(input.base)
    .extract({
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    })
    .toBuffer();
  const stats = await sharp(region).stats();
  const [red, green, blue] = stats.channels;
  const colors = pickTextColors({
    meanRgb: [red?.mean ?? 255, green?.mean ?? 255, blue?.mean ?? 255],
    spread: Math.max(red?.stdev ?? 0, green?.stdev ?? 0, blue?.stdev ?? 0),
    darkInk: input.darkInk,
    accent: input.accent,
  });
  return Buffer.from(
    textLayerSvg(
      layout,
      colors,
      { width: input.width, height: input.height },
      text,
    ),
  );
}
