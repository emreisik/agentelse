import { describe, expect, it } from "vitest";

import {
  ARCHETYPES,
  archetypeOfAutoId,
  autoLayout,
  classifyArchetype,
} from "./auto-layout";
import { aspectClassOf, LayoutTemplateSchema } from "./layout-templates";

const CANVASES = [
  { width: 1080, height: 1350 },
  { width: 1080, height: 1440 },
  { width: 1080, height: 1080 },
  { width: 1080, height: 566 },
  { width: 1080, height: 1920 },
  { width: 1200, height: 628 },
];

describe("autoLayout", () => {
  it("always yields a valid layout, for every archetype and format", () => {
    for (const archetype of ARCHETYPES) {
      for (const pixelSize of CANVASES) {
        const layout = autoLayout({ archetype, pixelSize });
        expect(() => LayoutTemplateSchema.parse(layout)).not.toThrow();
        expect(layout.formats).toEqual([aspectClassOf(pixelSize)]);
      }
    }
  });

  it("uses the same physical margin on every format", () => {
    const px = (size: { width: number; height: number }) => {
      const layout = autoLayout({ archetype: "editorial", pixelSize: size });
      return (layout.logo.marginPercent / 100) * size.width;
    };
    for (const size of [CANVASES[2]!, CANVASES[3]!, CANVASES[4]!]) {
      const target = 0.04 * Math.min(size.width, size.height);
      expect(Math.abs(px(size) - target)).toBeLessThanOrEqual(0.006 * size.width);
    }
  });

  it("has no bar, band or line in any design, on any format", () => {
    for (const archetype of ARCHETYPES) {
      for (const pixelSize of CANVASES) {
        const layout = autoLayout({ archetype, pixelSize });
        expect(layout.bar.enabled).toBe(false);
        expect(layout.logo.onBand).toBe(false);
      }
    }
  });

  it("offers six distinct designs", () => {
    expect(ARCHETYPES).toHaveLength(6);
    const signature = (archetype: (typeof ARCHETYPES)[number]) => {
      const layout = autoLayout({ archetype, pixelSize: CANVASES[0]! });
      return JSON.stringify([layout.logo.position, layout.headline]);
    };
    expect(new Set(ARCHETYPES.map(signature)).size).toBe(6);
  });

  it("minimal posts carry no headline; the others do", () => {
    expect(
      autoLayout({ archetype: "minimal-luxe", pixelSize: CANVASES[0]! }).headline
        .enabled,
    ).toBe(false);
    for (const archetype of ["editorial", "statement", "product", "promo", "info"] as const) {
      expect(autoLayout({ archetype, pixelSize: CANVASES[0]! }).headline.enabled).toBe(true);
    }
  });

  it("names its id so a revision can keep the archetype", () => {
    const layout = autoLayout({ archetype: "promo", pixelSize: CANVASES[2]! });
    expect(layout.id).toBe("auto-promo-square");
    expect(archetypeOfAutoId(layout.id)).toBe("promo");
    expect(archetypeOfAutoId("auto-minimal-luxe-vertical")).toBe("minimal-luxe");
    expect(archetypeOfAutoId("classic")).toBeNull();
    expect(archetypeOfAutoId("auto-nonsense-square")).toBeNull();
    expect(archetypeOfAutoId(undefined)).toBeNull();
  });

  it("defaults to a feed-sized canvas", () => {
    expect(autoLayout({ archetype: "editorial" }).formats).toEqual(["portrait"]);
  });
});

describe("classifyArchetype", () => {
  const cases: [string, string][] = [
    ["Kadıköy'de üretim yapan butik kozmetik markası, doğal ürünler", "product"],
    ["Büyük indirim ve kampanyalar sunan e-ticaret mağazası", "promo"],
    ["B2B yazılım ve danışmanlık hizmeti veren SaaS şirketi", "info"],
    ["Luxury boutique hotel and spa", "minimal-luxe"],
    ["Diş kliniği ve sağlık merkezi", "info"],
    ["Specialty coffee roaster and cafe", "product"],
  ];
  for (const [text, expected] of cases) {
    it(`reads "${text.slice(0, 40)}…" as ${expected}`, () => {
      expect(classifyArchetype({ text })).toBe(expected);
    });
  }

  it("falls back to editorial when nothing matches", () => {
    expect(classifyArchetype({ text: "" })).toBe("editorial");
    expect(classifyArchetype({ text: "Bir şirket" })).toBe("editorial");
  });

  it("lets the brand's mood tip a close call", () => {
    expect(
      classifyArchetype({
        text: "Premium ürün",
        moodTags: ["elegant", "minimal"],
      }),
    ).toBe("minimal-luxe");
  });
});

describe("autoLayout following the brand's example posts", () => {
  const traits = {
    logoCorner: "TOP_RIGHT",
    headlineZone: "BOTTOM",
    headlineAlign: "left",
    headlineScale: "XL",
    bar: "band",
  } as const;

  it("places the logo and the headline the way the examples do", () => {
    const layout = autoLayout({
      archetype: "editorial",
      pixelSize: CANVASES[0]!,
      traits,
    });
    expect(layout.logo.position).toBe("TOP_RIGHT");
    expect(layout.headline).toMatchObject({
      enabled: true,
      zone: "BOTTOM",
      align: "left",
      scale: "XL",
    });
    // The examples' bar is not copied: no design has one.
    expect(layout.bar.enabled).toBe(false);
    expect(() => LayoutTemplateSchema.parse(layout)).not.toThrow();
  });

  it("an example with no headline gives a post with none", () => {
    const layout = autoLayout({
      archetype: "promo",
      pixelSize: CANVASES[2]!,
      traits: { ...traits, headlineZone: "none" },
    });
    expect(layout.headline.enabled).toBe(false);
  });

  it("keeps the archetype's logo corner when the examples show no logo", () => {
    const plain = autoLayout({ archetype: "editorial", pixelSize: CANVASES[0]! });
    const followed = autoLayout({
      archetype: "editorial",
      pixelSize: CANVASES[0]!,
      traits: { ...traits, logoCorner: "none" },
    });
    expect(followed.logo.position).toBe(plain.logo.position);
  });

  it("leaves a Story to its safe-area design", () => {
    const plain = autoLayout({ archetype: "editorial", pixelSize: CANVASES[4]! });
    expect(
      autoLayout({ archetype: "editorial", pixelSize: CANVASES[4]!, traits }),
    ).toEqual(plain);
  });

  it("stays a valid layout for every combination", () => {
    for (const logoCorner of ["TOP_LEFT", "CENTER_BOTTOM", "none"] as const) {
      for (const headlineZone of ["TOP", "CENTER", "LEFT_COLUMN", "none"] as const) {
        for (const bar of ["none", "line", "band"] as const) {
          for (const pixelSize of CANVASES) {
            const layout = autoLayout({
              archetype: "info",
              pixelSize,
              traits: { ...traits, logoCorner, headlineZone, bar },
            });
            expect(() => LayoutTemplateSchema.parse(layout)).not.toThrow();
          }
        }
      }
    }
  });
});
