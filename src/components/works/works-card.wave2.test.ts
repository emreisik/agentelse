import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdsInsightCardData } from "@/lib/works/ads-insight";
import type { DailyBrief } from "@/lib/works/daily-brief";
import type { MasterContentCardData } from "@/lib/works/master-content";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Every server action module answers with an inert function: static markup
// never calls them and none may reach a database.
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
vi.mock("@/server/actions/creative-variant-actions", inert);
vi.mock("@/server/actions/human-action-actions", inert);
vi.mock("@/server/actions/plan-options-actions", inert);
vi.mock("@/server/actions/plan-draft-actions", inert);
vi.mock("@/server/actions/plan-progress-actions", inert);
vi.mock("@/server/actions/work-approve-actions", inert);
vi.mock("@/server/actions/module-flow-actions", inert);
vi.mock("@/server/actions/analytics-flow-actions", inert);
vi.mock("@/server/actions/ads-flow-actions", inert);
vi.mock("@/server/actions/ads-launch-actions", inert);
vi.mock("@/server/actions/seo-flow-actions", inert);
vi.mock("@/server/actions/website-report-actions", inert);
vi.mock("@/server/actions/website-insights-actions", inert);
vi.mock("@/server/actions/measurement-health-actions", inert);
vi.mock("@/server/actions/search-opportunity-actions", inert);
vi.mock("@/server/actions/post-actions", inert);
vi.mock("@/server/actions/publish-actions", inert);
vi.mock("@/server/actions/schedule-slots-actions", inert);
vi.mock("@/server/actions/slot-suggest-actions", inert);
vi.mock("@/server/actions/slot-text-actions", inert);
vi.mock("@/server/actions/work-actions", inert);
vi.mock("@/server/actions/work-ads-actions", inert);
vi.mock("@/server/actions/master-content-actions", inert);
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { IdeaEventCard } = await import("@/components/commands/idea-event-card");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("./work-card-host");
const { WORKS_ONLY_KINDS } = await import("./works-card");
const { cardDigest, DIGEST_CHAR_LIMIT } =
  await import("@/lib/works/card-digest");

import type { WorkCardHostInput } from "./work-card-host";

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

