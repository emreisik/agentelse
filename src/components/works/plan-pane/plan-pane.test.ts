import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/content-plan-actions", () => ({
  saveContentPlanAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-options-actions", () => ({
  swapPlanItemAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-draft-actions", () => ({
  movePlanPostAction: vi.fn(),
  removePlanPostAction: vi.fn(),
  setPlanPlatformsAction: vi.fn(),
  setPlanInstagramStoryAction: vi.fn(),
  setPlanPostSkipAction: vi.fn(),
}));
vi.mock("@/server/actions/post-actions", () => ({
  approvePostAction: vi.fn(),
  setDeliveryExcludedAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  approvePlanItemsAction: vi.fn(),
  enablePlanPublishingAction: vi.fn(),
}));
vi.mock("@/server/actions/work-approve-actions", () => ({
  approvePlansAction: vi.fn(),
}));
vi.mock("@/server/actions/schedule-slots-actions", () => ({
  moveSlotAction: vi.fn(),
  removeSlotAction: vi.fn(),
}));
vi.mock("@/server/actions/slot-text-actions", () => ({
  updateSlotTextAction: vi.fn(),
}));
vi.mock("@/server/actions/slot-suggest-actions", () => ({
  suggestSlotsAction: vi.fn(),
}));

const { ContentPlanPane } = await import("./plan-pane");
const { PostCard, IdeaSuggestion } = await import("./post-card");
const { PublishReview, PublishCalendar } = await import("./publish-review");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } =
  await import("@/components/works/work-card-host");

import type { WorkCardHostInput } from "@/components/works/work-card-host";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  projectName: "Biduniq",
  workId: "w1",
  workTitle: "Launch week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  timezone: "Europe/Istanbul",
  channels: [],
  connectedChannels: ["instagram"],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const norm = (html: string) =>
  html.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

const chat = { start: vi.fn(), startPlan: vi.fn(), runs: {} };

function paneHtml(card: PlanCard, host: WorkCardHostInput = HOST): string {
  const element = createElement(
    ChatPackageProvider,
    { value: chat },
    createElement(ContentPlanPane, { card, commandId: "cmd-1" }),
  );
  return norm(
    renderToStaticMarkup(
      createElement(WorkCardHostProvider, { value: host }, element),
    ),
  );
}

function html(element: ReactElement): string {
  return norm(renderToStaticMarkup(element));
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    date: "2026-10-05",
    time: "12:00",
    channel: "instagram",
    formatKey: "instagram.carousel",
    topic: "How the unique offer works",
    captionIdea: "Explain the idea with a simple example.",
    purpose: "Introduce the product",
    ...over,
  };
}

function draft(over: Partial<PlanCard> = {}): PlanCard {
  return {
    kind: "content-plan-draft",
    title: "Social media plan",
    timezone: "Europe/Istanbul",
    state: "draft",
    goal: "awareness",
    platforms: ["instagram", "linkedin"],
    connections: {
      instagram: { connected: true, accountLabel: "@biduniq" },
      linkedin: { connected: false },
    },
    items: [
      item(),
      item({
        date: "2026-10-07",
        time: "18:30",
        topic: "3 things to know before bidding",
        captionIdea: "Answer the questions people ask first.",
        purpose: "Answer questions",
        alternatives: [
          { topic: "Another take", captionIdea: "A different way in." },
        ],
      }),
      item({
        date: "2026-10-10",
        time: "13:00",
        formatKey: "instagram.post",
        topic: "Discover Biduniq in 3 steps",
        captionIdea: "Show the product in three short frames.",
        purpose: undefined,
      }),
    ],
    ...over,
  };
}

function saved(
  slots: NonNullable<PlanCard["slots"]>,
  over: Partial<PlanCard> = {},
): PlanCard {
  return draft({
    state: "saved",
    items: [
      item(),
      item({ channel: "linkedin", formatKey: "linkedin.post" }),
      item({
        date: "2026-10-07",
        time: "18:30",
        topic: "3 things to know before bidding",
        captionIdea: "Answer the questions people ask first.",
        purpose: "Answer questions",
      }),
      item({
        date: "2026-10-07",
        time: "18:30",
        channel: "linkedin",
        formatKey: "linkedin.post",
        topic: "3 things to know before bidding",
        captionIdea: "Answer the questions people ask first.",
        purpose: "Answer questions",
      }),
    ],
    savedCreativeIds: slots.map((slot, i) => slot?.id ?? `gone${i}`),
    slots,
    ...over,
  });
}

