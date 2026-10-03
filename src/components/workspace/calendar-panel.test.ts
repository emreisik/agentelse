import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Server actions (prisma, next-auth) never run in a static render.
vi.mock("@/server/actions/command-actions", () => ({
  submitProjectCommandAction: vi.fn(),
}));
vi.mock("@/server/actions/creative-calendar-actions", () => ({
  rescheduleCreativeAction: vi.fn(),
}));
vi.mock("@/components/calendar/creative-detail", () => ({
  CreativeDetail: () => null,
}));

const { CalendarPanel } = await import("./calendar-panel");

const render = () =>
  renderToStaticMarkup(
    createElement(CalendarPanel, { projectId: "p1", timezone: "UTC" }),
  );

// The tab reads its data client-side; the first paint is the shell with a
// skeleton, never a server round-trip per month like the old `?calMonth=`.
describe("CalendarPanel", () => {
  it("renders the month/week/list switch and the summary tiles", () => {
    const html = render();
    for (const label of ["Month", "Week", "List"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    for (const label of ["Planned", "Needs you", "Scheduled", "Published"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="Platforms"');
    expect(html).toContain('placeholder="Search posts"');
  });

  it("links to the full calendar instead of paging the project page", () => {
    const html = render();
    expect(html).toContain('href="/projects/p1/takvim"');
    expect(html).not.toContain("calMonth");
  });
});
