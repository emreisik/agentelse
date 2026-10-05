import "server-only";

import { inflateSync } from "node:zlib";

// A minimal TrueType / WOFF reader that turns glyphs into SVG path data, so
// the words set on a post (creative-text.ts) are drawn as plain vector shapes.
// librsvg (sharp's SVG renderer) then needs no fonts at all: no system font,
// no fontconfig, the same pixels on a laptop and on the server. Reads only
// what drawing needs: the character map, advance widths, vertical metrics and
// glyph outlines (simple and composite). No kerning, no shaping: Latin,
// Turkish and Cyrillic headlines need neither to read well.

export type OutlineFont = {
  unitsPerEm: number;
  // Vertical metrics in font units (descender is negative).
  ascender: number;
  descender: number;
  capHeight: number;
  // 0 = the font has no glyph for this character (.notdef).
  glyphIndex(codePoint: number): number;
  advance(glyph: number): number;
  // SVG path data in font units, y pointing UP (flip it when drawing).
  pathData(glyph: number): string;
};

type Point = { x: number; y: number; on: boolean };

const WOFF = 0x774f4646; // "wOFF"
const TRUETYPE = 0x00010000;
const APPLE_TRUE = 0x74727565; // "true"

function readTables(bytes: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const signature = bytes.readUInt32BE(0);
  if (signature === WOFF) {
    const count = bytes.readUInt16BE(12);
    for (let i = 0; i < count; i += 1) {
      const at = 44 + i * 20;
      const tag = bytes.toString("latin1", at, at + 4);
      const offset = bytes.readUInt32BE(at + 4);
      const compressed = bytes.readUInt32BE(at + 8);
      const original = bytes.readUInt32BE(at + 12);
      const raw = bytes.subarray(offset, offset + compressed);
      tables.set(tag, compressed < original ? inflateSync(raw) : raw);
    }
    return tables;
  }
  if (signature === TRUETYPE || signature === APPLE_TRUE) {
    const count = bytes.readUInt16BE(4);
    for (let i = 0; i < count; i += 1) {
      const at = 12 + i * 16;
      const tag = bytes.toString("latin1", at, at + 4);
      const offset = bytes.readUInt32BE(at + 8);
      const length = bytes.readUInt32BE(at + 12);
      tables.set(tag, bytes.subarray(offset, offset + length));
    }
    return tables;
  }
  // CFF ("OTTO") and WOFF2 outlines are not read: callers fall back.
  throw new Error("Unsupported font format");
}

function required(tables: Map<string, Buffer>, tag: string): Buffer {
  const table = tables.get(tag);
  if (!table) throw new Error(`Font has no ${tag} table`);
  return table;
}

// The character map: a Unicode format 12 subtable when there is one (it
// covers everything), else the BMP format 4 one.
function characterMap(cmap: Buffer): (codePoint: number) => number {
  const count = cmap.readUInt16BE(2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const offset = cmap.readUInt32BE(8 + i * 8);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = cmap.readUInt16BE(offset);
    if (format === 12 && format12 === null) format12 = offset;
    if (format === 4 && format4 === null) format4 = offset;
  }

  if (format12 !== null) {
    const at = format12;
    const groups = cmap.readUInt32BE(at + 12);
    return (codePoint) => {
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const group = at + 16 + mid * 12;
        const start = cmap.readUInt32BE(group);
        const end = cmap.readUInt32BE(group + 4);
        if (codePoint < start) high = mid - 1;
        else if (codePoint > end) low = mid + 1;
        else return cmap.readUInt32BE(group + 8) + (codePoint - start);
      }
      return 0;
    };
  }

  if (format4 !== null) {
    const at = format4;
    const segments = cmap.readUInt16BE(at + 6) / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    return (codePoint) => {
      if (codePoint > 0xffff) return 0;
      for (let s = 0; s < segments; s += 1) {
        if (codePoint > cmap.readUInt16BE(ends + s * 2)) continue;
        const start = cmap.readUInt16BE(starts + s * 2);
        if (codePoint < start) return 0;
        const delta = cmap.readUInt16BE(deltas + s * 2);
        const rangeOffset = cmap.readUInt16BE(ranges + s * 2);
        if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
        const glyph = cmap.readUInt16BE(
          ranges + s * 2 + rangeOffset + (codePoint - start) * 2,
        );
        return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }

  throw new Error("Font has no Unicode character map");
}

const f2dot14 = (table: Buffer, at: number) => table.readInt16BE(at) / 16384;

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true };
}

