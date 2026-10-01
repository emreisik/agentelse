import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_KIT_TEMPLATE } from "@/lib/brand-kit";
import { buildPresetLayouts, setDefaultLayout } from "@/lib/layout-templates";

const { LayoutGallery } = await import("./layout-gallery");

const presets = () => buildPresetLayouts(DEFAULT_KIT_TEMPLATE);

const render = (value = presets()) =>
  renderToStaticMarkup(
    createElement(LayoutGallery, {
      value,
      onChange: vi.fn(),
      colors: { primary: "#1f3a5f", secondary: "#fff", accent: "#d97706" },
      logos: { light: null, dark: null },
      baseTemplate: DEFAULT_KIT_TEMPLATE,
    }),
  );

describe("LayoutGallery: choosing the layout new posts use", () => {
  it("says that clicking a layout is choosing it", () => {
    const html = render();
    expect(html).toContain("Click a layout to use it for new posts.");
    // Each card says what a click does.
    expect(html).toContain('title="Use this layout for new posts"');
    expect(html).toContain('title="The layout new posts use"');
  });

  it("shows one Default badge, on the layout in use", () => {
    const templates = setDefaultLayout(presets(), presets().items[2]!.id);
    const html = render(templates);
    expect(html.match(/>Default</g)).toHaveLength(1);
  });

  it("tells which post shapes the default is not used for", () => {
    // A default made for Posts: Story / Reel posts use the layout made for them.
    const html = render(setDefaultLayout(presets(), presets().items[1]!.id));
    expect(html).toContain("data-layout-overrides");
    expect(html).toContain("Story / Reel 9:16 posts use");
    expect(html).toContain("Story / Reel”");
  });

  it("says nothing when the default suits every shape", () => {
    const anyShape = presets().items.find((item) => item.formats.length === 0)!;
    expect(render(setDefaultLayout(presets(), anyShape.id))).not.toContain(
      "data-layout-overrides",
    );
  });
});
