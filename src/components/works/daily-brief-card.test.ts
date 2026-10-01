import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { NextStep } from "@/lib/journey";
import type { DailyBrief } from "@/lib/works/daily-brief";
import type { WorkCardHostInput } from "./work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/work-actions", () => ({
  openChannelWorkAction: vi.fn(),
}));

const { DailyBriefCard, nextButtonLabel, briefDayLabel } = await import(
  "./daily-brief-card"
);
const { WorkCardHostProvider } = await import("./work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "today_p1_2026-10-02",
  workTitle: "Today",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const STEP = {
  key: "produce",
  tone: "next",
  label: "Produce 3",
  title: "3 posts are ready to produce",
  action: { kind: "produce_plan", planId: "pl1", count: 3 },
} as unknown as NextStep;

const BRIEF: DailyBrief = {
  kind: "daily-brief",
  day: "2026-10-02",
  heading: "Today",
  summary: "3 things for today",
  rows: [
    {
      id: "item-a",
      group: "content",
      title: "Launch post",
      stage: "IN_REVIEW",
      statusLabel: "In review",
      channel: "instagram",
      actionLabel: "Review",
      action: { kind: "link", href: "/projects/p1/takvim?creative=a" },
    },
    {
      id: "item-b",
      group: "seo",
      title: "Blog article",
      stage: "PLANNED",
      statusLabel: "A very long status label that must wrap",
      actionLabel: "Open",
      action: { kind: "link", href: "/projects/p1/takvim?creative=b" },
    },
    {
      id: "channel-x",
      group: "channel",
      title: "X is connected. Start a Work for it",
      channel: "x",
      actionLabel: "Start",
      action: { kind: "open-channel-work", channel: "x" },
    },
  ],
  more: 2,
  next: { title: STEP.title, label: "Produce 3", costNote: "about $0.24", step: STEP },
  primary: { label: "Plan today", action: { kind: "send", text: "Plan.\n[Plan brief]" } },
  secondary: { label: "Check performance", action: { kind: "send", text: "How?" } },
  focus: "Grow leads",
  yesterday: { published: 2, failed: 1 },
};

const render = (card: DailyBrief, host: WorkCardHostInput | null = HOST) => {
  const inner = createElement(DailyBriefCard, { card });
  return renderToStaticMarkup(
    host ? createElement(WorkCardHostProvider, { value: host }, inner) : inner,
  );
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("DailyBriefCard", () => {
  it("renders nothing without a host", () => {
    expect(render(BRIEF, null)).toBe("");
  });

  it("renders the computed weekday heading and the jump anchor", () => {
    const html = render(BRIEF);
    expect(html).toMatch(/<div id="daily-brief" tabindex="-1"/);
    expect(html).toContain("Today · Fri 2 Oct");
    expect(briefDayLabel("2026-10-02")).toBe("Fri 2 Oct");
    expect(html).toContain("3 things for today");
  });

  it("renders groups, badges, stage pills and every row button", () => {
    const html = render(BRIEF);
    for (const text of ["Content", "SEO", "Launch post", "Blog article", "In review"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("whitespace-normal");
    expect(html).toContain('title="Instagram"');
    expect(html).toContain(">Review<");
    expect(html).toContain(">Open<");
    expect(html).toContain(">Start<");
    expect(html).toContain("/projects/p1/takvim?creative=a");
    expect(html).toContain("+2 more");
  });

  it("gives the next row its own labelled button with the cost", () => {
    const html = render(BRIEF);
    expect(html).toContain(">Next<");
    expect(html).toContain("Produce 3 · about $0.24");
    expect(nextButtonLabel({ ...BRIEF.next!, costNote: undefined })).toBe("Produce 3");
    // The footer holds only the primary and the secondary.
    const footer = html.slice(html.lastIndexOf("Plan today") - 200);
    expect(footer).not.toContain("Produce 3");
  });

  it("shows the yesterday and focus lines", () => {
    const html = render(BRIEF);
    expect(html).toContain("Yesterday: 2 published, 1 failed.");
    expect(html).toContain("Focus: Grow leads");
    expect(
      render({ ...BRIEF, yesterday: { published: 0, failed: 0 } }),
    ).toContain("Yesterday: nothing went out.");
  });

  it("keeps the footer to a primary and a quiet secondary", () => {
    const html = render(BRIEF);
    expect(count(html, 'data-emphasis="primary"')).toBe(1);
    expect(html).toContain("Plan today");
    expect(html).toContain("Check performance");
    // Every button is 44 px tall.
    const buttons = count(html, "<button") + count(html, "<a ");
    expect(count(html, "min-h-11")).toBe(buttons);
    // 3 rows + next + 2 footer buttons.
    expect(buttons).toBe(6);
  });

  it("collapses the empty day to the summary and the primary", () => {
    const html = render({
      ...BRIEF,
      rows: [],
      more: 0,
      next: undefined,
      summary: "Nothing is scheduled for today.",
      focus: undefined,
    });
    expect(html).toContain("Nothing is scheduled for today.");
    expect(html).toContain("Plan today");
    expect(html).not.toContain("Check performance");
    expect(html).not.toContain("Yesterday");
    expect(count(html, "min-h-11")).toBe(1);
  });

  it("renders the connect link primary as a link", () => {
    const html = render({
      ...BRIEF,
      rows: [],
      more: 0,
      next: undefined,
      primary: {
        label: "Connect a channel",
        action: { kind: "link", href: "/projects/p1/integrations" },
      },
    });
    expect(html).toContain('href="/projects/p1/integrations"');
    expect(html).toContain("Connect a channel");
  });
});