describe("the social media plan pane: a draft (step 1)", () => {
  const out = paneHtml(draft());

  it("is the one plan for every channel, with the brand, the days and the goal", () => {
    expect(out).toContain("data-plan-pane");
    expect(out).toContain("Content plan");
    expect(out).toContain("One plan. Every channel.");
    expect(out).toContain("Biduniq · Oct 5 – 10, 2026 · Awareness");
    expect(out).toContain("Accounts");
  });

  it("names no platform in its heading: a plan is general", () => {
    const heading = out.slice(out.indexOf("<h3"), out.indexOf("</h3>"));
    expect(heading).not.toMatch(/Instagram|TikTok|LinkedIn|X\b/);
  });

  it("shows the three steps with the first one current", () => {
    expect(out).toContain('aria-label="Plan steps"');
    expect(out).toMatch(/aria-current="step"[^>]*>[\s\S]*?Plan/);
    expect(out).toContain("Content");
    expect(out).toContain("Approve &amp; publish");
    expect(count(out, 'aria-current="step"')).toBe(1);
  });

  it("lists only connected (or chosen) channels as checkboxes: an unconnected chosen one dashed with a way to connect", () => {
    // Instagram is connected, LinkedIn is chosen but not connected; the rest stay out.
    expect(count(out, 'role="checkbox"')).toBe(2);
    expect(out).not.toContain("TikTok");
    expect(out).toMatch(
      /role="checkbox" aria-checked="true"[^>]*>[\s\S]*?Instagram/,
    );
    expect(out).toContain("2 channels selected");
    expect(out).toContain("border-dashed");
    expect(out).toContain('aria-label="Connect LinkedIn"');
    expect(out).toContain("/projects/proj-1/integrations");
    expect(out).toContain("LinkedIn isn&#x27;t connected yet.");
    // A connected channel has no connect link.
    expect(out).not.toContain('aria-label="Connect Instagram"');
  });

  it("shows each post as a card with its day, idea and state", () => {
    expect(count(out, "data-post-card")).toBe(3);
    expect(count(out, 'data-state="idea"')).toBe(3);
    expect(out).toContain("How the unique offer works");
    expect(out).toContain("Introduce the product · 2 channels");
    // No purpose: the format stands in.
    expect(out).toMatch(/Post · 3:4 · 2 channels/);
    // One card per post; its channels are counted as deliveries.
    expect(out).toContain("3 posts");
    expect(out).toContain(" · 6 channels");
    expect(out).toContain(">Mon<");
    expect(out).toContain(">05<");
  });

  it("opens the first card with the idea per channel and how it is made", () => {
    expect(out).toContain("Explain the idea with a simple example.");
    expect(out).toContain("Adaptations by channel");
    expect(out).toContain('role="tablist"');
    expect(out).toContain("Carousel · 3:4");
    expect(out).toContain("@biduniq");
    expect(out).toContain("Content approach");
    expect(out).toContain("A cover picture for the carousel");
    expect(count(out, 'aria-expanded="true"')).toBe(1);
    // The other cards stay closed.
    expect(out).not.toContain("Answer the questions people ask first.");
  });

  it("has no Other ideas area: every card carries its own New idea button", () => {
    expect(out).not.toContain("Other ideas");
    expect(out).not.toContain("data-other-ideas");
    expect(count(out, "New idea</span>")).toBe(3);
    // Nothing is suggested until the button is pressed.
    expect(out).not.toContain("data-idea-suggestion");
  });

  it("offers the list and week views, list first", () => {
    expect(out).toContain('aria-label="View"');
    expect(out).toMatch(/aria-pressed="true"[^>]*>List</);
    expect(out).toMatch(/aria-pressed="false"[^>]*>Week</);
  });

  it("ends with one primary action and the quieter one that only saves", () => {
    expect(out).toContain("3 posts · 6 channels");
    expect(out).toContain("Every idea is adapted to each channel.");
    expect(out).toContain("Prepare content");
    expect(out).toContain("Add to calendar");
    expect(out).toContain(
      "Text and format are made separately for each channel.",
    );
  });

  it("names the posts' day and time through a move control, not through a channel", () => {
    expect(out).toContain("Move: Mon 5 Oct 12:00");
  });

  it("without a choice every post goes where the plan drew it", () => {
    const legacy = paneHtml(draft({ platforms: undefined }));
    expect(legacy).toContain("3 posts");
    expect(legacy).toContain(" · 3 channels");
    expect(legacy).toContain("1 channel selected");
  });

  it("a Completed Work blocks the buttons and says why", () => {
    const done = paneHtml(draft(), { ...HOST, active: false });
    expect(done).toMatch(
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Prepare content/,
    );
    expect(done).toContain("This Work is completed. Reopen it to continue.");
  });
});

