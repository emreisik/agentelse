import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IdeaOptionsCardData } from "@/lib/works/idea-options";
import type { WorkCardHostInput } from "./work-card-host";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/plan-options-actions", () => ({
  pickPlanOptionAction: vi.fn(),
}));
vi.mock("@/server/actions/schedule-slots-actions", () => ({
  scheduleSlotsAction: vi.fn(),
}));
vi.mock("@/server/actions/slot-suggest-actions", () => ({
  suggestSlotsAction: vi.fn(),
}));

const { IdeaOptionsCard, IdeaPlanPanelView, buildTargets, mapScheduleResult } =
  await import("./idea-options-card");
const { WorkCardHostProvider } = await import("./work-card-host");

const HOST: WorkCardHostInput = {
  projectId: "p1",
  workId: "w1",
  workTitle: "Week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [
    { key: "instagram", label: "Instagram", connected: true },
    { key: "linkedin", label: "LinkedIn", connected: true },
  ],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const CARD: IdeaOptionsCardData = {
  kind: "idea-options",
  title: "3 ideas for Instagram",
  reason: "Ideas based on your brand profile.",
  brandCheck: { state: "checked", rules: 2 },
  items: [
    {
      ideaId: "i1",
      title: "Pricing explained",
      description: "What a plan costs.",
    },
    { ideaId: "i2", title: "Meet the team", description: "Who we are." },
  ],
};

const count = (html: string, needle: string) => html.split(needle).length - 1;

function render(
  card: IdeaOptionsCardData = CARD,
  host: Partial<WorkCardHostInput> | null = {},
) {
  const inner = createElement(IdeaOptionsCard, { card, commandId: "cmd2" });
  return renderToStaticMarkup(
    host === null
      ? inner
      : createElement(
          WorkCardHostProvider,
          { value: { ...HOST, ...host } },
          inner,
        ),
  );
}

type PanelProps = Parameters<typeof IdeaPlanPanelView>[0];

const PANEL: PanelProps = {
  channels: [
    { key: "instagram", label: "Instagram" },
    { key: "linkedin", label: "LinkedIn" },
  ],
  selected: ["instagram"],
  byChannel: {
    instagram: [
      { date: "2026-10-02", time: "11:00" },
      { date: "2026-10-03", time: "10:00" },
    ],
  },
  index: {},
  timezone: "Europe/Istanbul",
  loading: false,
  noChannel: false,
  brandBlocked: false,
  busyId: null,
  error: null,
  disabledReason: null,
  onToggle: () => undefined,
  onOther: () => undefined,
  onAct: () => undefined,
};

const panel = (over: Partial<PanelProps> = {}) =>
  renderToStaticMarkup(createElement(IdeaPlanPanelView, { ...PANEL, ...over }));

