import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/server/actions/work-actions", () => ({
  createWorkAction: vi.fn(),
}));

const { WorkListView, activeWorkIdOf, workHref } = await import("./work-list");
const { SidebarNav } = await import("./sidebar-nav");

const WORKS = [
  { id: "w1", title: "Weekly Plan", summary: "8 posts planned", status: "ACTIVE" },
  { id: "w2", title: "SEO · AF Treatment", summary: null, status: "DONE" },
] as const;

const view = (over: Partial<Parameters<typeof WorkListView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(WorkListView, {
      projectId: "proj-1",
      works: WORKS,
      activeWorkId: "w1",
      creating: false,
      onNew: () => undefined,
      ...over,
    }),
  );

describe("WorkListView", () => {
  it("lists title, subtitle and a status dot per Work, linking to ?work=", () => {
    const html = view();
    expect(html).toContain("Recent works");
    expect(html).toContain("Weekly Plan");
    expect(html).toContain("8 posts planned");
    expect(html).toContain(`href="${workHref("proj-1", "w1")}"`);
    expect(html).toContain('aria-label="Active"');
    expect(html).toContain('aria-label="Completed"');
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain("bg-violet-500");
  });

  it("gives a Work without a subtitle a neutral one that matches its status", () => {
    const html = view({
      works: [
        ...WORKS,
        { id: "w3", title: "Fresh", summary: null, status: "ACTIVE" },
      ],
    });
    expect(html).toContain("Active work");
    expect(html).toContain(">Completed<");
  });

  it("marks only the open Work as the current page", () => {
    const html = view({ activeWorkId: "w2" });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*href="[^"]*w2"/);
  });

  it("offers New Work, disabled while one is being created", () => {
    expect(view()).toContain("New Work");
    expect(view({ creating: true })).toMatch(/<button[^>]*disabled/);
  });

  it("says so when there are no works", () => {
    expect(view({ works: [] })).toContain("No works yet");
  });
});

const TODAY_ID = "today_proj-1_2026-10-01";
const EARLIER_ID = "today_proj-1_2026-09-30";
const todayRow = {
  id: TODAY_ID,
  title: "Today",
  summary: null,
  status: "ACTIVE",
  isToday: true,
} as const;
const earlierRow = { ...todayRow, id: EARLIER_ID } as const;

describe("WorkListView with a Today Work", () => {
  it("pins the Today row first with the daily-brief subtitle", () => {
    const html = view({
      works: [WORKS[0], todayRow, WORKS[1]],
      todayKey: "2026-10-01",
    });
    // The pinned row links by the moving ?work=today, not by yesterday's id.
    expect(html.indexOf('href="/projects/proj-1?work=today"')).toBeLessThan(
      html.indexOf("Weekly Plan"),
    );
    expect(html).not.toContain(TODAY_ID);
    expect(html).toContain("Daily brief");
    expect(html.match(/>Today</g)).toHaveLength(1);
  });

  it("shows a virtual first row linking to ?work=today until the Work exists", () => {
    const html = view({ todayKey: "2026-10-01" });
    expect(html).toContain('href="/projects/proj-1?work=today"');
    expect(html.indexOf("?work=today")).toBeLessThan(html.indexOf("Weekly Plan"));
    expect(html).not.toContain("No works yet");
  });

  it("never renders an earlier day's Today Work", () => {
    const html = view({
      works: [earlierRow, ...WORKS],
      todayKey: "2026-10-01",
    });
    expect(html).not.toContain(EARLIER_ID);
    expect(html).toContain("Weekly Plan");
  });

  it("highlights the Today row for ?work=today, real or virtual", () => {
    const real = view({
      works: [todayRow, ...WORKS],
      todayKey: "2026-10-01",
      activeWorkId: activeWorkIdOf(
        [todayRow, ...WORKS],
        "today",
        "2026-10-01",
        "proj-1",
      ),
    });
    expect(real.match(/aria-current="page"/g)).toHaveLength(1);
    expect(real).toMatch(/aria-current="page"[^>]*href="[^"]*work=today"/);
    const virtual = view({
      todayKey: "2026-10-01",
      activeWorkId: activeWorkIdOf([...WORKS], "today", "2026-10-01", "proj-1"),
    });
    expect(virtual).toMatch(/aria-current="page"[^>]*href="[^"]*work=today"/);
  });

  it("is unchanged without todayKey", () => {
    expect(view()).not.toContain("work=today");
    expect(view()).not.toContain("Daily brief");
  });
});

describe("activeWorkIdOf and Today", () => {
  it("maps ?work=today to the Today row, else to the virtual one", () => {
    expect(
      activeWorkIdOf([todayRow, earlierRow, ...WORKS], "today", "2026-10-01", "proj-1"),
    ).toBe(TODAY_ID);
    expect(activeWorkIdOf([...WORKS], "today", "2026-10-01", "proj-1")).toBe("today");
  });

  it("a bare URL prefers an ordinary active Work over the Today one", () => {
    expect(activeWorkIdOf([todayRow, ...WORKS], null)).toBe("w1");
    expect(activeWorkIdOf([todayRow], null)).toBe(TODAY_ID);
  });
});

describe("activeWorkIdOf", () => {
  it("prefers the URL's Work, else the newest active one", () => {
    expect(activeWorkIdOf([...WORKS], "w2")).toBe("w2");
    expect(activeWorkIdOf([...WORKS], null)).toBe("w1");
    expect(activeWorkIdOf([], null)).toBeNull();
  });
});

describe("SidebarNav with Works", () => {
  const nav = (works?: readonly (typeof WORKS)[number][]) =>
    renderToStaticMarkup(
      createElement(SidebarNav, { activeProjectId: "proj-1", works }),
    );

  it("shows the list right after Agency Desk, and Agency Desk is not highlighted", () => {
    const html = nav(WORKS);
    expect(html.indexOf("Agency Desk")).toBeLessThan(html.indexOf("Recent works"));
    expect(html.indexOf("Recent works")).toBeLessThan(html.indexOf("Brand Brain"));
  });

  it("is unchanged without Works", () => {
    expect(nav()).not.toContain("Recent works");
  });
});
