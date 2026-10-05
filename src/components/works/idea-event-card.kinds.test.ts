import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { cardKinds, type IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Every server action module answers with an inert function, whatever the
// name: static markup never calls them and none may reach a database.
const inert = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "then" || key === "__esModule" ? undefined : () => undefined,
      },
    ),
);
vi.mock("@/server/actions/agency-work-actions", inert);
vi.mock("@/server/actions/approval-actions", inert);
vi.mock("@/server/actions/command-actions", inert);
vi.mock("@/server/actions/content-plan-actions", inert);
vi.mock("@/server/actions/creative-actions", inert);
vi.mock("@/server/actions/creative-rating-actions", inert);
vi.mock("@/server/actions/post-result-actions", inert);
vi.mock("@/server/actions/facebook-share-actions", inert);
vi.mock("@/server/actions/human-action-actions", inert);
vi.mock("@/server/actions/master-content-actions", inert);
vi.mock("@/server/actions/work-ads-actions", inert);
vi.mock("@/server/actions/creative-variant-actions", inert);
vi.mock("@/server/actions/plan-options-actions", inert);
vi.mock("@/server/actions/plan-draft-actions", inert);
vi.mock("@/server/actions/plan-progress-actions", inert);
vi.mock("@/server/actions/work-approve-actions", inert);
vi.mock("@/server/actions/publish-actions", inert);
vi.mock("@/server/actions/schedule-slots-actions", inert);
vi.mock("@/server/actions/slot-suggest-actions", inert);
vi.mock("@/server/actions/slot-text-actions", inert);
vi.mock("@/server/actions/work-actions", inert);
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { IdeaEventCard } = await import("@/components/commands/idea-event-card");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("./work-card-host");
const { WORKS_ONLY_KINDS } = await import("./works-card");

import type { WorkCardHostInput } from "./work-card-host";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

// Wave-2 tasks list the kinds they add here while their fixture lands.
const PENDING_KINDS = new Set<string>();

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  workId: "w1",
  workTitle: "Launch week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const chat = { start: vi.fn(), startPlan: vi.fn(), runs: {} };

const plan: PlanCard = {
  kind: "content-plan-draft",
  title: "Launch week",
  timezone: "Europe/Istanbul",
  state: "saved",
  items: [
    {
      date: "2026-10-05",
      time: "10:00",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      topic: "Behind the scenes",
      captionIdea: "A look at the studio",
    },
    {
      date: "2026-10-06",
      time: "09:30",
      platform: "LINKEDIN",
      channel: "linkedin",
      formatKey: "linkedin.post",
      topic: "What we learned",
      captionIdea: "Three lessons",
    },
  ],
  slots: [
    { id: "c0", stage: "PLANNED" },
    { id: "c1", stage: "PLANNED" },
  ],
};

