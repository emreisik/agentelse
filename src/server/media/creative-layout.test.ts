import { describe, expect, it } from "vitest";

import { DEFAULT_KIT_TEMPLATE } from "@/lib/brand-kit";
import { buildPresetLayouts } from "@/lib/layout-templates";
import type { BrandVisualIdentityContext } from "@/server/media/brand-style-context";

import {
  planCreativeLayout,
  readLayoutMeta,
  revisionLayoutRequest,
  safeZonePercent,
} from "./creative-layout";

const identity = (
  overrides: Partial<BrandVisualIdentityContext> = {},
): BrandVisualIdentityContext => ({
  primaryColors: [{ hex: "#0b1f3a" }],
  secondaryColors: [{ hex: "#0d9488" }],
  accentColors: [{ hex: "#2dd4bf" }],
  photographyStyle: null,
  styleRefinement: null,
  moodTags: [],
  compositionNotes: null,
  backgroundTone: null,
  alwaysInclude: [],
  alwaysAvoid: [],
  referenceImageAssetId: null,
  layoutTemplates: null,
  template: { ...DEFAULT_KIT_TEMPLATE },
  ...overrides,
});

const withLayouts = () =>
  identity({ layoutTemplates: buildPresetLayouts(DEFAULT_KIT_TEMPLATE) });

const FEED = { width: 1080, height: 1440 };
const STORY = { width: 1080, height: 1920 };

describe("planCreativeLayout without saved layouts (today's behaviour)", () => {
  it("passes the base template through untouched and records no layout", () => {
    const base = { ...DEFAULT_KIT_TEMPLATE, logoPosition: "TOP_LEFT" as const, logoSizePercent: 20 };
    const plan = planCreativeLayout({
      visualIdentity: identity({ template: base }),
      hasLogo: true,
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.layout).toBeNull();
    expect(plan.meta).toBeNull();
    expect(plan.template).toBe(base);
    expect(plan.composition).toBeUndefined();
    expect(plan.headlinePlacement).toBeUndefined();
    expect(plan.reservedZones).toContain("top-left corner");
    expect(plan.reservedZones).toContain("thin band along the bottom edge");
  });

  it("works for a brand with no Visual Identity row at all", () => {
    const plan = planCreativeLayout({ visualIdentity: null, hasLogo: true, hasHeadline: false });
    expect(plan.template).toBeUndefined();
    expect(plan.reservedZones).toContain("bottom-right corner");
    expect(plan.meta).toBeNull();
  });

  it("does not mention a logo that does not exist", () => {
    const plan = planCreativeLayout({ visualIdentity: null, hasLogo: false, hasHeadline: false });
    expect(plan.reservedZones).not.toContain("logo");
  });

  it("uses the generic headline spot when one is requested", () => {
    const plan = planCreativeLayout({ visualIdentity: null, hasLogo: true, hasHeadline: true });
    // No layout to place it: the prompt builder's generic wording applies.
    expect(plan.headlinePlacement).toBeUndefined();
  });
});

describe("planCreativeLayout with saved layouts", () => {
  it("uses the brand default and turns it into compositing settings", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.meta).toEqual({ id: "classic", name: "Classic" });
    expect(plan.template).toMatchObject({
      enabled: true,
      logoPosition: "BOTTOM_RIGHT",
      accentBarEnabled: true,
      accentBarColorHex: "#2dd4bf", // the "accent" role, resolved from the palette
      accentBarOpacity: 0.85,
      logoOnBar: false,
    });
  });

  it("honours a requested layout: band settings, scene guidance, reserved areas", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      requestedId: "bottom-band",
      pixelSize: FEED,
      hasHeadline: true,
    });
    expect(plan.meta).toEqual({ id: "bottom-band", name: "Brand band" });
    expect(plan.template).toMatchObject({
      accentBarColorHex: "#0b1f3a",
      accentBarHeightPercent: 13,
      accentBarOpacity: 1,
      logoOnBar: true,
    });
    expect(plan.composition).toContain("bottom part of the frame stays plain");
    expect(plan.reservedZones).toContain("bottom 13% of the frame");
    expect(plan.headlinePlacement).toBe(
      "large, left-aligned, at most 3 lines, placed in the lower third of the frame, sitting above any band or bar at the bottom edge",
    );
  });

  it("picks the layout made for a Story when the default does not suit it", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      pixelSize: STORY,
      hasHeadline: true,
    });
    expect(plan.meta!.id).toBe("story-full");
    expect(plan.template).toMatchObject({ accentBarEnabled: false, logoPosition: "CENTER_BOTTOM" });
  });

  it("falls back to the default for an unknown id", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      requestedId: "deleted",
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.meta!.id).toBe("classic");
  });

  it("gives a requested headline a sensible spot even on a layout that has none", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      requestedId: "minimal-corner",
      pixelSize: FEED,
      hasHeadline: true,
    });
    expect(plan.headlinePlacement).toContain("upper third of the frame");
  });

  it("gives no headline placement when no headline is requested, even on a headline layout", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      requestedId: "headline-top",
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.headlinePlacement).toBeUndefined();
    // ...but the scene guidance still applies so the image is composed for it.
    expect(plan.composition).toContain("upper third calm");
  });

  it("drops a colour band the brand has no colour for", () => {
    const plan = planCreativeLayout({
      visualIdentity: {
        ...withLayouts(),
        primaryColors: [],
        secondaryColors: [],
        accentColors: [],
      },
      hasLogo: true,
      requestedId: "bottom-band",
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.template).toMatchObject({ accentBarEnabled: false, logoOnBar: false });
  });

  it("respects a brand that turned compositing off, layouts included", () => {
    const plan = planCreativeLayout({
      visualIdentity: {
        ...withLayouts(),
        template: { ...DEFAULT_KIT_TEMPLATE, enabled: false },
      },
      hasLogo: true,
      requestedId: "bottom-band",
      pixelSize: FEED,
      hasHeadline: true,
    });
    expect(plan.meta).toBeNull();
    expect(plan.template).toMatchObject({ enabled: false });
    expect(plan.reservedZones).toBeUndefined();
    expect(plan.composition).toBeUndefined();
    expect(plan.textPlacement).toBeNull();
  });

  it("names the headline zone the post's words are typeset in, whether or not a headline was asked for", () => {
    const plan = planCreativeLayout({
      visualIdentity: withLayouts(),
      hasLogo: true,
      requestedId: "left-column",
      pixelSize: FEED,
      hasHeadline: false,
    });
    expect(plan.textPlacement).toEqual({
      zone: "LEFT_COLUMN",
      align: "left",
      maxLines: 4,
      scale: "M",
    });
    // A layout without a headline zone, and a brand without layouts, carry none.
    expect(
      planCreativeLayout({
        visualIdentity: withLayouts(),
        hasLogo: true,
        requestedId: "minimal-corner",
        pixelSize: FEED,
        hasHeadline: false,
      }).textPlacement,
    ).toBeNull();
    expect(
      planCreativeLayout({
        visualIdentity: identity(),
        hasLogo: true,
        pixelSize: FEED,
        hasHeadline: true,
      }).textPlacement,
    ).toBeNull();
  });
});

