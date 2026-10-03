import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
// The Work list creates a Work through a server action; nothing here calls it.
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: vi.fn(),
}));

const { SidebarNav } = await import("./sidebar-nav");

const render = (props: Partial<Parameters<typeof SidebarNav>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SidebarNav, { activeProjectId: "proj-1", ...props }),
  );

describe("SidebarNav", () => {
  it("has no Insights group: Signals, Insights & Opportunities and Goals are Brand Brain tabs", () => {
    const html = render();
    expect(html).not.toContain(">Insights<");
    expect(html).not.toContain("Signals");
    expect(html).not.toContain("Insights &amp; Opportunities");
    expect(html).not.toContain(">Goals<");
    expect(html).not.toContain("panel=signals");
    expect(html).not.toContain("panel=goals");
    expect(html).not.toContain("panel=insights-opportunities");
  });

  it("has no System group: Setup, Departments and Human Action live in the Advanced menu", () => {
    const html = render();
    expect(html).not.toContain("System");
    for (const label of ["Setup", "Departments", "Human Action"]) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain("panel=setup");
    expect(html).not.toContain("panel=departments");
    expect(html).not.toContain("panel=human-action");
  });

  it("keeps the rest of the navigation (Agency Desk only without Works), with Settings as one line at the bottom", () => {
    const html = render();
    for (const label of [
      "Agency Desk",
      "Brand Brain",
      "Ideas",
      "Work",
      "Library",
      "Content Calendar",
      "Ads Manager",
      "Connectors",
      "Settings",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("panel=brand-brain");
    expect(html).toContain("panel=settings");
    // Last in the list, in a group of its own pinned to the bottom, with no title.
    expect(html.indexOf("Settings")).toBeGreaterThan(html.indexOf("Connectors"));
    expect(html.match(/mt-auto/g)).toHaveLength(1);
    expect(html.lastIndexOf("mt-auto")).toBeLessThan(html.indexOf("Settings"));
  });

  it("shows the badge on Brand Brain (goals waiting for a decision live there now)", () => {
    const html = render({ toolBadges: { "brand-brain": 2 } });
    expect(html).toMatch(/Brand Brain[\s\S]{0,400}>2</);
  });
});
