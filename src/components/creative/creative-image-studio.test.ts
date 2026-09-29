import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/actions/creative-actions", () => ({
  generateRealCreativeImageAction: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { CreativeImageStudio } = await import("./creative-image-studio");

const layouts = [
  { id: "classic", name: "Classic", description: "Logo bottom right" },
  { id: "bottom-band", name: "Brand band" },
];

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(CreativeImageStudio, {
      creativeId: "cr1",
      hasImage: true,
      platform: "INSTAGRAM",
      ...props,
    }),
  );

describe("CreativeImageStudio layout picker", () => {
  it("is absent for a brand without saved layouts: the studio looks as before", () => {
    const html = render();
    expect(html).not.toContain("Post layout");
    expect(html).not.toContain('name="layoutId"');
  });

  it("offers the brand's layouts and explains that only a fresh render can switch", () => {
    const html = render({ layouts, currentLayoutId: "bottom-band" });
    expect(html).toContain("Post layout");
    expect(html).toContain("Keep current (Brand band)");
    expect(html).toContain("editing keeps the image");
  });

  it("falls back to the brand default when the current layout is unknown", () => {
    const html = render({ layouts, currentLayoutId: null });
    expect(html).toContain("Brand default");
    expect(html).not.toContain("Keep current");
  });

  it("sends no layout by default, so the creative keeps its own", () => {
    expect(render({ layouts, currentLayoutId: "classic" })).not.toContain(
      'name="layoutId"',
    );
  });
});