describe("safeZonePercent", () => {
  it("converts platform UI bands from px to percent of the height", () => {
    expect(safeZonePercent({ top: 250, bottom: 340 }, STORY)).toEqual({ top: 13, bottom: 17.7 });
  });

  it("is undefined when there is nothing to reserve", () => {
    expect(safeZonePercent(undefined, STORY)).toBeUndefined();
    expect(safeZonePercent({}, STORY)).toBeUndefined();
    expect(safeZonePercent({ top: 250 }, undefined)).toBeUndefined();
  });
});

describe("readLayoutMeta", () => {
  it("reads the layout recorded on a finished generation", () => {
    expect(
      readLayoutMeta({ caption: "c", layoutTemplate: { id: "bottom-band", name: "Brand band" } }),
    ).toEqual({ id: "bottom-band", name: "Brand band" });
  });

  it("is null for versions made before layouts existed or with junk stored", () => {
    expect(readLayoutMeta(null)).toBeNull();
    expect(readLayoutMeta("x")).toBeNull();
    expect(readLayoutMeta({})).toBeNull();
    expect(readLayoutMeta({ layoutTemplate: null })).toBeNull();
    expect(readLayoutMeta({ layoutTemplate: { id: "", name: "x" } })).toBeNull();
    expect(readLayoutMeta({ layoutTemplate: { id: "a" } })).toBeNull();
    expect(readLayoutMeta({ layoutTemplate: { id: 3, name: "x" } })).toBeNull();
  });
});

describe("revisionLayoutRequest", () => {
  const made = (id: string, size = FEED) => ({
    layoutTemplate: { id, name: id },
    targetWidth: size.width,
    targetHeight: size.height,
  });

  it("edit: keeps the layout the image already carries, so nothing is stacked twice", () => {
    expect(
      revisionLayoutRequest({ mode: "edit", previous: made("bottom-band"), pixelSize: FEED }),
    ).toEqual({ requestedId: "bottom-band", keepLegacy: false });
  });

  it("edit: an image made before layouts existed is composed exactly as before", () => {
    expect(
      revisionLayoutRequest({ mode: "edit", previous: { prompt: "x" }, pixelSize: FEED }),
    ).toEqual({ requestedId: undefined, keepLegacy: true });
    expect(
      revisionLayoutRequest({ mode: "edit", previous: null, pixelSize: FEED }),
    ).toEqual({ requestedId: undefined, keepLegacy: true });
  });

  it("edit: ignores a picker choice, the pixels being edited decide", () => {
    expect(
      revisionLayoutRequest({
        mode: "edit",
        chosenId: "headline-top",
        previous: made("bottom-band"),
        pixelSize: FEED,
      }).requestedId,
    ).toBe("bottom-band");
  });

  it("new: the picker's choice wins", () => {
    expect(
      revisionLayoutRequest({
        mode: "new",
        chosenId: " headline-top ",
        previous: made("bottom-band"),
        pixelSize: FEED,
      }),
    ).toEqual({ requestedId: "headline-top", keepLegacy: false });
  });

  it("new: regenerating keeps the previous layout while the format keeps its shape", () => {
    expect(
      revisionLayoutRequest({ mode: "new", previous: made("bottom-band"), pixelSize: FEED })
        .requestedId,
    ).toBe("bottom-band");
    // Metadata without a stored size: assume nothing changed.
    expect(
      revisionLayoutRequest({
        mode: "new",
        previous: { layoutTemplate: { id: "bottom-band", name: "x" } },
        pixelSize: FEED,
      }).requestedId,
    ).toBe("bottom-band");
  });

  it("new: a Post layout is not reused when the format becomes a Story", () => {
    expect(
      revisionLayoutRequest({ mode: "new", previous: made("bottom-band"), pixelSize: STORY }),
    ).toEqual({ requestedId: undefined, keepLegacy: false });
  });

  it("new: nothing to reuse from an image made without layouts", () => {
    expect(
      revisionLayoutRequest({ mode: "new", previous: { prompt: "x" }, pixelSize: FEED }),
    ).toEqual({ requestedId: undefined, keepLegacy: false });
  });
});
