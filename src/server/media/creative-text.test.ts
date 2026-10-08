import { readFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TextPlacement } from "@/lib/layout-templates";
import {
  layoutText,
  loadTextFonts,
  pickTextColors,
  renderTextLayer,
  textLayerSvg,
  textZone,
  type TextFonts,
} from "@/server/media/creative-text";
import { parseFont } from "@/server/media/font-outline";

// The words of a post are typeset by us, as vector paths from a bundled font:
// every Turkish letter has its glyph, the words stay inside the layout's zone
// (wrapping, then shrinking, then an ellipsis), clear of the logo, in a colour
// that reads on the picture under them.

const FONTS = path.join(process.cwd(), "src", "server", "media", "fonts");
const inter600 = parseFont(readFileSync(path.join(FONTS, "inter-600.woff")));
const inter400 = parseFont(readFileSync(path.join(FONTS, "inter-400.woff")));
const fonts: TextFonts = { headline: inter600, body: inter400 };

const PORTRAIT = { width: 1080, height: 1350 };
const TOP: TextPlacement = {
  zone: "TOP",
  align: "center",
  maxLines: 3,
  scale: "L",
};

function zoneFor(
  placement: TextPlacement,
  logo: Parameters<typeof textZone>[0]["logo"] = null,
) {
  return textZone({
    ...PORTRAIT,
    zone: placement.zone,
    topInset: 0,
    bottomInset: 0,
    logo,
  });
}

