import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceOutputItem } from "./workspace-right-panel-data";

// The panel's forms post through server actions (prisma, next-auth); none of
// them run during a static render.
// The quick edit's form reads the router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/server/actions/command-actions", () => ({
  submitProjectCommandAction: vi.fn(),
}));
vi.mock("@/server/actions/creative-calendar-actions", () => ({
  assignCreativeDateAction: vi.fn(),
}));

const { CalendarPanel } = await import("./calendar-panel");

const unscheduled: WorkspaceOutputItem[] = [
  {
    id: "c1",
    type: "SOCIAL_POST",
    platform: "INSTAGRAM",
    status: "DRAFT",
    title: "Autumn post",
    createdAt: "2026-10-01T08:00:00.000Z",
    assetId: null,
    contentFormat: null,
  },
];

const calendar = { items: [], unscheduled, timezone: "UTC", month: "2026-10" };

const render = (workId?: string) =>
  renderToStaticMarkup(
    createElement(CalendarPanel, {
      projectId: "p1",
      workId,
      calendar,
    }),
  );

// The bare project URL starts a new chat, so a link that dropped `?work=` would
// leave the conversation the person is in.
describe("CalendarPanel's quick edit", () => {
  const selected = {
    id: "c1",
    title: "Autumn post",
    platform: "INSTAGRAM" as const,
    status: "DRAFT" as const,
    assetId: null,
    scheduledFor: "2026-10-05T09:00:00.000Z",
  };
  const renderSelected = (workId?: string) =>
    renderToStaticMarkup(
      createElement(CalendarPanel, {
        projectId: "p1",
        workId,
        calendar,
        selectedItem: selected,
      }),
    );

  it("closes back to the month in the same chat", () => {
    expect(renderSelected("w1")).toMatch(
      /aria-label="Close"[^>]*href="\/projects\/p1\?work=w1&amp;calMonth=2026-10"|href="\/projects\/p1\?work=w1&amp;calMonth=2026-10"[^>]*aria-label="Close"/,
    );
  });

  it("without a Work the Close link is the plain one", () => {
    expect(renderSelected()).toMatch(
      /aria-label="Close"[^>]*href="\/projects\/p1\?calMonth=2026-10"|href="\/projects\/p1\?calMonth=2026-10"[^>]*aria-label="Close"/,
    );
  });
});

describe("CalendarPanel links", () => {
  it("keep the open Work: month paging and the unscheduled item", () => {
    const html = render("w1");
    expect(html).toContain('href="/projects/p1?work=w1&amp;calMonth=2026-09"');
    expect(html).toContain('href="/projects/p1?work=w1&amp;calMonth=2026-11"');
    expect(html).toContain(
      'href="/projects/p1?work=w1&amp;calMonth=2026-10&amp;calItem=c1"',
    );
  });

  it("encode the Work id like every other Work link", () => {
    expect(render("a b&c")).toContain(
      'href="/projects/p1?work=a%20b%26c&amp;calMonth=2026-09"',
    );
  });

  it("are the plain ones without a Work (Works off)", () => {
    const html = render();
    expect(html).toContain('href="/projects/p1?calMonth=2026-09"');
    expect(html).toContain(
      'href="/projects/p1?calMonth=2026-10&amp;calItem=c1"',
    );
    expect(html).not.toContain("work=");
  });
});
