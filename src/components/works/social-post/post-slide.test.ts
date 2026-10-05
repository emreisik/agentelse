import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LivePlanPiece } from "@/components/commands/package-run";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "p1" }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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
vi.mock("@/server/actions/approval-actions", inert);
vi.mock("@/server/actions/creative-actions", inert);
vi.mock("@/server/actions/creative-rating-actions", inert);
vi.mock("@/server/actions/creative-variant-actions", inert);
vi.mock("@/server/actions/facebook-share-actions", inert);
vi.mock("@/server/actions/plan-progress-actions", inert);
vi.mock("@/server/actions/post-actions", inert);
vi.mock("@/server/actions/post-result-actions", inert);
vi.mock("@/server/actions/publish-actions", inert);
vi.mock("@/server/actions/schedule-slots-actions", inert);
vi.mock("@/server/actions/slot-suggest-actions", inert);
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("../work-card-host");
const { slidePostsOf } = await import("@/lib/works/plan-posts");
const { PLAN_POSTS_COPY, PlanPostsCarousel } =
  await import("./plan-posts-carousel");
const { POST_SLIDE_COPY, PostSlide } = await import("./post-slide");

type Plan = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type Slot = NonNullable<NonNullable<Plan["slots"]>[number]>;
type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

const PLAN_ID = "plan1";

// Instagram post + Story + Facebook: three deliveries of every post.
const DELIVERIES = [
  { channel: "instagram", formatKey: "instagram.post", platform: "INSTAGRAM" },
  { channel: "instagram", formatKey: "instagram.story", platform: "INSTAGRAM" },
  { channel: "facebook", formatKey: "facebook.post", platform: "FACEBOOK" },
] as const;

// A saved plan of `posts` posts on the three channels. `slotOf` shapes each
// delivery's slot; `made` gives a delivery its finished card.
function savedPlan(
  posts: number,
  slotOf: (post: number, at: number) => Partial<Slot> = () => ({}),
  options: {
    made?: (post: number, at: number) => Partial<ReadyCard> | null;
  } = {},
): Plan {
  const items: Plan["items"] = [];
  const ids: string[] = [];
  const slots: Slot[] = [];
  const cards: ReadyCard[] = [];
  for (let post = 0; post < posts; post += 1) {
    DELIVERIES.forEach(({ channel, formatKey, platform }, at) => {
      const id = `c${post}${at}`;
      items.push({
        date: `2026-10-0${8 + post}`,
        time: "10:00",
        channel,
        formatKey,
        topic: `Idea ${post}`,
        captionIdea: `Caption ${post}`,
      });
      ids.push(id);
      slots.push({
        id,
        stage: "PLANNED",
        postId: `post${post}`,
        ...slotOf(post, at),
      });
      const made = options.made?.(post, at);
      if (made) {
        cards.push({
          kind: "creative-ready",
          title: `Idea ${post}`,
          creativeId: id,
          assetId: `asset-${id}`,
          mimeType: "image/png",
          caption: `Words of ${id}`,
          status: "IN_REVIEW",
          platform,
          contentFormat:
            formatKey === "instagram.story" ? "STORY" : "FEED_PORTRAIT",
          approvalId: `ap-${id}`,
          ...made,
        });
      }
    });
  }
  return {
    kind: "content-plan-draft",
    title: "October",
    timezone: "Europe/Istanbul",
    state: "saved",
    items,
    savedCreativeIds: ids,
    slots,
    ...(cards.length ? { posts: cards } : {}),
  };
}