describe("the social media plan pane: once the plan is made (step 2)", () => {
  const made = saved([
    {
      id: "c0",
      stage: "IN_REVIEW",
      assetId: "asset-1",
      text: "Discover the offer in 3 steps.",
      when: "2026-10-05T12:00",
    },
    {
      id: "c1",
      stage: "IN_REVIEW",
      text: "A LinkedIn text.",
      when: "2026-10-05T12:00",
    },
    {
      id: "c2",
      stage: "IN_REVIEW",
      assetId: "asset-2",
      text: "Second post.",
      when: "2026-10-07T18:30",
    },
    {
      id: "c3",
      stage: "IN_REVIEW",
      text: "Second LinkedIn.",
      when: "2026-10-07T18:30",
    },
  ]);
  const out = paneHtml(made);

  it("is at the content step: the plan is done, no idea swap and no refresh any more", () => {
    expect(out).toContain('data-step="content"');
    expect(out).toContain('data-state="ready"');
    expect(out).toContain(">Ready<");
    expect(out).not.toContain("New idea</span>");
    // The channels are locked to what was made.
    expect(out).toMatch(/role="checkbox" aria-checked="true" disabled=""/);
  });

  it("a post's day block shows its time and moves the whole post, not one channel", () => {
    // The time sits under the day, so day and time are read (and changed) in one place.
    expect(out).toMatch(
      /aria-label="Move: Mon 5 Oct 12:00"[^>]*>[\s\S]*?>05<\/span><span[^>]*>12:00<\/span>/,
    );
    expect(out).toContain("Move: Wed 7 Oct 18:30");
    // One control per post (two posts), none per piece.
    expect(count(out, "Move: ")).toBe(2);
  });

  it("only a post that still has a piece to move offers the move", () => {
    const mixed = paneHtml(
      saved([
        { id: "c0", stage: "IN_REVIEW", text: "x", when: "2026-10-05T12:00" },
        { id: "c1", stage: "APPROVED", text: "y", when: "2026-10-05T12:00" },
        { id: "c2", stage: "PUBLISHED", text: "z", when: "2026-10-07T18:30" },
        { id: "c3", stage: "PRODUCING", when: "2026-10-07T18:30" },
      ]),
    );
    // First post: both pieces can move. Second: one is out, one is being made.
    expect(mixed).toContain("Move: Mon 5 Oct 12:00");
    expect(mixed).not.toContain("Move: Wed 7 Oct 18:30");
    // Its day block is still there, with the time, only not a control.
    expect(mixed).toMatch(/<span[^>]*>07<\/span><span[^>]*>18:30<\/span>/);
  });

  it("a completed Work moves nothing", () => {
    const done = paneHtml(made, { ...HOST, active: false });
    expect(done).not.toContain("Move: ");
    expect(done).toMatch(/<span[^>]*>05<\/span><span[^>]*>12:00<\/span>/);
  });

  it("opens the first post on its pieces: picture, words, time", () => {
    expect(out).toContain('src="/api/assets/asset-1?w=320"');
    expect(out).toContain("Instagram text");
    expect(out).toContain("Discover the offer in 3 steps.");
    expect(out).toContain("30 characters");
    expect(out).toContain("Publish time");
    // The time is the site's one time picker, wired to its label: the field with
    // the label's id shows the post's time (no native <input type="time">).
    const labelled = /for="([^"]+)"[^>]*>Publish time</.exec(out)?.[1];
    expect(labelled).toBeTruthy();
    expect(out).toMatch(new RegExp(`id="${labelled}"[^>]*>[\\s\\S]*?12:00`));
    expect(out).not.toMatch(/type="time"/);
    expect(out).toContain("Istanbul");
    expect(out).toContain("Open in calendar");
    expect(out).toContain("/projects/proj-1/takvim?creative=c0");
  });

  it("says how far the posts are and offers to plan publishing", () => {
    // A post is ready once every channel of it is made.
    expect(out).toContain("2 of 2 posts ready");
    expect(out).toContain("Review the texts and times.");
    expect(out).toMatch(/<button(?![^>]*disabled="")[^>]*>Plan publishing/);
  });

  it("a piece being made shows it, and nothing can be planned for publishing yet", () => {
    const making = paneHtml(
      saved([
        { id: "c0", stage: "PRODUCING", when: "2026-10-05T12:00" },
        { id: "c1", stage: "IN_REVIEW", text: "x", when: "2026-10-05T12:00" },
        { id: "c2", stage: "IN_REVIEW", text: "y", when: "2026-10-07T18:30" },
        { id: "c3", stage: "IN_REVIEW", text: "z", when: "2026-10-07T18:30" },
      ]),
    );
    expect(making).toContain("Being made…");
    expect(making).toContain("Making content…");
    expect(making).toContain('data-state="making"');
    expect(making).not.toContain("Plan publishing");
  });

  it("posts still to make: a Make more button carries how many", () => {
    const needs = paneHtml(
      saved([
        { id: "c0", stage: "IN_REVIEW", text: "x", when: "2026-10-05T12:00" },
        { id: "c1", stage: "PLANNED", when: "2026-10-05T12:00" },
        { id: "c2", stage: "PLANNED", when: "2026-10-07T18:30" },
        { id: "c3", stage: "FAILED", when: "2026-10-07T18:30" },
      ]),
    );
    // Both posts still have a channel to make (a tap makes whole posts).
    expect(needs).toContain("Make 2 more");
    expect(needs).toContain('data-state="needs"');
    expect(needs).toContain("Needs content");
    expect(needs).toContain("0 of 2 posts ready");
  });

  it("a piece that is approved shows its words and time as final", () => {
    const approved = paneHtml(
      saved([
        {
          id: "c0",
          stage: "APPROVED",
          assetId: "a",
          text: "Final words.",
          when: "2026-10-05T12:00",
        },
        { id: "c1", stage: "IN_REVIEW", text: "x", when: "2026-10-05T12:00" },
        { id: "c2", stage: "IN_REVIEW", text: "y", when: "2026-10-07T18:30" },
        { id: "c3", stage: "IN_REVIEW", text: "z", when: "2026-10-07T18:30" },
      ]),
    );
    expect(approved).toContain("Approved: the text and time are final.");
    expect(approved).toMatch(/<textarea[^>]*readOnly=""/);
  });
});