function fitted(
  headline: string,
  placement: TextPlacement = TOP,
  lines?: string[],
  cta?: string,
) {
  const zone = zoneFor(placement);
  const layout = layoutText({
    text: { headline, lines, cta },
    placement,
    fonts,
    box: zone.box,
    anchor: zone.anchor,
    canvas: PORTRAIT,
  });
  if (!layout) throw new Error("no layout");
  return { zone, layout };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("font outlines", () => {
  it("has a real glyph for every Turkish letter, accented capitals included", () => {
    for (const char of "ğüşıöçĞÜŞİÖÇ") {
      const glyph = inter600.glyphIndex(char.codePointAt(0)!);
      expect(glyph, char).toBeGreaterThan(0);
      expect(inter600.pathData(glyph), char).toMatch(/^M/);
      expect(inter600.advance(glyph), char).toBeGreaterThan(0);
    }
    // ğ = a g plus its breve: both outlines are drawn.
    const breve = inter600.pathData(inter600.glyphIndex("ğ".codePointAt(0)!));
    expect(breve.match(/M/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it("reads Cyrillic too (Macedonian brands)", () => {
    for (const char of "ЉЊЃЌЅЈЏж") {
      expect(inter400.glyphIndex(char.codePointAt(0)!), char).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("where the words go", () => {
  it("keeps every word inside the layout's zone", () => {
    const { zone, layout } = fitted(
      "Güneşli günlerde ağır çekim İstanbul",
      TOP,
      ["Şimdi keşfet · ücretsiz ölçüm"],
    );
    const { box } = zone;
    expect(layout.block.left).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(layout.block.left + layout.block.width).toBeLessThanOrEqual(
      box.left + box.width + 0.5,
    );
    expect(layout.block.top).toBeGreaterThanOrEqual(box.top - 0.5);
    expect(layout.block.top + layout.block.height).toBeLessThanOrEqual(
      box.top + box.height + 0.5,
    );
    expect(layout.headlineLines).toBeLessThanOrEqual(TOP.maxLines);
    for (const run of layout.runs) {
      expect(run.x).toBeGreaterThanOrEqual(box.left - 0.5);
    }
  });

  it("shrinks a long headline to fit, and ends an overflow in an ellipsis", () => {
    const short = fitted("Pazar kahvaltısı");
    const long = fitted(
      "Çok uzun bir başlık: şehrin en güzel kahvaltısı burada, hem de her gün ve her saatte İzmir'de, sizi bekliyor",
      { ...TOP, maxLines: 2 },
    );
    expect(long.layout.headlineSize).toBeLessThan(short.layout.headlineSize);
    expect(long.layout.headlineLines).toBeLessThanOrEqual(2);
    expect(long.layout.runs.some((run) => run.text.endsWith("…"))).toBe(true);
    expect(
      long.layout.block.top + long.layout.block.height,
    ).toBeLessThanOrEqual(long.zone.box.top + long.zone.box.height + 0.5);
  });

  it("keeps clear of a logo at the top and of a band at the bottom", () => {
    const logo = { left: 54, top: 54, width: 160, height: 120 };
    const top = zoneFor(TOP, logo);
    expect(top.box.top).toBeGreaterThanOrEqual(logo.top + logo.height);

    const bottom = textZone({
      ...PORTRAIT,
      zone: "BOTTOM",
      topInset: 0,
      bottomInset: 175,
      logo: null,
    });
    expect(bottom.box.top + bottom.box.height).toBeLessThanOrEqual(1350 - 175);
  });

  it("mirrors the preview's zone widths", () => {
    expect(zoneFor({ ...TOP, zone: "LEFT_COLUMN" }).box).toMatchObject({
      left: 1080 * 0.08,
      width: 1080 * 0.5,
    });
    expect(zoneFor({ ...TOP, zone: "CENTER" }).anchor).toBe("center");
  });
});

describe("the call to action", () => {
  it("is a pill under the texts, inside the zone, with its label in it", () => {
    const { zone, layout } = fitted(
      "Pazar sofrası artık çok daha lezzetli",
      TOP,
      ["Bu hafta sonu rezervasyon yap"],
      "Hemen ayırt",
    );
    const pill = layout.cta!;
    expect(pill).not.toBeNull();
    expect(pill.rect.left).toBeGreaterThanOrEqual(zone.box.left - 0.5);
    expect(pill.rect.left + pill.rect.width).toBeLessThanOrEqual(
      zone.box.left + zone.box.width + 0.5,
    );
    // The last thing in the block, below every other run.
    const others = layout.runs.filter((run) => run.role !== "cta");
    expect(pill.rect.top).toBeGreaterThan(Math.max(...others.map((r) => r.baseline)));
    expect(pill.rect.top + pill.rect.height).toBeCloseTo(
      layout.block.top + layout.block.height,
      0,
    );
    // The label sits inside the pill.
    const label = layout.runs.find((run) => run.role === "cta")!;
    expect(label.text).toBe("Hemen ayırt");
    expect(label.x).toBeGreaterThan(pill.rect.left);
    expect(label.baseline).toBeGreaterThan(pill.rect.top);
    expect(label.baseline).toBeLessThan(pill.rect.top + pill.rect.height);
  });

  it("is centred like the words when they are", () => {
    const { layout } = fitted("Taze ekmek her sabah", TOP, undefined, "Sipariş ver");
    const pill = layout.cta!;
    const middle = pill.rect.left + pill.rect.width / 2;
    expect(Math.abs(middle - PORTRAIT.width / 2)).toBeLessThan(2);
  });

  it("makes room for itself without leaving the zone", () => {
    const { zone, layout } = fitted(
      "Güneşli günlerde ağır çekim İstanbul turu başlıyor",
      TOP,
      ["Şimdi keşfet · ücretsiz ölçüm"],
      "Hemen yerini ayırt",
    );
    expect(layout.block.top + layout.block.height).toBeLessThanOrEqual(
      zone.box.top + zone.box.height + 0.5,
    );
  });

  it("without one there is no pill", () => {
    expect(fitted("Taze ekmek her sabah").layout.cta).toBeNull();
  });

  it("is drawn: a filled rounded rect in the accent with a readable label", () => {
    const { layout } = fitted("Taze ekmek her sabah", TOP, undefined, "Sipariş ver");
    const svg = textLayerSvg(
      layout,
      {
        ink: "#ffffff",
        highlight: "#f2b134",
        scrim: null,
        shadow: false,
        lineOpacity: 0.9,
      },
      PORTRAIT,
      { headline: "Taze ekmek her sabah", cta: "Sipariş ver" },
    );
    expect(svg).toMatch(/<rect [^>]*rx="[\d.]+" fill="#f2b134"/);
    // Near-black label on the amber pill (white would not read).
    expect(svg).toContain('<g fill="#111111">');
  });
});

describe("colour", () => {
  it("white on a dark, calm picture; the brand's dark colour on a light one", () => {
    expect(pickTextColors({ meanRgb: [20, 30, 50], spread: 8 })).toMatchObject({
      ink: "#ffffff",
      scrim: null,
    });
    expect(
      pickTextColors({
        meanRgb: [245, 240, 230],
        spread: 8,
        darkInk: "#0B1F3A",
      }),
    ).toMatchObject({ ink: "#0b1f3a", scrim: null });
    // A light brand colour is never used as "dark" ink.
    expect(
      pickTextColors({
        meanRgb: [245, 240, 230],
        spread: 8,
        darkInk: "#fbbf24",
      }).ink,
    ).toBe("#111111");
  });

  it("a soft scrim (and a shadow) under words on a busy or mid-tone picture", () => {
    const busy = pickTextColors({
      meanRgb: [90, 90, 90],
      spread: 80,
      accent: "#f97316",
    });
    expect(busy.scrim).toEqual({ color: "#000000", opacity: 0.5 });
    expect(busy.ink).toBe("#ffffff");
    expect(busy.shadow).toBe(true);
    // The accent highlights only where it stays legible.
    expect(
      pickTextColors({ meanRgb: [250, 140, 30], spread: 4, accent: "#f97316" })
        .highlight,
    ).toBeNull();
  });
});

describe("the layer", () => {
  it("is vector paths in the zone, with the words (escaped) and the zone's geometry on it", () => {
    const headline = 'Fiyat <50 TL> & "İndirim"';
    const { zone, layout } = fitted(headline);
    const svg = textLayerSvg(
      layout,
      pickTextColors({ meanRgb: [20, 30, 50], spread: 8 }),
      PORTRAIT,
      { headline },
    );
    expect(svg).toContain(
      "<title>Fiyat &lt;50 TL&gt; &amp; &quot;İndirim&quot;</title>",
    );
    expect(svg).toContain('data-zone="TOP"');
    const { left, top, width, height } = zone.box;
    expect(svg).toContain(
      `data-box="${Math.round(left * 100) / 100} ${Math.round(top * 100) / 100} ${Math.round(width * 100) / 100} ${Math.round(height * 100) / 100}"`,
    );
    expect(svg).not.toContain("<text");
    expect(svg.match(/<path /g)!.length).toBeGreaterThan(10);
  });

  it("renders over a real picture: the zone changes, the rest does not", async () => {
    const base = await sharp({
      create: {
        width: 1080,
        height: 1350,
        channels: 3,
        background: { r: 15, g: 25, b: 45 },
      },
    })
      .png()
      .toBuffer();
    const layer = await renderTextLayer({
      base,
      width: 1080,
      height: 1350,
      text: { headline: "Güneşli günlerde İstanbul" },
      placement: TOP,
      topInset: 0,
      bottomInset: 0,
      logo: null,
    });
    expect(layer).not.toBeNull();
    const out = await sharp(base)
      .composite([{ input: layer!, left: 0, top: 0 }])
      .raw()
      .toBuffer({
        resolveWithObject: true,
      });
    const brightness = (x0: number, y0: number, x1: number, y1: number) => {
      let max = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const at = (y * out.info.width + x) * out.info.channels;
          max = Math.max(max, out.data[at]!);
        }
      }
      return max;
    };
    // White words in the upper third; the lower part of the picture untouched.
    expect(brightness(86, 148, 994, 500)).toBeGreaterThan(200);
    expect(brightness(0, 900, 1080, 1350)).toBeLessThan(30);
  });

  it("nothing to set: no headline, or no room left", async () => {
    const base = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const common = {
      base,
      width: 400,
      height: 400,
      placement: TOP,
      logo: null,
    };
    expect(
      await renderTextLayer({
        ...common,
        text: { headline: "  " },
        topInset: 0,
        bottomInset: 0,
      }),
    ).toBeNull();
    expect(
      await renderTextLayer({
        ...common,
        text: { headline: "Hi" },
        topInset: 200,
        bottomInset: 190,
      }),
    ).toBeNull();
  });
});

describe("the brand's font", () => {
  it("uses the brand kit's Google font when it has every letter, without a second download", async () => {
    const fontBytes = readFileSync(path.join(FONTS, "inter-400.woff"));
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://fonts.googleapis.com/")
        ? new Response(
            "@font-face { src: url(https://fonts.gstatic.com/s/brandsans/v1/brand.ttf) format('truetype'); }",
          )
        : new Response(fontBytes),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadTextFonts("Brand Sans", {
      headline: "Güneş",
      body: "",
    });
    expect(first.headline).not.toBe(inter600);
    expect(first.headline.glyphIndex("ğ".codePointAt(0)!)).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://fonts.googleapis.com/css2?family=Brand+Sans:wght@400",
    );
    const calls = fetchMock.mock.calls.length;
    await loadTextFonts("Brand Sans", { headline: "Güneş", body: "" });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("falls back to the bundled font when Google Fonts does not have it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 400 })),
    );
    const loaded = await loadTextFonts("Not A Google Font", {
      headline: "Güneş",
      body: "x",
    });
    expect(loaded.headline.glyphIndex("ğ".codePointAt(0)!)).toBeGreaterThan(0);
    expect(loaded.headline.unitsPerEm).toBe(inter600.unitsPerEm);
    // No family at all: never a request.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await loadTextFonts(null, { headline: "a", body: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