// One closed TrueType contour (quadratic, with implied on-curve points
// between two off-curve ones) as SVG path commands.
function contourPath(points: Point[]): string {
  if (points.length === 0) return "";
  const firstOn = points.findIndex((point) => point.on);
  const start =
    firstOn >= 0
      ? points[firstOn]!
      : midpoint(points[points.length - 1]!, points[0]!);
  const ordered =
    firstOn >= 0
      ? [...points.slice(firstOn + 1), ...points.slice(0, firstOn + 1)]
      : points;
  const n = (value: number) => Math.round(value * 100) / 100;
  let d = `M${n(start.x)} ${n(start.y)}`;
  let control: Point | null = null;
  for (const point of ordered) {
    if (point.on) {
      d += control
        ? `Q${n(control.x)} ${n(control.y)} ${n(point.x)} ${n(point.y)}`
        : `L${n(point.x)} ${n(point.y)}`;
      control = null;
    } else {
      if (control) {
        const mid = midpoint(control, point);
        d += `Q${n(control.x)} ${n(control.y)} ${n(mid.x)} ${n(mid.y)}`;
      }
      control = point;
    }
  }
  if (control)
    d += `Q${n(control.x)} ${n(control.y)} ${n(start.x)} ${n(start.y)}`;
  return `${d}Z`;
}