describe("the social media plan pane: everything decided (the last step)", () => {
  const done = saved(
    [
      { id: "c0", stage: "APPROVED", when: "2026-10-05T12:00" },
      { id: "c1", stage: "APPROVED", when: "2026-10-05T12:00" },
      { id: "c2", stage: "PUBLISHED", when: "2026-10-07T18:30" },
      { id: "c3", stage: "APPROVED", when: "2026-10-07T18:30" },
    ],
    { scheduleEnabled: false },
  );
  const out = paneHtml(done);

  it("shows the publish calendar with all three steps done and a banner", () => {
    expect(out).toContain("Publish calendar");
    expect(out).toContain("2 posts are on the calendar.");
    expect(out).toContain(
      "Each channel&#x27;s publish status is tracked on its own.",
    );
    expect(out).not.toContain('aria-current="step"');
    expect(out).toContain("Open calendar");
  });

  it("tells the truth per channel: Instagram is posted by the app, LinkedIn by you, a published one is published", () => {
    expect(out).toContain("Published");
    // LinkedIn is not connected here, so its pieces wait for it.
    expect(out).toContain("not connected");
  });

  it("offers to turn on scheduled posting when Instagram is approved and the schedule is off", () => {
    expect(out).toContain("Turn on scheduled posting");
    const on = paneHtml({ ...done, scheduleEnabled: true });
    expect(on).not.toContain("Turn on scheduled posting");
  });
});

describe("the social media plan pane: a replaced plan", () => {
  it("says so and offers no action", () => {
    const out = paneHtml(draft({ state: "superseded" }));
    expect(out).toContain("Replaced by a newer version");
    expect(out).not.toContain("Prepare content");
    expect(out).not.toContain("New idea</span>");
  });
});