const FIXTURES: Record<string, IdeaEventCardData> = {
  signal: { kind: "signal", title: "Signal" },
  finding: { kind: "finding", title: "Finding", statement: "A statement" },
  "insight-opportunity": { kind: "insight-opportunity", title: "Insight" },
  idea: { kind: "idea", title: "Idea", description: "An idea" },
  council: { kind: "council", verdict: "APPROVE", notes: [] },
  "work-plan": { kind: "work-plan", title: "Plan", nodes: [] },
  "task-running": { kind: "task-running", taskId: "t1", title: "Running" },
  "task-result": {
    kind: "task-result",
    taskId: "t1",
    title: "Result",
    status: "COMPLETED",
  },
  "approval-request": {
    kind: "approval-request",
    approvalId: "a1",
    taskId: "t1",
    title: "Approve this",
    riskLevel: "LOW",
  },
  "approval-decision": {
    kind: "approval-decision",
    title: "Decided",
    entityType: "Task",
    decision: "APPROVED",
  },
  "publish-result": {
    kind: "publish-result",
    taskId: "t1",
    platform: "INSTAGRAM",
    title: "Published",
    status: "COMPLETED",
  },
  "human-action-required": {
    kind: "human-action-required",
    requestId: "r1",
    title: "Needs you",
    interventionType: "LOGIN",
    inputType: "TEXT",
    status: "PENDING",
  },
  "handoff-proposed": {
    kind: "handoff-proposed",
    handoffId: "h1",
    fromDepartment: "SOCIAL_MEDIA",
    toDepartment: "CONTENT",
    reason: "Needs copy",
  },
  "ads-form-prompt": {
    kind: "ads-form-prompt",
    title: "Ads",
    formHref: "/projects/proj-1/ads",
  },
  "limit-notice": { kind: "limit-notice", reason: "daily-budget" },
  question: {
    kind: "question",
    projectId: "proj-1",
    questions: [
      {
        question: "Which one?",
        options: [{ label: "One" }, { label: "Two" }],
      },
    ],
  },
  "content-plan-summary": {
    kind: "content-plan-summary",
    ideasConsidered: 1,
    imagesGenerated: 1,
    imagesFailed: 0,
    scheduled: 1,
    pendingReview: 0,
    cappedForToday: false,
    items: [],
  },
  "content-plan-draft": plan,
  "plan-brief": {
    kind: "plan-brief",
    projectId: "proj-1",
    today: "2026-10-01",
    connections: {},
  },
  "content-package": {
    kind: "content-package",
    topic: "Launch",
    state: "draft",
    items: [],
  },
  "setup-demo-carousel": { kind: "setup-demo-carousel", items: [] },
  "guided-setup": {
    kind: "guided-setup",
    projectId: "proj-1",
    state: "open",
  },
  "channel-select": {
    kind: "channel-select",
    projectId: "proj-1",
    workId: "w1",
    options: [],
    selected: [],
  },
  "content-plan-options": {
    kind: "content-plan-options",
    title: "Three directions",
    reason: "Pick one",
    timezone: "Europe/Istanbul",
    state: "open",
    slots: [
      {
        date: "2026-10-05",
        time: "10:00",
        channel: "instagram",
        formatKey: "instagram.post",
      },
    ],
    options: [
      {
        id: "a",
        label: "Proof",
        angle: "Show the work",
        ideas: [{ topic: "Studio", captionIdea: "A look inside" }],
      },
    ],
  },
  "idea-options": {
    kind: "idea-options",
    title: "Ideas",
    reason: "Pick one",
    items: [{ ideaId: "i1", title: "Studio tour", description: "A tour" }],
  },
  "master-content": {
    kind: "master-content",
    title: "Autumn launch",
    state: "draft",
    master: { title: "Autumn launch", message: "Our new plans are here." },
    targets: [
      { channel: "instagram", formatKey: "instagram.post", included: true },
    ],
  },
  "daily-brief": {
    kind: "daily-brief",
    day: "2026-10-01",
    heading: "Today",
    summary: "Nothing is waiting.",
    rows: [],
    more: 0,
    primary: {
      label: "Plan today",
      action: { kind: "link", href: "/projects/proj-1/takvim" },
    },
  },
  "ads-insight": {
    kind: "ads-insight",
    state: "ok",
    asOf: "2026-10-01T08:00:00.000Z",
    currency: "TRY",
    headline: "Spring: cost per lead is 38.20 TRY",
    chips: [{ label: "CPL", value: "38.20 TRY", tone: "neutral" }],
  },
  "creative-loading": {
    kind: "creative-loading",
    taskId: "t1",
    title: "Making it",
  } as IdeaEventCardData,
  "creative-ready": {
    kind: "creative-ready",
    title: "Behind the scenes",
    creativeId: "cr-1",
    assetId: "asset-1",
    mimeType: "image/png",
    caption: "A look at the studio",
    copy: "Come see how we work.",
    status: "IN_REVIEW",
    assetWidth: 1080,
    assetHeight: 1350,
    platform: "INSTAGRAM",
    contentFormat: "FEED_PORTRAIT",
    approvalId: "ap-1",
    versionNumber: 1,
  } as IdeaEventCardData,
  "creative-failed": {
    kind: "creative-failed",
    taskId: "t1",
    title: "Failed",
  } as IdeaEventCardData,
  "publish-prompt": {
    kind: "publish-prompt",
    creativeId: "cr-1",
    title: "Share",
  } as IdeaEventCardData,
};

// base-ui draws its ids from a counter that depends on earlier renders.
const norm = (html: string) =>
  html.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

function html(card: IdeaEventCardData, host: boolean): string {
  const element: ReactElement = createElement(
    ChatPackageProvider,
    { value: chat },
    createElement(IdeaEventCard, { card, commandId: "cmd-1" }),
  );
  return norm(
    renderToStaticMarkup(
      host
        ? createElement(WorkCardHostProvider, { value: HOST }, element)
        : element,
    ),
  );
}

describe("every registered card kind renders", () => {
  it("has a fixture for each kind (W84)", () => {
    const missing = cardKinds().filter(
      (kind) => !(kind in FIXTURES) && !PENDING_KINDS.has(kind),
    );
    expect(missing).toEqual([]);
  });

  for (const kind of cardKinds()) {
    const card: IdeaEventCardData | undefined = FIXTURES[kind];
    if (!card) continue;
    it(`${kind} is not empty with a host`, () => {
      expect(html(card, true).length).toBeGreaterThan(0);
    });
    if (WORKS_ONLY_KINDS.has(kind)) {
      it(`${kind} shows the neutral fallback without a host`, () => {
        const out = html(card, false);
        expect(out).toContain("Shown in Works");
        expect(out).toContain("Turn Works on to use it.");
      });
    }
  }

  it("only Works-only kinds show the fallback", () => {
    expect(html({ kind: "signal", title: "Signal" }, false)).not.toContain(
      "Shown in Works",
    );
  });
});

