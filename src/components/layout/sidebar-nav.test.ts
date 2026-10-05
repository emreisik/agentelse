import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
}));
// The Work list creates a Work through a server action; nothing here calls it.
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: vi.fn(),
}));

const { SidebarNav, EXPLORE } = await import("./sidebar-nav");
const { SidebarShell } = await import("./sidebar-collapse");

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

  it("has no System group, and the removed panels are linked nowhere", () => {
    const html = render();
    expect(html).not.toContain("System");
    for (const label of ["Setup", "Departments", "Human Action"]) {
      expect(html).not.toContain(label);
    }
    expect(html).not.toContain("panel=setup");
    expect(html).not.toContain("panel=departments");
    expect(html).not.toContain("panel=human-action");
  });

  it("lists the day-to-day pages with no group titles, then Explore (Agency Desk only without Works)", () => {
    const html = render();
    const order = [
      "Agency Desk",
      "Brand Brain",
      "Ideas",
      "Library",
      "Content Calendar",
      ">Explore<",
    ].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("panel=brand-brain");
    expect(html).not.toContain(">Create<");
    expect(html).not.toContain(">Channels<");
  });

  it("keeps the channels, the task log and Settings behind Explore, not as lines of their own", () => {
    const html = render();
    for (const label of ["Ads Manager", "Connectors", "Task log", "Settings"]) {
      expect(html).not.toContain(label);
    }
    expect(EXPLORE.map((group) => group.map((item) => item.label))).toEqual([
      ["Ads Manager", "Connectors"],
      ["Task log", "Settings"],
    ]);
  });

  it("Explore reads as selected while one of its pages is open", () => {
    nav.search = "panel=settings";
    const html = render();
    nav.search = "";
    expect(html).toMatch(
      /<button[^>]*class="[^"]*bg-sidebar-accent font-medium[^"]*"[^>]*>[\s\S]*?Explore/,
    );
  });

  it("shows the badge on Brand Brain (goals waiting for a decision live there now)", () => {
    const html = render({ toolBadges: { "brand-brain": 2 } });
    expect(html).toMatch(/Brand Brain[\s\S]{0,400}>2</);
  });

  it("collapsed to the icon rail: icons named by aria-label, no group titles, no Recents", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: true },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: [],
          toolBadges: { "brand-brain": 2 },
        }),
      ),
    );
    expect(html).toContain("w-14");
    for (const label of ["New Chat", "Brand Brain", "Explore"]) {
      expect(html).toContain(`aria-label="${label}"`);
      // The label is only the icon's name, never visible text.
      expect(html).not.toContain(`>${label}<`);
    }
    expect(html).not.toContain("Create");
    expect(html).not.toContain("Recents");
    // A badge is a dot, not a count.
    expect(html).not.toMatch(/Brand Brain[\s\S]{0,400}>2</);
  });

  it("open by default: the docked sidebar is 256px with labels", () => {
    const html = renderToStaticMarkup(
      createElement(
        SidebarShell,
        { defaultCollapsed: false },
        createElement(SidebarNav, {
          activeProjectId: "proj-1",
          works: [],
        }),
      ),
    );
    expect(html).toContain("w-64");
    expect(html).toContain(">Brand Brain<");
    expect(html).toContain("Recents");
  });
});