describe("the social media plan pane: a new idea for a post", () => {
  // One platform: a post is one piece.
  const single = (stage: "PLANNED" | "IN_REVIEW" | "PRODUCING" | "APPROVED") =>
    draft({
      state: "saved",
      platforms: ["instagram"],
      items: [item(), item({ date: "2026-10-07", topic: "Second" })],
      savedCreativeIds: ["c0", "c1"],
      slots: [
        { id: "c0", stage, when: "2026-10-05T12:00" },
        { id: "c1", stage: "IN_REVIEW", text: "x", when: "2026-10-07T12:00" },
      ],
    });

  it("a saved post whose only piece waits for content can still change its idea", () => {
    const out = paneHtml(single("PLANNED"));
    expect(count(out, "New idea</span>")).toBe(1);
  });

  it("not once the piece is being made or made", () => {
    for (const stage of ["PRODUCING", "IN_REVIEW", "APPROVED"] as const) {
      const out = paneHtml(
        draft({
          ...single(stage),
          slots: [
            { id: "c0", stage, when: "2026-10-05T12:00" },
            { id: "c1", stage, when: "2026-10-07T12:00" },
          ],
        }),
      );
      expect(out).not.toContain("New idea</span>");
    }
  });

  it("a saved post with a piece per channel cannot (the swap is per piece)", () => {
    const out = paneHtml(
      saved([
        { id: "c0", stage: "PLANNED", when: "2026-10-05T12:00" },
        { id: "c1", stage: "PLANNED", when: "2026-10-05T12:00" },
        { id: "c2", stage: "PLANNED", when: "2026-10-07T18:30" },
        { id: "c3", stage: "PLANNED", when: "2026-10-07T18:30" },
      ]),
    );
    expect(out).not.toContain("New idea</span>");
  });

  it("a Completed Work and a replaced plan change no idea", () => {
    expect(paneHtml(draft(), { ...HOST, active: false })).not.toContain(
      "New idea</span>",
    );
    expect(paneHtml(draft({ state: "superseded" }))).not.toContain(
      "New idea</span>",
    );
  });
});

describe("PostCard and the idea suggested instead", () => {
  const card = (
    newIdea?: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ) =>
    html(
      createElement(PostCard, {
        topic: "How the unique offer works",
        idea: "Explain the idea with a simple example.",
        date: "2026-10-05",
        time: "12:00",
        tabs: [{ channel: "instagram" as const, formatKey: "instagram.post" }],
        state: "idea" as const,
        open: true,
        onToggle: () => undefined,
        step: "plan" as const,
        connected: [],
        timezone: "Europe/Istanbul",
        today: "2026-10-03",
        newIdea: newIdea && {
          onNew: () => undefined,
          onUse: () => undefined,
          onKeep: () => undefined,
          busy: false,
          disabled: false,
          ...newIdea,
        },
        ...over,
      } as never),
    );

  const suggestion = {
    topic: "Meet the team",
    captionIdea: "Faces behind the work.",
    from: "Story first",
    position: 2,
    total: 3,
  };

  it("the button is labelled, on every card that can change", () => {
    const out = card({});
    expect(out).toContain("New idea</span>");
    expect(out).not.toContain("data-idea-suggestion");
    // A card that cannot change has no button.
    expect(card()).not.toContain("New idea</span>");
  });

  it("shows the suggestion under the current idea, with where it stands and three choices", () => {
    const out = card({ suggestion });
    expect(out).toContain("data-idea-suggestion");
    expect(out).toContain("Suggested idea");
    expect(out).toContain("Meet the team");
    expect(out).toContain("Faces behind the work.");
    expect(out).toContain("From: Story first");
    expect(out).toContain("2 of 3");
    expect(out).toContain("Use this idea");
    expect(out).toContain("Another idea");
    expect(out).toContain("Keep current");
    // The post's own idea stays until the suggestion is approved.
    expect(out.indexOf("Explain the idea with a simple example.")).toBeLessThan(
      out.indexOf("data-idea-suggestion"),
    );
    expect(out.indexOf("data-idea-suggestion")).toBeLessThan(
      out.indexOf("Adaptations by channel"),
    );
    // Not the post's title: it is still the current one.
    expect(out.match(/How the unique offer works/g)).toHaveLength(1);
  });

  it("while ideas are being asked for it says so and nothing can be used yet", () => {
    const out = card({ busy: true });
    expect(out).toContain("data-idea-suggestion");
    expect(out).toContain("Finding ideas…");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Use this idea/);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Another idea/);
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Keep current/);
  });

  it("another card is being asked for: this card's choices wait", () => {
    const out = card({ suggestion, disabled: true });
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Use this idea/);
    expect(out).toContain('aria-disabled="true"');
  });

  it("IdeaSuggestion on its own: no origin line when the idea came from nowhere", () => {
    const { from: _from, ...plain } = suggestion;
    const out = html(
      createElement(IdeaSuggestion, {
        newIdea: {
          onNew: () => undefined,
          onUse: () => undefined,
          onKeep: () => undefined,
          busy: false,
          disabled: false,
          suggestion: plain,
        },
      }),
    );
    expect(out).toContain("Meet the team");
    expect(out).not.toContain("From:");
  });
});

