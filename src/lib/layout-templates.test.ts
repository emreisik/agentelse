import { describe, expect, it } from "vitest";

import { DEFAULT_KIT_TEMPLATE, type KitTemplate } from "./brand-kit";
import {
  aspectClassOf,
  barModeOf,
  buildPresetLayouts,
  defaultOverrides,
  describeLayout,
  duplicateLayout,
  MAX_LAYOUTS,
  normalizeLayoutNames,
  removeLayout,
  withBarMode,
  headlinePlacement,
  layoutReservedZones,
  layoutToTemplateConfig,
  LayoutTemplateSchema,
  LayoutTemplatesSchema,
  parseLayoutTemplates,
  resolveLayout,
  resolveLayoutColor,
  setDefaultLayout,
  type LayoutTemplate,
} from "./layout-templates";

const presets = () => buildPresetLayouts(DEFAULT_KIT_TEMPLATE);
const byId = (id: string): LayoutTemplate =>
  presets().items.find((item) => item.id === id)!;

describe("buildPresetLayouts", () => {
  it("produces a valid set with unique ids and a default", () => {
    const set = presets();
    expect(LayoutTemplatesSchema.safeParse(set).success).toBe(true);
    expect(new Set(set.items.map((i) => i.id)).size).toBe(set.items.length);
    expect(set.items.length).toBeGreaterThanOrEqual(6);
    expect(set.defaultId).toBe("classic");
  });

  it("makes 'classic' the brand's own current template, so adopting layouts changes nothing", () => {
    const base: KitTemplate = {
      ...DEFAULT_KIT_TEMPLATE,
      logoPosition: "TOP_LEFT",
      logoSizePercent: 20,
      logoMarginPercent: 6,
      accentBarPosition: "TOP",
      accentBarHeightPercent: 8,
      accentBarColorHex: "#112233",
    };
    const classic = buildPresetLayouts(base).items[0]!;
    expect(classic.logo).toMatchObject({ position: "TOP_LEFT", sizePercent: 20, marginPercent: 6, onBand: false });
    expect(classic.bar).toMatchObject({ enabled: true, position: "TOP", heightPercent: 8, style: "line", color: "#112233" });
    expect(classic.headline.enabled).toBe(false);
  });

  it("keeps a brand's bar-off choice in classic", () => {
    const classic = buildPresetLayouts({ ...DEFAULT_KIT_TEMPLATE, accentBarEnabled: false }).items[0]!;
    expect(classic.bar.enabled).toBe(false);
  });

  it("includes the band layout with the logo on the band, and a story layout with no bar", () => {
    const band = byId("bottom-band");
    expect(band.bar).toMatchObject({ enabled: true, style: "band", color: "primary" });
    expect(band.logo.onBand).toBe(true);
    const story = byId("story-full");
    expect(story.bar.enabled).toBe(false);
    expect(story.formats).toEqual(["vertical"]);
  });
});

describe("LayoutTemplateSchema", () => {
  it("rejects out-of-range geometry and bad ids/colours", () => {
    const ok = byId("classic");
    expect(LayoutTemplateSchema.safeParse(ok).success).toBe(true);
    expect(LayoutTemplateSchema.safeParse({ ...ok, id: "Has Spaces" }).success).toBe(false);
    expect(LayoutTemplateSchema.safeParse({ ...ok, logo: { ...ok.logo, sizePercent: 60 } }).success).toBe(false);
    expect(LayoutTemplateSchema.safeParse({ ...ok, bar: { ...ok.bar, color: "red" } }).success).toBe(false);
    expect(LayoutTemplateSchema.safeParse({ ...ok, headline: { ...ok.headline, zone: "MIDDLE" } }).success).toBe(false);
  });

  it("requires a real default and unique ids", () => {
    const set = presets();
    expect(LayoutTemplatesSchema.safeParse({ ...set, defaultId: "nope" }).success).toBe(false);
    expect(
      LayoutTemplatesSchema.safeParse({ ...set, items: [set.items[0], set.items[0]] }).success,
    ).toBe(false);
  });
});

describe("parseLayoutTemplates", () => {
  it("round-trips a valid value", () => {
    const set = presets();
    expect(parseLayoutTemplates(JSON.parse(JSON.stringify(set)))).toEqual(set);
  });

  it("drops a corrupt item but keeps the rest, and repairs the default", () => {
    const set = presets();
    const broken = {
      ...set,
      defaultId: "gone",
      items: [{ id: "BAD ID" }, ...set.items.slice(1, 3), set.items[1]], // junk + 2 valid + duplicate
    };
    const parsed = parseLayoutTemplates(broken)!;
    expect(parsed.items.map((i) => i.id)).toEqual(["headline-top", "left-column"]);
    expect(parsed.defaultId).toBe("headline-top");
  });

  it("returns null for anything unusable", () => {
    for (const junk of [null, undefined, 5, "x", {}, { items: "no" }, { items: [] }, { items: [{ nope: 1 }] }]) {
      expect(parseLayoutTemplates(junk)).toBeNull();
    }
  });
});

