import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/content-plan-actions", () => ({
  saveContentPlanAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-options-actions", () => ({
  swapPlanItemAction: vi.fn(),
}));
vi.mock("@/server/actions/schedule-slots-actions", () => ({
  moveSlotAction: vi.fn(),
  removeSlotAction: vi.fn(),
}));
vi.mock("@/server/actions/slot-suggest-actions", () => ({
  suggestSlotsAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  approvePlanItemsAction: vi.fn(),
}));

const { PlanCardExtras, parseReply, replyFailure, swappableOf } =
  await import("./plan-card-extras");
const { PlannedSlotCard } = await import("./planned-slot-card");
const { ContentPlanCard } =
  await import("@/components/commands/content-plan-card");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("./work-card-host");

import type { WorkCardHostInput } from "./work-card-host";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  workId: "w1",
  workTitle: "Launch week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  timezone: "Europe/Skopje",
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const norm = (html: string) =>
  html.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

function inHost(element: ReactElement, host: WorkCardHostInput = HOST) {
  return norm(
    renderToStaticMarkup(
      createElement(WorkCardHostProvider, { value: host }, element),
    ),
  );
}

function extrasHtml(card: PlanCard, host: WorkCardHostInput | null = HOST) {
  const element = createElement(PlanCardExtras, { card, commandId: "cmd-1" });
  return host ? inHost(element, host) : renderToStaticMarkup(element);
}

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    date: "2026-10-05",
    time: "10:00",
    channel: "instagram",
    formatKey: "instagram.post",
    topic: "A look at the studio",
    captionIdea: "Come see how we work.",
    ...over,
  };
}

const ALTS = [
  {
    topic: "Meet the team",
    captionIdea: "Faces behind the work.",
    from: "Story first",
  },
  { topic: "Three small wins", captionIdea: "What changed this month." },
];

function plan(over: Partial<PlanCard> = {}): PlanCard {
  return {
    kind: "content-plan-draft",
    title: "Week plan",
    timezone: "Europe/Skopje",
    state: "draft",
    items: [
      item({ alternatives: ALTS, from: "Education first" }),
      item({
        date: "2026-10-06",
        channel: "linkedin",
        formatKey: "linkedin.post",
        topic: "Why we exist",
        alternatives: [ALTS[0]!],
      }),
    ],
    ...over,
  };
}

const BLOCK_FLAG = {
  kind: "never-term" as const,
  severity: "block" as const,
  matched: "cheapest",
  rule: "Never say cheapest",
};
const WARN_FLAG = {
  kind: "absolute" as const,
  severity: "warn" as const,
  matched: "always",
};