describe("PublishReview and PublishCalendar", () => {
  const posts = [
    {
      key: "a",
      date: "2026-10-05",
      topic: "How the unique offer works",
      pieces: [
        {
          channel: "instagram" as const,
          stage: "IN_REVIEW" as const,
          when: "2026-10-05T12:00",
          mode: "auto" as const,
          connected: true,
        },
        {
          channel: "linkedin" as const,
          stage: "IN_REVIEW" as const,
          when: "2026-10-05T09:30",
          mode: "manual" as const,
          connected: true,
        },
        {
          channel: "tiktok" as const,
          stage: "PLANNED" as const,
          when: "2026-10-05T09:30",
          mode: "manual" as const,
          connected: false,
        },
      ],
    },
  ];
  const review = (over: Record<string, unknown> = {}) =>
    html(
      createElement(PublishReview, {
        posts,
        toApprove: 1,
        timezone: "Europe/Istanbul",
        scheduleEnabled: true,
        heldChannels: [],
        approved: false,
        onApprovedChange: () => undefined,
        onEdit: () => undefined,
        ...over,
      }),
    );

  it("lists each post with its channels, times and what really happens", () => {
    const out = review();
    expect(out).toContain("Review the publish plan");
    expect(out).toContain("1 post · 3 channels · Istanbul time");
    expect(out).toContain("How the unique offer works");
    expect(out).toContain("12:00 · posts itself");
    expect(out).toContain("09:30 · you post it");
    // A piece not made yet has no time and says so.
    expect(out).toContain("TikTok</span> · Not made yet");
    expect(out).toContain("Edit");
  });

  it("an Instagram piece is not claimed to post itself while scheduled posting is off", () => {
    expect(review({ scheduleEnabled: false })).toContain(
      "turn on scheduled posting",
    );
    expect(review({ scheduleEnabled: false })).not.toContain("posts itself");
  });

  it("asks for the approval in one sentence and holds the channels that are not connected", () => {
    const out = review({ heldChannels: ["linkedin"] });
    expect(out).toContain(
      "I approve this post for the selected channels and times.",
    );
    expect(review({ toApprove: 3 })).toContain(
      "I approve these 3 posts for the selected channels and times.",
    );
    expect(out).toContain(
      "LinkedIn: Posts for a channel that isn&#x27;t connected stay on the calendar until it is.",
    );
    expect(out).toContain('type="checkbox"');
    expect(review({ approved: true })).toContain("checked");
    expect(review({ toApprove: 0 })).toContain('disabled=""');
  });

  it("the calendar says what each piece is now", () => {
    const out = html(
      createElement(PublishCalendar, {
        posts: posts.map((post) => ({
          ...post,
          pieces: post.pieces.map((piece) => ({
            ...piece,
            stage: "APPROVED" as const,
          })),
        })),
        scheduleEnabled: true,
        instagramNeedsSchedule: false,
        scheduleBusy: false,
        onTurnOnSchedule: () => undefined,
        onSeeContent: () => undefined,
      }),
    );
    expect(out).toContain("Scheduled");
    expect(out).toContain("you post it");
    expect(out).toContain("not connected");
    expect(out).toContain("See content");
  });
});

// ---- posts: one idea, its channels as deliveries --------------------------------

type Slot = NonNullable<PlanCard["slots"]>[number];