describe("aspectClassOf", () => {
  it("classifies real platform sizes", () => {
    expect(aspectClassOf({ width: 1080, height: 1920 })).toBe("vertical");
    expect(aspectClassOf({ width: 1080, height: 1440 })).toBe("portrait");
    expect(aspectClassOf({ width: 1080, height: 1350 })).toBe("portrait");
    expect(aspectClassOf({ width: 1080, height: 1080 })).toBe("square");
    expect(aspectClassOf({ width: 1200, height: 628 })).toBe("landscape");
  });
});

describe("resolveLayout", () => {
  const set = presets();

  it("uses the requested layout, else the brand default", () => {
    expect(resolveLayout(set, { id: "left-column" })!.id).toBe("left-column");
    expect(resolveLayout(set)!.id).toBe("classic");
    expect(resolveLayout(set, { id: "deleted-layout" })!.id).toBe("classic");
  });

  it("switches to a layout made for the format when the default does not suit it", () => {
    // classic is for feed formats; a Story / Reel gets the layout made for it.
    expect(resolveLayout(set, { aspect: "vertical" })!.id).toBe("story-full");
    expect(resolveLayout(set, { aspect: "portrait" })!.id).toBe("classic");
  });

  it("still honours an explicit choice on any format", () => {
    expect(resolveLayout(set, { id: "classic", aspect: "vertical" })!.id).toBe("classic");
  });

  it("falls back to a generic layout, then the default, when nothing targets the format", () => {
    const onlyFeed = {
      ...set,
      items: set.items.filter((i) => ["classic", "headline-top", "center-statement"].includes(i.id)),
    };
    expect(resolveLayout(onlyFeed, { aspect: "vertical" })!.id).toBe("center-statement");
    const onlyClassic = { ...set, items: [set.items[0]!] };
    expect(resolveLayout(onlyClassic, { aspect: "vertical" })!.id).toBe("classic");
    expect(resolveLayout(null)).toBeNull();
  });
});

describe("resolveLayoutColor", () => {
  const palette = { primary: "#0b1f3a", accent: "#2dd4bf" };

  it("resolves roles through the palette with neighbouring fallbacks", () => {
    expect(resolveLayoutColor("primary", palette)).toBe("#0b1f3a");
    expect(resolveLayoutColor("accent", palette)).toBe("#2dd4bf");
    // No secondary colour: falls back to primary.
    expect(resolveLayoutColor("secondary", palette)).toBe("#0b1f3a");
    expect(resolveLayoutColor("primary", {})).toBeNull();
  });

  it("returns a fixed hex as-is", () => {
    expect(resolveLayoutColor("#aabbcc", palette)).toBe("#aabbcc");
  });
});

describe("layoutToTemplateConfig", () => {
  const palette = { primary: "#0b1f3a", accent: "#2dd4bf" };

  it("turns a thin-bar layout into translucent-line settings", () => {
    const cfg = layoutToTemplateConfig(byId("headline-top"), palette);
    expect(cfg).toMatchObject({
      enabled: true,
      logoPosition: "BOTTOM_LEFT",
      logoSizePercent: 14,
      accentBarEnabled: true,
      accentBarColorHex: "#2dd4bf",
      accentBarOpacity: 0.85,
      logoOnBar: false,
    });
  });

  it("turns the band layout into an opaque band with the logo on it", () => {
    const cfg = layoutToTemplateConfig(byId("bottom-band"), palette);
    expect(cfg).toMatchObject({
      accentBarEnabled: true,
      accentBarColorHex: "#0b1f3a",
      accentBarHeightPercent: 13,
      accentBarOpacity: 1,
      logoOnBar: true,
    });
  });

  it("drops the bar (and on-band logo) when it is off or the brand has no colour for it", () => {
    expect(layoutToTemplateConfig(byId("center-statement"), palette)).toMatchObject({
      accentBarEnabled: false,
      accentBarColorHex: null,
      logoOnBar: false,
    });
    expect(layoutToTemplateConfig(byId("bottom-band"), {})).toMatchObject({
      accentBarEnabled: false,
      logoOnBar: false,
    });
  });
});

describe("prompt wording", () => {
  it("describes headline placement precisely", () => {
    expect(headlinePlacement(byId("headline-top").headline)).toBe(
      "large, centered, at most 3 lines, placed in the upper third of the frame",
    );
    expect(headlinePlacement(byId("left-column").headline)).toContain("left-aligned");
    expect(headlinePlacement(byId("left-column").headline)).toContain("column along the left side");
    expect(headlinePlacement({ enabled: true, zone: "CENTER", align: "center", maxLines: 1, scale: "XL" })).toContain(
      "very large and dominant, centered, at most 1 line,",
    );
  });

  it("names the areas that compositing will cover", () => {
    const line = layoutReservedZones(byId("headline-top"), { hasLogo: true })!;
    expect(line).toContain("thin band along the bottom edge");
    expect(line).toContain("bottom-left corner");
    expect(line).toContain("14% of the width");

    const band = layoutReservedZones(byId("bottom-band"), { hasLogo: true })!;
    expect(band).toContain("bottom 13% of the frame");
    // The logo sits ON the band, so it is not a separate reserved corner.
    expect(band).not.toContain("corner");

    expect(layoutReservedZones(byId("headline-top"), { hasLogo: false })).not.toContain("logo");
    expect(layoutReservedZones({ ...byId("minimal-corner"), logo: byId("minimal-corner").logo }, { hasLogo: false })).toBeUndefined();
  });

  it("summarizes a layout in one line", () => {
    expect(describeLayout(byId("bottom-band"))).toBe(
      "headline bottom, left · logo bottom-left corner · brand band bottom",
    );
    expect(describeLayout(byId("minimal-corner"))).toBe(
      "no headline · logo top-right corner · no bar",
    );
  });
});