function tagOf(html: string, label: string): string {
  const match = [
    ...html.matchAll(/<(button|a)\b[^>]*>(?:(?!<\/\1>)[\s\S])*<\/\1>/g),
  ].find((m) => m[0].includes(label));
  if (!match) throw new Error(`no button with "${label}"`);
  return match[0].slice(0, match[0].indexOf(">") + 1);
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("PlanCardExtras: guard plan-extras (W78)", () => {
  it("renders nothing without a Work host and nothing for a superseded plan", () => {
    expect(extrasHtml(plan(), null)).toBe("");
    expect(extrasHtml(plan({ state: "superseded" }))).not.toContain(
      "data-plan-extras",
    );
  });

  describe("brand check", () => {
    const blocked = plan({
      brandCheck: { state: "checked", rules: 7 },
      items: [
        item({ brandFlags: [BLOCK_FLAG], alternatives: ALTS }),
        item({ date: "2026-10-06", topic: "Fine post" }),
      ],
    });

    it("a draft with a block shows the section with the plain sentence, one line per flag and Save anyway as its single secondary action", () => {
      const html = extrasHtml(blocked);
      expect(html).toContain("Brand check");
      expect(html).toContain("data-brand-blocks");
      expect(html).toContain("These posts break a brand rule.");
      expect(html).toContain(
        "Mentions &quot;cheapest&quot; (your rule: Never say cheapest)",
      );
      expect(count(html, "Against a brand rule")).toBe(1);
      expect(count(html, "Save anyway")).toBe(1);
      const tag = tagOf(html, "Save anyway");
      expect(tag).toContain('data-emphasis="secondary"');
      expect(tag).toContain("min-h-11");
    });

    it("Save anyway is absent without a block and on a saved card", () => {
      expect(
        extrasHtml(plan({ brandCheck: { state: "checked", rules: 7 } })),
      ).not.toContain("Save anyway");
      expect(
        extrasHtml(
          plan({
            brandCheck: { state: "checked", rules: 7 },
            items: [item({ brandFlags: [WARN_FLAG] })],
          }),
        ),
      ).not.toContain("Save anyway");
      const saved = extrasHtml({ ...blocked, state: "saved" });
      expect(saved).toContain("These posts break a brand rule.");
      expect(saved).not.toContain("Save anyway");
    });

    it("warn-only flags sit in a collapsed details with a count and no button", () => {
      const one = extrasHtml(
        plan({ items: [item({ brandFlags: [WARN_FLAG] })] }),
      );
      expect(one).toContain("1 post needs a look");
      expect(one).toContain("data-brand-warn");
      expect(one).not.toMatch(/data-brand-warn[^>]*\sopen/);
      expect(one).toContain("Worth a check");
      expect(one).not.toContain("These posts break a brand rule.");
      const two = extrasHtml(
        plan({
          items: [
            item({ brandFlags: [WARN_FLAG] }),
            item({ date: "2026-10-06", brandFlags: [WARN_FLAG] }),
          ],
        }),
      );
      expect(two).toContain("2 posts need a look");
    });

    it("flag texts: preset, figure and absolute wording", () => {
      const html = extrasHtml(
        plan({
          items: [
            item({
              brandFlags: [
                {
                  kind: "preset",
                  severity: "block",
                  matched: "x",
                  rule: "No guarantees",
                },
                { kind: "figure", severity: "block", matched: "50%" },
                { kind: "absolute", severity: "block", matched: "best" },
              ],
            }),
          ],
        }),
      );
      expect(html).toContain("Breaks your rule: No guarantees");
      expect(html).toContain(
        "&quot;50%&quot; isn&#x27;t in your approved claims",
      );
      expect(html).toContain("&quot;best&quot; is an absolute claim");
    });

    it("always carries the quiet checked / unavailable line", () => {
      expect(
        extrasHtml(plan({ brandCheck: { state: "checked", rules: 12 } })),
      ).toContain("Checked against 12 brand rules.");
      expect(extrasHtml(plan({ brandCheck: { state: "skipped" } }))).toContain(
        "Brand rules couldn&#x27;t be checked.",
      );
      // An old card without the field shows no brand section at all.
      expect(extrasHtml(plan())).not.toContain("Brand check");
    });
  });

  describe("other ideas", () => {
    it("one details per post with only the first open, alternatives with their source label", () => {
      const html = extrasHtml(plan());
      expect(html).toContain("Other ideas");
      expect(count(html, "<details")).toBe(2);
      expect(count(html, "<details open")).toBe(1);
      expect(html.indexOf("<details open")).toBeLessThan(
        html.indexOf("<details", html.indexOf("<details open") + 5),
      );
      expect(html).toContain("Mon 5 Oct · Instagram");
      expect(html).toContain("Tue 6 Oct · LinkedIn");
      expect(html).toContain("Current idea");
      expect(html).toContain("Meet the team");
      expect(html).toContain("From: Story first");
      expect(html).toContain("Three small wins");
      expect(count(html, "From:")).toBe(2);
      expect(html).toContain(
        'aria-label="Other ideas for Mon 5 Oct · Instagram"',
      );
      expect(count(html, "Use this idea")).toBe(3);
      const use = tagOf(html, "Use this idea");
      expect(use).toContain("min-h-11");
      expect(use).toContain("w-full");
    });

    it("the helper line depends on whether alternatives came with the pick", () => {
      expect(extrasHtml(plan())).toContain(
        "Ideas from the other directions are ready for each post.",
      );
      const generated = plan({
        items: [
          item({ alternatives: [{ topic: "Generated", captionIdea: "c" }] }),
        ],
      });
      expect(extrasHtml(generated)).toContain(
        "One quick request covers every post. Nothing changes until you pick an idea.",
      );
      const none = plan({ items: [item(), item({ date: "2026-10-06" })] });
      const html = extrasHtml(none);
      expect(html).toContain("One quick request covers every post.");
      expect(count(html, "No other idea fits this post yet.")).toBe(2);
    });

    it("'More ideas' only below the run cap, 'Get other ideas' only without any alternative; both are quiet", () => {
      const more = extrasHtml(plan({ alternativesMeta: { runs: 1 } }));
      expect(more).toContain("More ideas");
      expect(more).not.toContain("Get other ideas");
      expect(tagOf(more, "More ideas")).toContain('data-emphasis="quiet"');
      expect(tagOf(more, "More ideas")).toContain("min-h-11");

      const capped = extrasHtml(plan({ alternativesMeta: { runs: 2 } }));
      expect(capped).not.toContain("More ideas");
      expect(capped).toContain(
        "You&#x27;ve used both idea refreshes for this plan.",
      );

      const get = extrasHtml(
        plan({ items: [item(), item({ date: "2026-10-06" })] }),
      );
      expect(get).toContain("Get other ideas");
      expect(get).not.toContain("More ideas");
      expect(tagOf(get, "Get other ideas")).toContain('data-emphasis="quiet"');
      // Never a second primary next to Save & produce.
      expect(more).not.toContain('data-emphasis="primary"');
      expect(get).not.toContain('data-emphasis="primary"');
    });

    it("a saved plan only offers slots still waiting for content, and says so for made ones", () => {
      const saved = plan({
        state: "saved",
        savedCreativeIds: ["c1", "c2"],
        slots: [
          { id: "c1", stage: "PLANNED" },
          { id: "c2", stage: "IN_REVIEW" },
        ],
      });
      const html = extrasHtml(saved);
      expect(count(html, "<details")).toBe(2);
      expect(html).toContain("Already made, so this idea can&#x27;t change.");
      expect(count(html, "<details open")).toBe(1);
      expect(count(html, "Use this idea")).toBe(2);

      const allMade = plan({
        state: "saved",
        slots: [
          { id: "c1", stage: "IN_REVIEW" },
          { id: "c2", stage: "APPROVED" },
        ],
      });
      const done = extrasHtml(allMade);
      expect(done).toContain("Nothing to change: every post is already made.");
      expect(done).not.toContain("<details");
      expect(done).not.toContain("More ideas");
      expect(done).not.toContain("Get other ideas");
    });

    it("a slot in a running production is locked", () => {
      const html = extrasHtml(
        plan({
          state: "saved",
          slots: [
            { id: "c1", stage: "PLANNED" },
            { id: "c2", stage: "PLANNED" },
          ],
          production: {
            state: "running",
            creativeIds: ["c1"],
            startedAt: "2026-10-01T10:00:00.000Z",
          },
        }),
      );
      expect(html).toContain("Already made, so this idea can&#x27;t change.");
      expect(count(html, "Use this idea")).toBe(1);
    });

    it("a removed post gets no disclosure", () => {
      const card = plan({
        items: [
          item({ alternatives: ALTS, removed: true }),
          item({ alternatives: ALTS }),
        ],
      });
      expect(count(extrasHtml(card), "<details")).toBe(1);
    });

    it("blocks the buttons with ONE visible reason in a Completed Work or while the plan is produced", () => {
      const done = extrasHtml(plan(), { ...HOST, active: false });
      expect(done).toContain("This Work is completed. Reopen it to continue.");
      expect(tagOf(done, "Use this idea")).toContain('aria-disabled="true"');
      const producing = extrasHtml(plan(), {
        ...HOST,
        producing: new Set(["cmd-1"]),
      });
      expect(producing).toContain("Making your pieces…");
      expect(count(producing, "Making your pieces…")).toBe(1);
    });
  });

  describe("pure helpers", () => {
    it("swappableOf: a draft is all non-removed posts; a saved plan only PLANNED slots outside a running claim", () => {
      const draft = plan({ items: [item(), item({ removed: true }), item()] });
      expect([...swappableOf(draft, draft.items)]).toEqual([0, 2]);
      const saved = plan({
        state: "saved",
        items: [item(), item(), item()],
        slots: [
          { id: "a", stage: "PLANNED" },
          null,
          { id: "c", stage: "FAILED" },
        ],
      });
      expect([...swappableOf(saved, saved.items)]).toEqual([0]);
    });

    it("maps every alternatives-route refusal to its copy", () => {
      expect(parseReply({ ok: true })).toEqual({ ok: true });
      expect(parseReply("x")).toBeNull();
      const code = (c: string, message?: string) =>
        replyFailure(parseReply({ ok: false, code: c, message }));
      expect(code("MOCK").message).toBe(
        "Other ideas need the live AI model, which is switched off here.",
      );
      expect(code("BUSY")).toEqual({
        code: "BUSY",
        message: "Other ideas are already being prepared.",
      });
      expect(code("LIMIT_RUNS").message).toBe(
        "You've used both idea refreshes for this plan.",
      );
      expect(code("NOTHING").message).toBe(
        "Nothing to change: every post is already made.",
      );
      expect(code("BUDGET", "Daily limit reached.").message).toBe(
        "Daily limit reached.",
      );
      expect(code("FAILED").message).toBe(
        "Couldn't get other ideas. Try again.",
      );
      expect(replyFailure(null).message).toBe(
        "Couldn't get other ideas. Try again.",
      );
    });
  });

  describe("inside the plan card", () => {
    const chat = { start: vi.fn(), startPlan: vi.fn(), runs: {} };
    const html = (card: PlanCard) =>
      inHost(
        createElement(
          ChatPackageProvider,
          { value: chat },
          createElement(ContentPlanCard, {
            card,
            commandId: "cmd-1",
            aboveActions: createElement(PlanCardExtras, {
              card,
              commandId: "cmd-1",
            }),
          }),
        ),
      );

    it("the extras sit above Save, never below it", () => {
      const out = html(
        plan({
          brandCheck: { state: "checked", rules: 3 },
          items: [item({ brandFlags: [BLOCK_FLAG], alternatives: ALTS })],
        }),
      );
      const save = out.indexOf("Save only");
      expect(save).toBeGreaterThan(0);
      expect(out.indexOf("Brand check")).toBeGreaterThan(-1);
      expect(out.indexOf("Brand check")).toBeLessThan(save);
      expect(out.indexOf("Other ideas")).toBeLessThan(save);
      expect(out.indexOf("Save anyway")).toBeLessThan(save);
      expect(out.indexOf("More ideas")).toBeLessThan(save);
    });
  });
});

describe("PlannedSlotCard: guard plan-extras (W78)", () => {
  function one(
    over: Partial<PlanItem> = {},
    card: Partial<PlanCard> = {},
  ): PlanCard {
    return {
      kind: "content-plan-draft",
      title: "One post",
      timezone: "Europe/Skopje",
      state: "saved",
      via: "idea",
      savedCreativeIds: ["c1"],
      items: [item(over)],
      slots: [{ id: "c1", stage: "PLANNED" }],
      ...card,
    };
  }
  const slotHtml = (card: PlanCard, host: WorkCardHostInput | null = HOST) => {
    const element = createElement(PlannedSlotCard, {
      card,
      commandId: "cmd-1",
    });
    return host ? inHost(element, host) : renderToStaticMarkup(element);
  };
  const row = (html: string) =>
    html.slice(
      html.indexOf("data-slot-actions"),
      html.indexOf("</div>", html.indexOf("data-slot-actions")) + 6,
    );

  it("renders nothing without a Work host", () => {
    expect(slotHtml(one(), null)).toBe("");
  });

  it("title, subtitle, when and where, the zone and the stage pill", () => {
    const html = slotHtml(one());
    expect(html).toContain("A look at the studio");
    expect(html).toContain("Added to your calendar");
    expect(html).toContain("Mon 5 Oct, 10:00 · Instagram Post");
    expect(html).toContain("Times in Europe/Skopje");
    expect(html).toContain("Needs content");
  });

  it("PLANNED: Produce is the one primary, Change time is secondary, then the Open calendar link", () => {
    const html = slotHtml(one());
    const produce = tagOf(html, "Produce");
    expect(produce).toContain('data-emphasis="primary"');
    expect(produce).toContain("min-h-11");
    expect(tagOf(html, "Change time")).toContain('data-emphasis="secondary"');
    const calendar = tagOf(html, "Open calendar");
    expect(calendar).toContain('data-emphasis="quiet"');
    expect(calendar).toContain('href="/projects/proj-1/takvim"');
    expect(html).toContain("Remove");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Review");
  });

  it("FAILED: Try again; IN_REVIEW: Review; later stages: only Open calendar", () => {
    const failed = slotHtml(
      one({}, { slots: [{ id: "c1", stage: "FAILED" }] }),
    );
    expect(tagOf(failed, "Try again")).toContain('data-emphasis="primary"');
    expect(failed).not.toContain("Change time");
    expect(failed).not.toContain(">Remove<");
    const review = slotHtml(
      one({}, { slots: [{ id: "c1", stage: "IN_REVIEW" }] }),
    );
    expect(tagOf(review, "Review")).toContain('data-emphasis="primary"');
    expect(review).toContain("Waiting for your decision");
    expect(review).not.toContain("Produce");
    for (const stage of ["APPROVED", "PUBLISHED", "PRODUCING"] as const) {
      const html = slotHtml(one({}, { slots: [{ id: "c1", stage }] }));
      expect(html).not.toContain('data-emphasis="primary"');
      expect(html).toContain("Open calendar");
      expect(html).not.toContain(">Remove<");
    }
  });

  it("the cost line shows for an image slot only", () => {
    expect(slotHtml(one())).toContain("Making it costs about $0.08.");
    const text = slotHtml(
      one({ channel: "linkedin", formatKey: "linkedin.post" }),
    );
    expect(text).not.toContain("Making it costs");
    const story = slotHtml(one({ formatKey: "instagram.story" }));
    expect(story).toContain("Making it costs about $0.11.");
  });

  it("button budget: one primary and at most three buttons in the action row", () => {
    for (const stage of [
      "PLANNED",
      "FAILED",
      "IN_REVIEW",
      "APPROVED",
    ] as const) {
      const html = slotHtml(one({}, { slots: [{ id: "c1", stage }] }));
      const actions = row(html);
      expect(count(actions, 'data-emphasis="primary"')).toBeLessThanOrEqual(1);
      expect(count(actions, "data-emphasis=")).toBeLessThanOrEqual(3);
      expect(count(html, 'data-emphasis="primary"')).toBeLessThanOrEqual(1);
    }
  });

  it("the brand chip shows when the item carries flags", () => {
    expect(slotHtml(one())).not.toContain("data-brand-chip");
    const warn = slotHtml(one({ brandFlags: [WARN_FLAG] }));
    expect(warn).toContain("Worth a check");
    const block = slotHtml(one({ brandFlags: [BLOCK_FLAG] }));
    expect(block).toContain("Against a brand rule");
  });

  it("the removed state is muted, says so and offers only Open calendar", () => {
    const html = slotHtml(one({ removed: true }));
    expect(html).toContain("Removed from your calendar.");
    expect(html).toContain("border-dashed");
    expect(tagOf(html, "Open calendar")).toContain("min-h-11");
    expect(html).not.toContain("Produce");
    expect(html).not.toContain("Change time");
    expect(html).not.toContain(">Remove<");
  });

  it("the Change time panel and the inline remove confirm start closed (no window.confirm)", () => {
    const html = slotHtml(one());
    expect(html).not.toContain("data-change-time");
    expect(html).not.toContain("Remove this from your calendar?");
    expect(html).not.toContain("Save time");
    expect(html).not.toContain("Keep it");
  });

  it("blocks Produce while the plan is being produced and everything in a Completed Work, with one reason", () => {
    const producing = slotHtml(one(), {
      ...HOST,
      producing: new Set(["cmd-1"]),
    });
    expect(tagOf(producing, "Produce")).toContain('aria-disabled="true"');
    expect(tagOf(producing, "Change time")).not.toContain("aria-disabled");
    expect(count(producing, "Making your pieces…")).toBe(1);
    const done = slotHtml(one(), { ...HOST, active: false });
    expect(tagOf(done, "Produce")).toContain('aria-disabled="true"');
    expect(tagOf(done, "Open calendar")).not.toContain("aria-disabled");
    expect(count(done, "This Work is completed. Reopen it to continue.")).toBe(
      1,
    );
  });
});