describe("the social media plan pane: a channel left out of one draft post", () => {
  // Instagram + Facebook with the Story switch on: three deliveries per post.
  const host: WorkCardHostInput = {
    ...HOST,
    connectedChannels: ["instagram", "facebook"],
  };
  const plan = (first: Partial<PlanItem> = {}) =>
    draft({
      platforms: ["instagram", "facebook"],
      instagramStory: true,
      connections: {
        instagram: { connected: true, accountLabel: "@biduniq" },
        facebook: { connected: true, accountLabel: "Biduniq Page" },
      },
      items: [
        item({ formatKey: "instagram.post", ...first }),
        item({
          date: "2026-10-07",
          time: "18:30",
          topic: "Second post",
          formatKey: "instagram.post",
          purpose: undefined,
        }),
      ],
    });

  it("shows every delivery of the post as a tab, each one it can leave out", () => {
    const out = paneHtml(plan(), host);
    expect(out).toContain("2 posts · 6 channels");
    expect(out).toContain("Introduce the product · 3 channels");
    expect(out).toContain("Instagram Story");
    expect(out).toContain('data-leave-out="leave"');
    expect(out).toContain('aria-label="Leave Instagram out of this post"');
  });

  it("a left-out delivery stays as a faded tab to take back in, and is not counted", () => {
    const out = paneHtml(plan({ skipFormats: ["instagram.post"] }), host);
    expect(out).toContain("2 posts · 5 channels");
    expect(out).toContain("Introduce the product · 2 channels");
    // The other post keeps all three.
    expect(out).toContain("Post · 3:4 · 3 channels");
    expect(out).toMatch(/data-left-out=""[^>]*opacity:0\.45/);
    expect(out).toContain('aria-label="Include Instagram in this post"');
    expect(out).toContain(
      "Left out of this post: it isn&#x27;t made or posted.",
    );
  });

  it("a Completed Work leaves nothing out", () => {
    const out = paneHtml(plan(), { ...host, active: false });
    expect(out).not.toContain("data-leave-out");
  });
});

describe("the social media plan pane: a made post and its one Approve", () => {
  // The saved fixture's two posts, each a Post with Instagram and LinkedIn.
  const firstLinkedIn: Slot = {
    id: "c1",
    stage: "IN_REVIEW",
    text: "A LinkedIn text.",
    when: "2026-10-05T12:00",
    postId: "p1",
  };
  const posted = (linkedIn: Slot = firstLinkedIn) =>
    saved([
      {
        id: "c0",
        stage: "IN_REVIEW",
        assetId: "asset-1",
        text: "Discover the offer in 3 steps.",
        when: "2026-10-05T12:00",
        postId: "p1",
      },
      linkedIn,
      { id: "c2", stage: "PLANNED", when: "2026-10-07T18:30", postId: "p2" },
      { id: "c3", stage: "PLANNED", when: "2026-10-07T18:30", postId: "p2" },
    ]);

  it("a post whose channels are all made has one Approve post", () => {
    const out = paneHtml(posted());
    expect(count(out, "data-approve-post")).toBe(1);
    expect(out).toContain("Approve post");
    expect(out).toContain("All 2 channels are ready.");
    expect(out).toContain("1 of 2 posts ready");
  });

  it("not while a channel of it still needs content, nor for a plan saved before posts", () => {
    const needs = paneHtml(
      posted({ ...firstLinkedIn, stage: "PLANNED", text: undefined }),
    );
    expect(needs).not.toContain("Approve post");
    // An older plan is approved on the last step, as before.
    const older = paneHtml(
      saved([
        { id: "c0", stage: "IN_REVIEW", text: "x", when: "2026-10-05T12:00" },
        { id: "c1", stage: "IN_REVIEW", text: "y", when: "2026-10-05T12:00" },
        { id: "c2", stage: "IN_REVIEW", text: "z", when: "2026-10-07T18:30" },
        { id: "c3", stage: "IN_REVIEW", text: "w", when: "2026-10-07T18:30" },
      ]),
    );
    expect(older).not.toContain("Approve post");
    expect(older).not.toContain("data-leave-out");
  });

  it("each channel of a made post has a quiet Leave out", () => {
    const out = paneHtml(posted());
    expect(out).toContain('data-leave-out="leave"');
    expect(out).toContain('aria-label="Leave Instagram out of this post"');
  });

  it("a channel left out does not hold the post, nor count", () => {
    const out = paneHtml(
      posted({ ...firstLinkedIn, stage: "PLANNED", excluded: true }),
    );
    expect(out).toContain("Approve post");
    expect(out).toContain("Its channel is ready.");
    expect(out).toContain("Introduce the product · 1 channel");
    expect(out).toContain("2 posts</span> · 3 channels");
    expect(out).toMatch(/data-left-out=""[^>]*opacity:0\.45/);
  });

  it("a Completed Work approves and leaves out nothing", () => {
    const out = paneHtml(posted(), { ...HOST, active: false });
    expect(out).not.toContain("Approve post");
    expect(out).not.toContain("data-leave-out");
  });

  it("the publish calendar lists an Instagram post and its Story apart, and a left-out channel not at all", () => {
    const out = paneHtml(
      saved(
        [
          {
            id: "c0",
            stage: "APPROVED",
            when: "2026-10-05T12:00",
            postId: "p1",
          },
          {
            id: "c1",
            stage: "APPROVED",
            when: "2026-10-05T12:00",
            postId: "p1",
          },
          {
            id: "c2",
            stage: "APPROVED",
            when: "2026-10-07T18:30",
            postId: "p2",
          },
          {
            id: "c3",
            stage: "PLANNED",
            when: "2026-10-07T18:30",
            postId: "p2",
            excluded: true,
          },
        ],
        {
          platforms: ["instagram"],
          instagramStory: true,
          items: [
            item({ formatKey: "instagram.post" }),
            item({ formatKey: "instagram.story" }),
            item({
              date: "2026-10-07",
              time: "18:30",
              topic: "Second post",
              formatKey: "instagram.post",
            }),
            item({
              date: "2026-10-07",
              time: "18:30",
              topic: "Second post",
              formatKey: "instagram.story",
            }),
          ],
        },
      ),
    );
    // The left-out Story is no piece of the plan: everything left is decided.
    expect(out).toContain("Publish calendar");
    expect(out).toContain("2 posts are on the calendar.");
    const rows = out.slice(out.indexOf("Publish calendar"));
    expect(count(rows, ">Instagram Story</span>")).toBe(1);
    expect(count(rows, ">Instagram</span>")).toBe(2);
  });
});