export function parseFont(bytes: Buffer): OutlineFont {
  const tables = readTables(bytes);
  const head = required(tables, "head");
  const hhea = required(tables, "hhea");
  const hmtx = required(tables, "hmtx");
  const maxp = required(tables, "maxp");
  const loca = required(tables, "loca");
  const glyf = required(tables, "glyf");
  const os2 = tables.get("OS/2");

  const unitsPerEm = head.readUInt16BE(18);
  const longOffsets = head.readInt16BE(50) === 1;
  const ascender = hhea.readInt16BE(4);
  const descender = hhea.readInt16BE(6);
  const metricsCount = hhea.readUInt16BE(34);
  const glyphCount = maxp.readUInt16BE(4);
  // OS/2 v2+ states the cap height; older fonts get the usual ~0.7 em.
  const capHeight =
    os2 && os2.readUInt16BE(0) >= 2 && os2.length >= 90
      ? os2.readInt16BE(88)
      : Math.round(unitsPerEm * 0.7);
  const lookup = characterMap(required(tables, "cmap"));

  const glyphRange = (glyph: number): [number, number] => {
    if (glyph < 0 || glyph >= glyphCount) return [0, 0];
    return longOffsets
      ? [loca.readUInt32BE(glyph * 4), loca.readUInt32BE(glyph * 4 + 4)]
      : [
          loca.readUInt16BE(glyph * 2) * 2,
          loca.readUInt16BE(glyph * 2 + 2) * 2,
        ];
  };

  const contoursOf = (glyph: number, depth: number): Point[][] => {
    const [start, end] = glyphRange(glyph);
    if (end <= start || depth > 8) return [];
    const contourCount = glyf.readInt16BE(start);
    let at = start + 10;

    if (contourCount >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < contourCount; i += 1) {
        ends.push(glyf.readUInt16BE(at));
        at += 2;
      }
      at += 2 + glyf.readUInt16BE(at);
      const total = contourCount > 0 ? ends[contourCount - 1]! + 1 : 0;
      const flags: number[] = [];
      while (flags.length < total) {
        const flag = glyf[at++]!;
        flags.push(flag);
        if (flag & 8) {
          for (let repeat = glyf[at++]!; repeat > 0; repeat -= 1)
            flags.push(flag);
        }
      }
      const xs: number[] = [];
      let x = 0;
      for (let i = 0; i < total; i += 1) {
        const flag = flags[i]!;
        if (flag & 2) {
          const dx = glyf[at++]!;
          x += flag & 16 ? dx : -dx;
        } else if (!(flag & 16)) {
          x += glyf.readInt16BE(at);
          at += 2;
        }
        xs.push(x);
      }
      const points: Point[] = [];
      let y = 0;
      for (let i = 0; i < total; i += 1) {
        const flag = flags[i]!;
        if (flag & 4) {
          const dy = glyf[at++]!;
          y += flag & 32 ? dy : -dy;
        } else if (!(flag & 32)) {
          y += glyf.readInt16BE(at);
          at += 2;
        }
        points.push({ x: xs[i]!, y, on: Boolean(flag & 1) });
      }
      const contours: Point[][] = [];
      let from = 0;
      for (const last of ends) {
        contours.push(points.slice(from, last + 1));
        from = last + 1;
      }
      return contours;
    }

    // Composite glyph (most accented letters: a base plus its mark).
    const contours: Point[][] = [];
    let more = true;
    while (more) {
      const flags = glyf.readUInt16BE(at);
      const component = glyf.readUInt16BE(at + 2);
      at += 4;
      let arg1: number;
      let arg2: number;
      if (flags & 1) {
        arg1 = glyf.readInt16BE(at);
        arg2 = glyf.readInt16BE(at + 2);
        at += 4;
      } else {
        arg1 = glyf.readInt8(at);
        arg2 = glyf.readInt8(at + 1);
        at += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 0x08) {
        a = d = f2dot14(glyf, at);
        at += 2;
      } else if (flags & 0x40) {
        a = f2dot14(glyf, at);
        d = f2dot14(glyf, at + 2);
        at += 4;
      } else if (flags & 0x80) {
        a = f2dot14(glyf, at);
        b = f2dot14(glyf, at + 2);
        c = f2dot14(glyf, at + 4);
        d = f2dot14(glyf, at + 6);
        at += 8;
      }
      const child = contoursOf(component, depth + 1).map((contour) =>
        contour.map((point) => ({
          x: a * point.x + c * point.y,
          y: b * point.x + d * point.y,
          on: point.on,
        })),
      );
      let dx = arg1;
      let dy = arg2;
      if (!(flags & 2)) {
        // Point matching: arg1 is a point of the glyph so far, arg2 one of
        // the component; the component moves so the two coincide.
        const parentPoints = contours.flat();
        const childPoints = child.flat();
        const anchor = parentPoints[arg1];
        const own = childPoints[arg2];
        dx = anchor && own ? anchor.x - own.x : 0;
        dy = anchor && own ? anchor.y - own.y : 0;
      }
      for (const contour of child) {
        contours.push(
          contour.map((point) => ({
            x: point.x + dx,
            y: point.y + dy,
            on: point.on,
          })),
        );
      }
      more = Boolean(flags & 0x20);
    }
    return contours;
  };

  const paths = new Map<number, string>();
  return {
    unitsPerEm,
    ascender,
    descender,
    capHeight,
    glyphIndex: (codePoint) => lookup(codePoint),
    advance: (glyph) => {
      const index = Math.min(glyph, metricsCount - 1);
      return index >= 0 ? hmtx.readUInt16BE(index * 4) : 0;
    },
    pathData: (glyph) => {
      let path = paths.get(glyph);
      if (path === undefined) {
        path = contoursOf(glyph, 0).map(contourPath).join("");
        paths.set(glyph, path);
      }
      return path;
    },
  };
}