const HOST: WorkCardHostInput = {
  projectId: "p1",
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

const norm = (value: string) =>
  value.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

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

const MASTER: MasterContentCardData = {
  kind: "master-content",
  title: "Autumn launch",
  state: "draft",
  master: { title: "Autumn launch", message: "Our new plans are here." },
  targets: [
    {
      channel: "instagram",
      formatKey: "instagram.post",
      included: true,
    },
  ],
};

const BRIEF: DailyBrief = {
  kind: "daily-brief",
  day: "2026-10-01",
  heading: "Today",
  summary: "Nothing is waiting.",
  rows: [],
  more: 0,
  primary: {
    label: "Plan today",
    action: { kind: "link", href: "/projects/p1/takvim" },
  },
};

const ADS: AdsInsightCardData = {
  kind: "ads-insight",
  state: "ok",
  asOf: "2026-10-01T08:00:00.000Z",
  currency: "TRY",
  headline: "Spring: cost per lead is 38.20 TRY",
  chips: [{ label: "CPL", value: "38.20 TRY", tone: "neutral" }],
};

const KINDS: Record<string, IdeaEventCardData> = {
  "master-content": MASTER,
  "daily-brief": BRIEF,
  "ads-insight": ADS,
};

describe("wave-2 kinds through works-card (W113)", () => {
  for (const [kind, card] of Object.entries(KINDS)) {
    it(`${kind} is a Works-only kind`, () => {
      expect(WORKS_ONLY_KINDS.has(kind)).toBe(true);
    });
    it(`${kind} renders non-empty with a host`, () => {
      expect(html(card, true).length).toBeGreaterThan(0);
    });
    it(`${kind} shows the neutral fallback without a host`, () => {
      const out = html(card, false);
      expect(out).toContain("Shown in Works");
      expect(out).toContain("Turn Works on to use it.");
    });
  }

  it("the daily brief shows its heading", () => {
    expect(html(BRIEF, true)).toContain("Today");
  });

  it("partial shapes render", () => {
    const sparseAds = {
      kind: "ads-insight",
      state: "no-data",
      chips: [],
    } as AdsInsightCardData;
    const sparseMaster = {
      ...MASTER,
      targets: [],
      brandCheck: undefined,
    } as MasterContentCardData;
    expect(html(sparseAds, true).length).toBeGreaterThan(0);
    expect(html(sparseMaster, true).length).toBeGreaterThan(0);
    expect(
      html({ ...BRIEF, next: undefined, secondary: undefined }, true).length,
    ).toBeGreaterThan(0);
  });

  it("the digests of the wave-2 kinds are bounded", () => {
    const long = "x".repeat(5000);
    for (const card of [
      { ...MASTER, master: { title: long, message: long } },
      { ...ADS, headline: long },
    ]) {
      const digest = cardDigest(card);
      expect(digest).not.toBeNull();
      expect((digest ?? "").length).toBeLessThanOrEqual(DIGEST_CHAR_LIMIT);
    }
  });
});

describe("the plan card master header", () => {
  const plan: PlanCard = {
    kind: "content-plan-draft",
    title: "Autumn launch",
    timezone: "Europe/Istanbul",
    state: "saved",
    items: [
      {
        date: "2026-10-05",
        time: "10:00",
        platform: "INSTAGRAM",
        channel: "instagram",
        formatKey: "instagram.post",
        topic: "Plans",
        captionIdea: "A caption",
      },
      {
        date: "2026-10-06",
        time: "09:30",
        platform: "LINKEDIN",
        channel: "linkedin",
        formatKey: "linkedin.post",
        topic: "Plans",
        captionIdea: "Another",
      },
    ],
    slots: [
      { id: "c0", stage: "PLANNED" },
      { id: "c1", stage: "PLANNED" },
    ],
  };

  it("appears only with card.master", () => {
    expect(html(plan, true)).not.toContain("data-master-header");
    const out = html(
      {
        ...plan,
        via: "master",
        master: { title: "A", message: "Hello there" },
      },
      true,
    );
    expect(out).toContain("data-master-header");
    expect(out).toContain("Main message");
    expect(out).toContain("Hello there");
  });

  it("clips a long message to one line", () => {
    const out = html(
      { ...plan, master: { title: "A", message: "y".repeat(600) } },
      true,
    );
    expect(out).not.toContain("y".repeat(200));
    expect(out).toContain("…");
  });

  it("is absent without a host and on a draft plan", () => {
    const withMaster = { ...plan, master: { title: "A", message: "Hello" } };
    expect(html(withMaster, false)).not.toContain("data-master-header");
    expect(html({ ...withMaster, state: "draft" }, true)).not.toContain(
      "data-master-header",
    );
  });
});

describe("the creative card variants strip", () => {
  const ready = {
    kind: "creative-ready",
    title: "Post",
    creativeId: "cr-1",
    assetId: "a0",
    mimeType: "image/png",
    status: "IN_REVIEW",
    contentFormat: "FEED_SQUARE",
    approvalId: "ap-1",
    versionNumber: 1,
  } as CreativeCardData as IdeaEventCardData;

  it("never offers Make 3 more, even on a piece of a plan", () => {
    const out = html({ ...ready, planId: "plan-1" } as IdeaEventCardData, true);
    expect(out).not.toContain("data-variants-strip");
    expect(out).not.toContain("Make 3 more");
  });

  it("does not mount a dead strip for a piece with no plan id and no alternatives", () => {
    expect(html(ready, true)).not.toContain("data-variants-strip");
  });

  it("keeps the strip (Use this one) for alternatives, but no Make 3 more without a plan id", () => {
    const out = html(
      {
        ...ready,
        alternatives: [{ assetId: "a1" }, { assetId: "a2" }],
      } as IdeaEventCardData,
      true,
    );
    expect(out).toContain("Use this one");
    expect(out).not.toContain("Make 3 more");
  });

  it("offers no third set once the cap leaves no room for a whole set", () => {
    const out = html(
      {
        ...ready,
        planId: "plan-1",
        alternatives: [1, 2, 3, 4].map((i) => ({ assetId: `x${i}` })),
      } as IdeaEventCardData,
      true,
    );
    expect(out).not.toContain("Make 3 more");
  });

  it("is absent without a host (flag-off parity)", () => {
    expect(
      html({ ...ready, planId: "plan-1" } as IdeaEventCardData, false),
    ).not.toContain("data-variants-strip");
  });

  it("is absent once approved without alternatives", () => {
    const approved = { ...ready, status: "APPROVED" } as IdeaEventCardData;
    expect(html(approved, true)).not.toContain("data-variants-strip");
  });
});

// One post, one picture: the compact slot card never offers three pictures.
describe("Make 3 visuals is retired on the compact slot card", () => {
  const one = (formatKey: string, channel: string, stage: string): PlanCard =>
    ({
      kind: "content-plan-draft",
      title: "One post",
      timezone: "Europe/Istanbul",
      state: "saved",
      via: "idea",
      items: [
        {
          date: "2026-10-05",
          time: "10:00",
          platform: "INSTAGRAM",
          channel,
          formatKey,
          topic: "Studio",
          captionIdea: "Look",
        },
      ],
      slots: [{ id: "c0", stage }],
    }) as PlanCard;

  it("a PLANNED image slot offers one Make post with the one-picture cost", () => {
    const out = html(one("instagram.post", "instagram", "PLANNED"), true);
    expect(out).not.toContain("Make 3 visuals");
    expect(out).not.toContain("Makes 3 pictures");
    expect(out).toContain("Make post");
    expect(out).toContain("Making it costs about $");
  });

  it("is not offered for a text channel or a produced slot", () => {
    expect(
      html(one("linkedin.post", "linkedin", "PLANNED"), true),
    ).not.toContain("Make 3 visuals");
    expect(
      html(one("instagram.post", "instagram", "IN_REVIEW"), true),
    ).not.toContain("Make 3 visuals");
  });

  it("is not offered without a host", () => {
    expect(
      html(one("instagram.post", "instagram", "PLANNED"), false),
    ).not.toContain("Make 3 visuals");
  });
});

describe("the creative card rating row", () => {
  const ready = {
    kind: "creative-ready",
    title: "Post",
    creativeId: "cr-1",
    assetId: "a0",
    mimeType: "image/png",
    status: "IN_REVIEW",
    contentFormat: "FEED_SQUARE",
    approvalId: "ap-1",
    versionNumber: 1,
  } as CreativeCardData as IdeaEventCardData;

  it("asks what the brand should learn from a finished post", () => {
    for (const status of ["IN_REVIEW", "APPROVED", "PUBLISHED"]) {
      const out = html({ ...ready, status } as IdeaEventCardData, true);
      expect(out, status).toContain("data-creative-rating");
      expect(out, status).toContain("Like this post");
      expect(out, status).toContain("Not quite");
    }
  });

  it("stays away from a post that is not finished or was replaced", () => {
    for (const status of ["GENERATING", "REJECTED", "ARCHIVED"]) {
      expect(
        html({ ...ready, status } as IdeaEventCardData, true),
        status,
      ).not.toContain("data-creative-rating");
    }
  });

  it("is absent without a host (flag-off parity)", () => {
    expect(html(ready, false)).not.toContain("data-creative-rating");
  });
});