describe("flag-off parity (W09)", () => {
  it("a saved plan with Works-only fields renders like one without", () => {
    const withWorks: PlanCard = {
      ...plan,
      via: "options",
      fromOption: { id: "a", label: "Proof" },
      brandCheck: { state: "checked", rules: 3 },
      alternativesMeta: { runs: 1 },
      items: plan.items.map((item) => ({
        ...item,
        alternatives: [{ topic: "Other", captionIdea: "Another take" }],
        brandFlags: [],
        origin: { kind: "idea" as const, ref: "i1" },
      })),
    };
    expect(html(withWorks, false)).toBe(html(plan, false));
  });

  it("a one-item plan with via is the old plan card without a host", () => {
    const one: PlanCard = {
      ...plan,
      via: "idea",
      items: plan.items.slice(0, 1),
      slots: plan.slots?.slice(0, 1),
    };
    expect(html(one, false)).toBe(html({ ...one, via: undefined }, false));
  });

  it("old stored shapes missing optional fields render", () => {
    const old = {
      kind: "content-plan-draft",
      title: "Old",
      timezone: "Europe/Istanbul",
      state: "draft",
      items: [
        { date: "2026-10-05", time: "10:00", topic: "T", captionIdea: "C" },
      ],
    } as IdeaEventCardData;
    expect(html(old, false).length).toBeGreaterThan(0);
    expect(html(old, true).length).toBeGreaterThan(0);
  });
});

describe("the plan card with a host", () => {
  it("is the social media plan pane, once, inside the card's focus target", () => {
    const out = html(plan, true);
    expect(out).toContain("data-plan-pane");
    expect(out.indexOf('data-card-id="cmd-1"')).toBeGreaterThan(-1);
    expect(out.indexOf("data-plan-pane")).toBeGreaterThan(
      out.indexOf('data-card-id="cmd-1"'),
    );
    expect(out.match(/data-plan-pane/g)).toHaveLength(1);
  });
});

describe("the plan card dispatch with a host (compact versus full)", () => {
  const one = (via?: PlanCard["via"]): PlanCard => ({
    ...plan,
    via,
    items: plan.items.slice(0, 1),
    slots: plan.slots?.slice(0, 1),
  });

  for (const via of ["idea", "generate", "suggestion", "brief"] as const) {
    it(`a one-item plan via ${via} is the compact planned-slot card`, () => {
      const out = html(one(via), true);
      expect(out).toContain("data-slot-actions");
      expect(out).not.toContain("data-plan-pane");
    });
  }

  it("a one-item plan via options stays the full plan card", () => {
    const out = html(one("options"), true);
    expect(out).toContain("data-plan-pane");
    expect(out).not.toContain("data-slot-actions");
  });

  it("a one-item plan without via stays the full plan card", () => {
    const out = html(one(undefined), true);
    expect(out).toContain("data-plan-pane");
    expect(out).not.toContain("data-slot-actions");
  });

  it("a two-item plan via idea stays the full plan card", () => {
    const out = html({ ...plan, via: "idea" }, true);
    expect(out).toContain("data-plan-pane");
    expect(out).not.toContain("data-slot-actions");
  });
});

describe("Show the newer card targets (data-card)", () => {
  const one: PlanCard = {
    ...plan,
    via: "idea",
    items: plan.items.slice(0, 1),
    slots: plan.slots?.slice(0, 1),
  };

  it("the full plan card carries data-card content-plan-draft and its command id", () => {
    const out = html(plan, true);
    expect(out).toContain('data-card="content-plan-draft"');
    expect(out).toContain('data-card-id="cmd-1"');
  });

  it("the full plan card focus target is a named group", () => {
    expect(html(plan, true)).toContain(
      '<div tabindex="-1" role="group" aria-label="Launch week" data-card="content-plan-draft"',
    );
  });

  it("the compact planned-slot card carries them too", () => {
    const out = html(one, true);
    expect(out).toContain('data-card="content-plan-draft"');
    expect(out).toContain('data-card-id="cmd-1"');
  });

  it("a removed slot card carries them too", () => {
    const removed: PlanCard = {
      ...one,
      items: one.items.map((item) => ({ ...item, removed: true })),
    };
    expect(html(removed, true)).toContain('data-card="content-plan-draft"');
  });

  it("the legacy plan card without a host has no data-card (flag-off parity)", () => {
    expect(html(plan, false)).not.toContain('data-card="content-plan-draft"');
  });
});

describe("the publish line under the creative card", () => {
  const ready = FIXTURES["creative-ready"] as Extract<
    IdeaEventCardData,
    { kind: "creative-ready" }
  >;
  const withLine = {
    ...ready,
    publishLine: { kind: "scheduled", released: false },
  } as IdeaEventCardData;

  it("is mounted inside a Work (the card hides its own publish surface)", () => {
    expect(html(withLine, true)).toContain("data-publish-line");
  });

  it("is absent without a host (flag-off parity)", () => {
    expect(html(withLine, false)).not.toContain("data-publish-line");
  });
});
