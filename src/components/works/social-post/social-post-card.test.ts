import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CreativeCardData } from "@/types/creative-card";

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
vi.mock("@/server/actions/post-result-actions", inert);
vi.mock("@/server/actions/publish-actions", inert);
vi.mock("@/server/actions/schedule-slots-actions", inert);
vi.mock("@/server/actions/slot-suggest-actions", inert);
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { WorkCardHostProvider } = await import("../work-card-host");
const { SOCIAL_POST_COPY, SocialPostCard, offersFacebookShare } =
  await import("./social-post-card");

type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

const SHARE = `aria-label="${SOCIAL_POST_COPY.facebookShare}"`;
const CONNECT = `aria-label="${SOCIAL_POST_COPY.connect("Facebook")}"`;

function card(over: Partial<ReadyCard> = {}): ReadyCard {
  return {
    kind: "creative-ready",
    title: "Autumn menu",
    creativeId: "c1",
    assetId: "a1",
    mimeType: "image/png",
    caption: "New on the menu",
    status: "IN_REVIEW",
    platform: "INSTAGRAM",
    contentFormat: "FEED_PORTRAIT",
    approvalId: "ap1",
    ...over,
  };
}

function render(c: ReadyCard, options: { facebook?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(
      WorkCardHostProvider,
      {
        value: {
          projectId: "p1",
          workId: "w1",
          workTitle: "Launch",
          active: true,
          busy: false,
          producing: new Set<string>(),
          channels: [],
          connectedChannels:
            options.facebook === false
              ? ["instagram"]
              : ["instagram", "facebook"],
          openTab: () => undefined,
          runNextStep: () => undefined,
        },
      },
      createElement(SocialPostCard, { card: c }),
    ),
  );
}

describe("SocialPostCard: one Facebook post per post", () => {
  it("offers the cross-post on a picture whose post has no Facebook delivery", () => {
    expect(render(card())).toContain(SHARE);
    expect(
      render(card({ postId: "p1", postChannels: ["instagram"] })),
    ).toContain(SHARE);
  });

  it("hides it when the post goes to Facebook through its own delivery", () => {
    const html = render(
      card({ postId: "p1", postChannels: ["instagram", "facebook"] }),
    );
    expect(html).not.toContain(SHARE);
    expect(html).not.toContain(CONNECT);
  });

  it("keeps the Facebook delivery's own share", () => {
    expect(
      render(
        card({
          platform: "FACEBOOK",
          postId: "p1",
          postChannels: ["instagram", "facebook"],
        }),
      ),
    ).toContain(SHARE);
  });

  it("asks to connect Facebook only on a Facebook delivery", () => {
    expect(render(card(), { facebook: false })).not.toContain(SHARE);
    expect(render(card(), { facebook: false })).not.toContain(CONNECT);
    const own = render(card({ platform: "FACEBOOK" }), { facebook: false });
    expect(own).toContain(CONNECT);
    expect(own).not.toContain(SHARE);
  });
});

describe("offersFacebookShare", () => {
  it("is the rule the card follows", () => {
    expect(offersFacebookShare({ channel: "facebook", isImage: false })).toBe(
      true,
    );
    expect(offersFacebookShare({ channel: "instagram", isImage: true })).toBe(
      true,
    );
    expect(
      offersFacebookShare({
        channel: "instagram",
        isImage: true,
        postChannels: ["instagram", "facebook"],
      }),
    ).toBe(false);
    // Words only (LinkedIn, X) or a piece of no channel: nothing to cross-post.
    expect(offersFacebookShare({ channel: "linkedin", isImage: false })).toBe(
      false,
    );
    expect(offersFacebookShare({ isImage: true })).toBe(false);
  });
});