describe("IdeaOptionsCard (W77 idea-card)", () => {
  it("each Plan it button is described by its own idea title", () => {
    const html = render();
    const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  it("renders a row per idea with title, description and ONE Plan it each", () => {
    const html = render();
    expect(html).toContain('data-card="idea-options"');
    expect(html).toContain("3 ideas for Instagram");
    expect(html).toContain("Pricing explained");
    expect(html).toContain("What a plan costs.");
    expect(html).toContain("line-clamp-3");
    expect(count(html, "Plan it")).toBe(2);
    expect(count(html, 'data-emphasis="primary"')).toBe(2);
    expect(html).toContain("min-h-11");
    expect(html).toContain("Checked against 2 brand rules.");
    // No panel until a press.
    expect(html).not.toContain("Where should it go?");
    expect(html).not.toContain('aria-disabled="true"');
  });

  it("falls back to the default title and reason", () => {
    const html = render({ ...CARD, title: "", reason: "" });
    expect(html).toContain("2 ideas for Instagram, LinkedIn");
    expect(html).toContain("Ideas based on your brand profile.");
  });

  it("shows the scheduled chip (live overlay) INSTEAD of Plan it", () => {
    const html = render({
      ...CARD,
      scheduled: {
        i1: { date: "2026-10-02", time: "11:00", channel: "instagram" },
      },
    });
    expect(html).toContain("On your calendar · Fri 2 Oct, 11:00");
    expect(html).toContain("Open calendar");
    expect(html).toContain('href="/projects/p1/takvim"');
    // Only the second idea is still plannable.
    expect(count(html, "Plan it")).toBe(1);
  });

  it("blocks Plan it with one visible reason in a completed Work", () => {
    const html = render(CARD, { active: false });
    expect(count(html, 'aria-disabled="true"')).toBe(2);
    expect(count(html, "This Work is completed. Reopen it to continue.")).toBe(
      1,
    );
  });

  it("returns nothing outside a Work", () => {
    expect(render(CARD, null)).toBe("");
  });
});

describe("IdeaPlanPanelView (W77 idea-card)", () => {
  it("renders the labelled channel chips with aria-pressed", () => {
    const html = panel();
    expect(html).toContain("Where should it go?");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Channels"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(count(html, "min-h-11")).toBeGreaterThanOrEqual(5);
  });

  it("shows the suggestion, the zone line and Other time", () => {
    const html = panel();
    expect(html).toContain("Fri 2 Oct, 11:00 suggested");
    expect(html).toContain("Times in Europe/Istanbul");
    expect(html).toContain("Other time");
    expect(html).toContain('aria-label="Show another suggested time"');
  });

  it("shows the second suggestion once the index moved", () => {
    expect(panel({ index: { instagram: 1 } })).toContain(
      "Sat 3 Oct, 10:00 suggested",
    );
  });

  it("has no Other time for a single suggestion", () => {
    const html = panel({
      byChannel: { instagram: [{ date: "2026-10-02", time: "11:00" }] },
    });
    expect(html).not.toContain("Other time");
  });

  it("shows the empty state and blocks adding when no day is free", () => {
    const html = panel({ byChannel: { instagram: [] } });
    expect(html).toContain("No free day in the next 60 days for Instagram.");
    expect(html).toContain('aria-disabled="true"');
  });

  it("shows the loading line while suggestions load", () => {
    const html = panel({ byChannel: {}, loading: true });
    expect(html).toContain("Finding a free day…");
    expect(html).toContain('aria-disabled="true"');
  });

  it("shows the pick-a-channel validation text", () => {
    expect(panel({ noChannel: true })).toContain("Pick at least one channel.");
    expect(panel()).not.toContain("Pick at least one channel.");
  });

  it("labels Add & produce with the picture cost for an Instagram post", () => {
    const html = panel();
    expect(html).toContain("Add &amp; produce · about $0.08");
  });

  it("has no cost on Add & produce for a LinkedIn text piece", () => {
    const html = panel({
      selected: ["linkedin"],
      byChannel: { linkedin: [{ date: "2026-10-02", time: "11:00" }] },
    });
    expect(html).toContain("Add &amp; produce");
    expect(html).not.toContain("Add &amp; produce ·");
  });

  it("keeps the button budget: three buttons, one primary", () => {
    const html = panel();
    expect(count(html, 'data-emphasis="primary"')).toBe(1);
    expect(count(html, 'data-emphasis="secondary"')).toBe(1);
    expect(count(html, 'data-emphasis="quiet"')).toBe(1);
    expect(html).toContain("Add to calendar");
    expect(html).toContain("Cancel");
  });

  it("turns the primary into Add anyway after a brand block and drops produce", () => {
    const html = panel({
      brandBlocked: true,
      error: "A brand rule stops this.",
    });
    expect(html).toContain("Add anyway");
    expect(html).not.toContain("Add to calendar");
    expect(html).not.toContain("Add &amp; produce");
    expect(count(html, 'data-emphasis="primary"')).toBe(1);
    expect(html).toContain('role="alert"');
  });

  it("shows one row per selected channel with its name", () => {
    const html = panel({
      selected: ["instagram", "linkedin"],
      byChannel: {
        instagram: [{ date: "2026-10-02", time: "11:00" }],
        linkedin: [{ date: "2026-10-06", time: "10:00" }],
      },
    });
    expect(html).toContain('aria-label="Instagram"');
    expect(html).toContain('aria-label="LinkedIn"');
    expect(html).toContain("Tue 6 Oct, 10:00 suggested");
    // The zone is printed once.
    expect(count(html, "Times in Europe/Istanbul")).toBe(1);
  });
});

describe("buildTargets and mapScheduleResult (W77 idea-card)", () => {
  it("takes the suggestion each selected channel currently shows", () => {
    expect(
      buildTargets(
        ["instagram", "linkedin", "x"],
        {
          instagram: [
            { date: "2026-10-02", time: "11:00" },
            { date: "2026-10-03", time: "10:00" },
          ],
          linkedin: [],
        },
        { instagram: 1 },
      ),
    ).toEqual([{ channel: "instagram", date: "2026-10-03", time: "10:00" }]);
  });

  it("maps ok, STALE with a suggestion, BRAND_RULES, IDEA_GONE and WORK", () => {
    expect(
      mapScheduleResult({
        ok: true,
        commandId: "c1",
        alreadyScheduled: true,
        slots: [],
        ideaStatus: "MEASURING",
        timezone: "UTC",
      }),
    ).toEqual({ kind: "ok", commandId: "c1", alreadyScheduled: true });
    expect(
      mapScheduleResult({
        ok: false,
        code: "STALE",
        message: "x",
        suggestion: { channel: "instagram", date: "2026-10-04", time: "12:00" },
      }),
    ).toEqual({
      kind: "stale",
      channel: "instagram",
      slot: { date: "2026-10-04", time: "12:00" },
      message: "This card is out of date. Refreshing.",
    });
    expect(
      mapScheduleResult({
        ok: false,
        code: "BRAND_RULES",
        message: "A brand rule stops this.",
      }),
    ).toEqual({ kind: "brand", message: "A brand rule stops this." });
    expect(
      mapScheduleResult({ ok: false, code: "IDEA_GONE", message: "x" }),
    ).toEqual({
      kind: "error",
      message: "This idea can't be scheduled any more.",
    });
    expect(
      mapScheduleResult({ ok: false, code: "WORK", message: "x" }),
    ).toEqual({
      kind: "error",
      message: "This Work is completed. Reopen it to continue.",
    });
  });
});
