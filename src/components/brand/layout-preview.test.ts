import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_KIT_TEMPLATE } from "@/lib/brand-kit";
import { buildPresetLayouts } from "@/lib/layout-templates";

import {
  LayoutPreview,
  pickPreviewLogo,
  previewAspect,
} from "./layout-preview";

const layouts = buildPresetLayouts(DEFAULT_KIT_TEMPLATE).items;
const byId = (id: string) => layouts.find((item) => item.id === id)!;

const colors = { primary: "#0b1f3a", secondary: "#0d9488", accent: "#2dd4bf" };
const bothLogos = { light: "/api/assets/light", dark: "/api/assets/dark" };

function render(
  id: string,
  options: {
    colors?: Parameters<typeof LayoutPreview>[0]["colors"];
    logos?: Parameters<typeof LayoutPreview>[0]["logos"];
  } = {},
) {
  return renderToStaticMarkup(
    createElement(LayoutPreview, {
      layout: byId(id),
      colors: options.colors ?? colors,
      logos: options.logos ?? bothLogos,
    }),
  );
}

describe("LayoutPreview geometry", () => {
  it("brand band: a solid band at the layout's height with the logo seated on it", () => {
    const html = render("bottom-band");
    expect(html).toMatch(/data-part="band"[^>]*style="[^"]*height:13%/);
    expect(html).toMatch(/data-part="band"[^>]*style="[^"]*background-color:#0b1f3a/i);
    expect(html).toMatch(/data-part="band"[^>]*style="[^"]*opacity:1/);
    expect(html).toContain('data-part="logo-on-band"');
    expect(html).toMatch(/data-part="logo-on-band"[^>]*justify-content:flex-start/);
    // A dark navy band: the LIGHT logo is the one that reads on it.
    expect(html).toContain('data-logo-variant="light"');
    expect(html).toContain('src="/api/assets/light"');
  });

  it("a light band gets the dark logo instead", () => {
    const html = render("bottom-band", { colors: { ...colors, primary: "#f3f4f6" } });
    expect(html).toContain('data-logo-variant="dark"');
    expect(html).toContain('src="/api/assets/dark"');
  });

  it("center statement: logo centered at the top, a centered headline, no bar", () => {
    const html = render("center-statement");
    expect(html).toMatch(/data-part="logo"[^>]*left:50%/);
    expect(html).toMatch(/data-part="logo"[^>]*translateX\(-50%\)/);
    // 6% margin in width units = 4.8% of an 4:5 canvas's height.
    expect(html).toMatch(/data-part="logo"[^>]*top:4\.8/);
    expect(html).toMatch(/data-part="headline"[^>]*data-zone="CENTER"/);
    expect(html).toMatch(/data-part="headline"[^>]*top:50%/);
    expect(html).not.toContain('data-part="bar"');
    expect(html).not.toContain('data-part="band"');
  });

  it("headline on top: a thin bar, the logo lifted above it, margins converted to the canvas height", () => {
    const html = render("headline-top");
    expect(html).toMatch(/data-part="bar"[^>]*height:4%/);
    expect(html).toMatch(/data-part="bar"[^>]*opacity:0\.85/);
    // margin 5% (of width) * 0.8 = 4% of height, plus the 4% bar it must clear.
    expect(html).toMatch(/data-part="logo"[^>]*bottom:8%/);
    expect(html).toMatch(/data-part="logo"[^>]*left:5%/);
    expect(html).toMatch(/data-part="logo"[^>]*width:14%/);
    expect(html).toMatch(/data-part="headline"[^>]*data-zone="TOP"/);
  });

  it("left column: a half-width text column and no headline placeholders elsewhere", () => {
    const html = render("left-column");
    expect(html).toMatch(/data-part="headline"[^>]*data-zone="LEFT_COLUMN"[^>]*width:50%/);
    expect(html).toContain('data-part="subject"');
  });

  it("image only: no headline, no bar, just the corner logo", () => {
    const html = render("minimal-corner");
    expect(html).not.toContain('data-part="headline"');
    expect(html).not.toContain('data-part="bar"');
    expect(html).toMatch(/data-part="logo"[^>]*right:4%/);
  });

  it("uses the vertical canvas for the story layout", () => {
    expect(previewAspect(byId("story-full"))).toBe("vertical");
    expect(previewAspect(byId("classic"))).toBe("portrait");
    expect(previewAspect(byId("minimal-corner"))).toBe("portrait");
    expect(render("story-full")).toContain('data-aspect="vertical"');
  });

  it("shows a LOGO placeholder when the brand has none", () => {
    const html = render("classic", { logos: { light: null, dark: null } });
    expect(html).toContain("data-logo-placeholder");
    expect(html).not.toContain("<img");
  });

  it("falls back to neutral colours for a brand with no palette", () => {
    const html = render("classic", { colors: {} });
    expect(html).toContain("linear-gradient");
    expect(html).toContain("#334155");
  });
});

describe("pickPreviewLogo (mirrors applyBrandTemplate)", () => {
  it("picks by surface when both variants exist", () => {
    expect(pickPreviewLogo(bothLogos, "#000000")!.variant).toBe("light");
    expect(pickPreviewLogo(bothLogos, "#ffffff")!.variant).toBe("dark");
  });

  it("always uses the only variant there is, even where it will be hard to read", () => {
    expect(pickPreviewLogo({ light: "L", dark: null }, "#ffffff")).toEqual({ url: "L", variant: "light" });
    expect(pickPreviewLogo({ light: null, dark: "D" }, "#000000")).toEqual({ url: "D", variant: "dark" });
    expect(pickPreviewLogo({ light: null, dark: null }, "#000000")).toBeNull();
  });
});