describe("PostCard: a post's channels and its one Approve", () => {
  const made = (over: Record<string, unknown> = {}) => ({
    index: 0,
    channel: "instagram" as const,
    formatKey: "instagram.post",
    creativeId: "c0",
    postId: "p1",
    stage: "IN_REVIEW" as const,
    text: "Hello.",
    when: "2026-10-05T12:00",
    ...over,
  });
  const tabs = (first: Record<string, unknown> = {}) => [
    {
      channel: "instagram" as const,
      formatKey: "instagram.post",
      piece: made(),
      ...first,
    },
    {
      channel: "instagram" as const,
      formatKey: "instagram.story",
      piece: made({ index: 1, creativeId: "c1", formatKey: "instagram.story" }),
    },
  ];
  const card = (over: Record<string, unknown> = {}) =>
    html(
      createElement(PostCard, {
        topic: "How the unique offer works",
        idea: "Explain the idea with a simple example.",
        date: "2026-10-05",
        time: "12:00",
        tabs: tabs(),
        state: "ready",
        open: true,
        onToggle: () => undefined,
        step: "content",
        connected: ["instagram"],
        timezone: "Europe/Istanbul",
        today: "2026-10-03",
        onLeaveOut: () => undefined,
        ...over,
      } as never),
    );

  it("a channel can be left out of the post, quietly, while another stays", () => {
    const out = card();
    expect(out).toContain('data-leave-out="leave"');
    expect(out).toContain('aria-label="Leave Instagram out of this post"');
    expect(out).toContain(">Leave out</button>");
    expect(out).toContain("· 2 channels</span>");
    expect(out).toContain("Instagram Story");
  });

  it("a left-out channel is faded, says so, and can be taken back in", () => {
    const out = card({ tabs: tabs({ leftOut: true }) });
    expect(out).toMatch(/data-left-out=""[^>]*opacity:0\.45/);
    expect(out).toContain("Left out</span>");
    expect(out).toContain(
      "Left out of this post: it isn&#x27;t made or posted.",
    );
    expect(out).toContain('aria-label="Include Instagram in this post"');
    expect(out).toContain(">Include</button>");
    expect(out).toContain("· 1 channel</span>");
    // Its words are not offered for editing.
    expect(out).not.toContain("<textarea");
  });

  it("no toggle on the last channel left, on a posted one, or where nothing can change", () => {
    expect(card({ tabs: tabs().slice(0, 1) })).not.toContain("data-leave-out");
    expect(
      card({ tabs: tabs({ piece: made({ stage: "PUBLISHED" }) }) }),
    ).not.toContain("data-leave-out");
    expect(card({ onLeaveOut: undefined })).not.toContain("data-leave-out");
  });

  it("one Approve for the whole post, busy while it runs", () => {
    const out = card({ approve: { onApprove: () => undefined, busy: false } });
    expect(out).toContain("data-approve-post");
    expect(out).toContain("All 2 channels are ready.");
    expect(out).toMatch(
      /<button(?![^>]*disabled="")[^>]*>(?:(?!<\/button>)[\s\S])*Approve post<\/button>/,
    );
    const busy = card({ approve: { onApprove: () => undefined, busy: true } });
    expect(busy).toMatch(
      /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Approving…<\/button>/,
    );
    expect(card()).not.toContain("data-approve-post");
  });
});