function render(
  node: ReactNode,
  options: {
    producing?: string[];
    active?: boolean;
    chatPackage?: boolean;
    facebook?: boolean;
  } = {},
): string {
  const inPackage =
    options.chatPackage === false
      ? node
      : createElement(
          ChatPackageProvider,
          {
            value: {
              start: async () => ({ ok: true }),
              startPlan: async () => ({ ok: true }),
              runs: {},
            },
          },
          node,
        );
  return renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      {
        value: {
          projectId: "p1",
          projectName: "Biduniq",
          workId: "w1",
          workTitle: "Launch",
          active: options.active ?? true,
          busy: false,
          producing: new Set(options.producing ?? []),
          channels: [],
          connectedChannels: options.facebook
            ? ["instagram", "facebook"]
            : ["instagram"],
          accountLabels: { instagram: "@biduniq" },
          openTab: () => undefined,
          runNextStep: () => undefined,
        },
      },
      inPackage,
    ),
  );
}

// The first post of a plan as its slide.
function slide(plan: Plan, options: Parameters<typeof render>[1] = {}): string {
  const [post] = slidePostsOf<LivePlanPiece>(plan);
  return render(
    createElement(PostSlide, {
      post: post!,
      commandId: PLAN_ID,
      topic: "Idea 0",
    }),
    options,
  );
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
// The labels of the status pills (WsStatusPill: a dot, then the label).
const pills = (html: string) =>
  [
    ...html.matchAll(
      /rounded-full border px-2 py-0\.5[^"]*"[^>]*><span[^>]*><\/span>([^<]+)<\/span>/g,
    ),
  ].map((m) => m[1]);
const primaries = (html: string) =>
  [...html.matchAll(/data-post-primary="([a-z]+)"/g)].map((m) => m[1]);
const tabLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1]!
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

describe("PlanPostsCarousel: one slide per post", () => {
  it("shows a 3-post plan on Instagram post + Story + Facebook as 3 slides, not 9", () => {
    const html = render(
      createElement(PlanPostsCarousel, {
        card: savedPlan(3),
        commandId: PLAN_ID,
      }),
    );
    expect(count(html, /data-plan-post="/g)).toBe(3);
    expect(count(html, /data-social-post="slide"/g)).toBe(3);
    expect(count(html, /role="tablist"/g)).toBe(3);
    expect(count(html, /role="tab"/g)).toBe(9);
    expect(html).toContain(PLAN_POSTS_COPY.ready(0, 3));
  });

  it("counts a post as ready once every channel left in has content", () => {
    const html = render(
      createElement(PlanPostsCarousel, {
        card: savedPlan(3, (post, at) =>
          post === 0
            ? { stage: "IN_REVIEW" }
            : post === 1 && at === 2
              ? { stage: "PLANNED", excluded: true }
              : post === 1
                ? { stage: "APPROVED" }
                : at === 0
                  ? { stage: "IN_REVIEW" }
                  : {},
        ),
        commandId: PLAN_ID,
      }),
    );
    expect(html).toContain(PLAN_POSTS_COPY.ready(2, 3));
  });

  it("renders nothing for a plan without saved pieces", () => {
    const draft: Plan = { ...savedPlan(1), state: "draft" };
    expect(
      render(
        createElement(PlanPostsCarousel, { card: draft, commandId: PLAN_ID }),
      ),
    ).not.toContain("data-plan-posts");
  });
});

describe("PostSlide", () => {
  it("has one tab per delivery: Post, Story, Facebook, the first selected", () => {
    const html = slide(savedPlan(1));
    expect(html).toContain(`aria-label="${POST_SLIDE_COPY.tabs}"`);
    expect(tabLabels(html)).toEqual([
      "Post Needs content",
      "Story Needs content",
      "Facebook Needs content",
    ]);
    expect(count(html, /aria-selected="true"/g)).toBe(1);
    expect(count(html, /aria-selected="false"/g)).toBe(2);
    // Roving focus: only the selected tab is in the tab order.
    expect(count(html, /role="tab"[^>]*tabindex="0"/g)).toBe(1);
  });

  it("names the post's time and channels once, with one status pill", () => {
    const html = slide(savedPlan(1));
    expect(html).toContain("Thu 8 Oct, 10:00 · 2 channels");
    expect(html).toContain("@biduniq");
    expect(pills(html)).toEqual(["Needs content"]);
  });

  it("fades a left-out channel and says so", () => {
    const html = slide(
      savedPlan(1, (_post, at) => (at === 1 ? { excluded: true } : {})),
    );
    expect(tabLabels(html)[1]).toBe(`Story ${POST_SLIDE_COPY.leftOut}`);
    expect(html).toMatch(/data-excluded=""[^>]*class="[^"]*opacity-55/);
  });

  it("offers Make post while a channel still needs content", () => {
    const html = slide(savedPlan(1));
    expect(primaries(html)).toEqual(["make"]);
    expect(html).toContain(`${POST_SLIDE_COPY.make}</button>`);
  });

  it("offers Try again after a failure", () => {
    const html = slide(
      savedPlan(1, (_post, at) =>
        at === 1 ? { stage: "FAILED" } : { stage: "IN_REVIEW" },
      ),
    );
    expect(primaries(html)).toEqual(["retry"]);
    expect(html).toContain(`${POST_SLIDE_COPY.retry}</button>`);
  });

  it("shows a disabled Making… while the post is made", () => {
    const html = slide(
      savedPlan(1, (_post, at) => (at === 0 ? { stage: "PRODUCING" } : {})),
    );
    expect(primaries(html)).toEqual(["making"]);
    expect(html).toMatch(/data-post-primary="making" disabled=""/);
  });

  it("approves the whole post once every channel is made", () => {
    const html = slide(
      savedPlan(1, () => ({ stage: "IN_REVIEW" }), { made: () => ({}) }),
    );
    expect(primaries(html)).toEqual(["approve"]);
    expect(html).toContain(`${POST_SLIDE_COPY.approve}</button>`);
  });

  it("ignores a left-out channel that was never made", () => {
    const html = slide(
      savedPlan(1, (_post, at) =>
        at === 2 ? { excluded: true } : { stage: "IN_REVIEW" },
      ),
    );
    expect(primaries(html)).toEqual(["approve"]);
  });

  it("has no main button once everything is approved or out", () => {
    const html = slide(
      savedPlan(1, (_post, at) => ({
        stage: at === 0 ? "PUBLISHED" : "APPROVED",
      })),
    );
    expect(primaries(html)).toEqual([]);
  });

  it("blocks the button with its reason while the plan is being made", () => {
    const html = slide(savedPlan(1), { producing: [PLAN_ID] });
    expect(primaries(html)).toEqual(["make"]);
    expect(html).toMatch(/data-post-primary="make" disabled=""/);
    expect(html).toContain("Making your pieces…");
  });

  it("approves a plan saved before posts one channel at a time", () => {
    const html = slide(
      savedPlan(1, () => ({ stage: "IN_REVIEW", postId: undefined }), {
        made: () => ({}),
      }),
    );
    expect(primaries(html)).toEqual(["approve"]);
    expect(html).toContain(
      `${POST_SLIDE_COPY.approveOne("Instagram Post")}</button>`,
    );
    // Without a Post a channel cannot be left out.
    expect(html).not.toContain("data-leave-out");
  });

  it("never offers a Facebook cross-post: Facebook is a tab of its own", () => {
    const html = slide(
      savedPlan(1, () => ({ stage: "IN_REVIEW" }), { made: () => ({}) }),
      { facebook: true },
    );
    expect(html).not.toContain("Share on your Facebook Page");
    expect(html).not.toContain("Goes to Facebook");
  });

  it("shows the selected channel's own picture and words", () => {
    const html = slide(
      savedPlan(1, () => ({ stage: "IN_REVIEW" }), { made: () => ({}) }),
    );
    expect(html).toContain("/api/assets/asset-c00");
    expect(html).not.toContain("/api/assets/asset-c01");
    expect(html).toContain("Words of c00");
    expect(html).toMatch(/max-height:320px/);
    expect(html).toContain(`data-leave-out="leave"`);
  });

  it("makes nothing without the chat's runner", () => {
    expect(primaries(slide(savedPlan(1), { chatPackage: false }))).toEqual([]);
  });
});