describe("editing helpers", () => {
  it("switching the bar mode keeps geometry coherent", () => {
    const band = byId("bottom-band");
    expect(barModeOf(band)).toBe("band");

    // Band -> line: thin, and the logo comes off the band.
    const line = withBarMode(band, "line");
    expect(line.bar).toMatchObject({ enabled: true, style: "line", heightPercent: 8 });
    expect(line.logo.onBand).toBe(false);

    // Line -> band: tall enough to hold a logo.
    const back = withBarMode(byId("headline-top"), "band");
    expect(back.bar).toMatchObject({ enabled: true, style: "band", heightPercent: 8 });

    // Off: no bar and nothing to sit on.
    const off = withBarMode(band, "none");
    expect(barModeOf(off)).toBe("none");
    expect(off.logo.onBand).toBe(false);

    for (const mode of ["none", "line", "band"] as const) {
      expect(LayoutTemplateSchema.safeParse(withBarMode(band, mode)).success).toBe(true);
    }
  });

  it("duplicates with a fresh unique id and a valid set", () => {
    let set = presets();
    const first = duplicateLayout(set, "classic")!;
    expect(first.newId).toBe("classic-copy");
    set = first.value;
    const second = duplicateLayout(set, "classic-copy")!;
    expect(second.newId).toBe("classic-copy-2");
    expect(second.value.items.find((i) => i.id === "classic-copy-2")!.name).toBe(
      "Classic copy copy",
    );
    expect(LayoutTemplatesSchema.safeParse(second.value).success).toBe(true);
    expect(duplicateLayout(set, "nope")).toBeNull();
  });

  it("refuses to grow past the maximum", () => {
    let set = presets();
    while (set.items.length < MAX_LAYOUTS) set = duplicateLayout(set, "classic")!.value;
    expect(set.items).toHaveLength(MAX_LAYOUTS);
    expect(duplicateLayout(set, "classic")).toBeNull();
  });

  it("never removes the default or the last layout", () => {
    const set = presets();
    expect(removeLayout(set, set.defaultId)).toBeNull();
    const removed = removeLayout(set, "left-column")!;
    expect(removed.items.some((i) => i.id === "left-column")).toBe(false);
    expect(removed.items).toHaveLength(set.items.length - 1);
    expect(removeLayout(set, "nope")).toBeNull();
    expect(removeLayout({ ...set, items: [set.items[0]!] }, "classic")).toBeNull();
  });

  it("gives a cleared name a fallback and trims the rest", () => {
    const set = presets();
    const edited = {
      ...set,
      items: [{ ...set.items[0]!, name: "   " }, { ...set.items[1]!, name: "  Spring launch  " }],
    };
    const normalized = normalizeLayoutNames(edited);
    expect(normalized.items.map((i) => i.name)).toEqual(["Layout", "Spring launch"]);
  });
});

describe("setDefaultLayout", () => {
  it("makes the chosen layout the default, without touching the layouts", () => {
    const templates = presets();
    const other = templates.items[2]!;
    const next = setDefaultLayout(templates, other.id);
    expect(next.defaultId).toBe(other.id);
    expect(next.items).toBe(templates.items);
    // What was saved resolves to it for a post it suits.
    expect(resolveLayout(next, { aspect: "portrait" })?.id).toBe(other.id);
  });

  it("hands back the same object when nothing changes", () => {
    const templates = presets();
    expect(setDefaultLayout(templates, templates.defaultId)).toBe(templates);
    expect(setDefaultLayout(templates, "no-such-layout")).toBe(templates);
  });
});

describe("defaultOverrides", () => {
  const withDefault = (id: string) => setDefaultLayout(presets(), id);

  it("a default made for Posts gives Story / Reel to the layout made for it", () => {
    const overrides = defaultOverrides(withDefault(presets().items[1]!.id));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.label).toBe("Story / Reel 9:16");
    expect(overrides[0]!.layout.formats).toContain("vertical");
  });

  it("a Story-only default gives Posts and Squares to another layout", () => {
    const story = presets().items.find((item) =>
      item.formats.includes("vertical") && item.formats.length === 1,
    )!;
    const labels = defaultOverrides(withDefault(story.id)).map((o) => o.label);
    expect(labels).toEqual(["Post 3:4", "Square 1:1"]);
  });

  it("a layout that suits every shape is never overridden", () => {
    const anyShape = presets().items.find((item) => item.formats.length === 0)!;
    expect(defaultOverrides(withDefault(anyShape.id))).toEqual([]);
  });
});
