import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const graph = vi.hoisted(() => ({ metaFetch: vi.fn() }));
vi.mock("./graph", () => graph);

import { objectStorySpec, postAdSet } from "./launch-writes";

const common = {
  pageId: "9",
  imageHash: "h0",
  message: "Spring sale",
  link: "https://example.com",
  callToAction: "LEARN_MORE",
};

describe("objectStorySpec", () => {
  it("builds the single image ad as before", () => {
    expect(objectStorySpec(common)).toEqual({
      page_id: "9",
      link_data: {
        image_hash: "h0",
        link: "https://example.com",
        message: "Spring sale",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
      },
    });
  });

  it("builds a carousel in the shape the old wizard proved on live accounts", () => {
    const spec = objectStorySpec({
      ...common,
      instagramUserId: "ig1",
      cards: [
        { imageHash: "h1", link: "https://example.com/a", headline: "A" },
        { imageHash: "h2", link: "https://example.com/b", description: "B desc" },
      ],
    });
    expect(spec).toEqual({
      page_id: "9",
      instagram_user_id: "ig1",
      link_data: {
        link: "https://example.com/a",
        message: "Spring sale",
        child_attachments: [
          { link: "https://example.com/a", image_hash: "h1", name: "A" },
          { link: "https://example.com/b", image_hash: "h2", description: "B desc" },
        ],
        call_to_action: { type: "LEARN_MORE" },
      },
    });
  });

  it("builds a video ad in the shape the old wizard proved: address inside the CTA, cover by URL", () => {
    expect(
      objectStorySpec({
        ...common,
        video: { videoId: "v1", thumbnailUrl: "https://cdn.test/cover.png" },
      }),
    ).toEqual({
      page_id: "9",
      video_data: {
        video_id: "v1",
        image_url: "https://cdn.test/cover.png",
        message: "Spring sale",
        call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } },
      },
    });
  });

  it("falls back to the single picture when fewer than two cards are given", () => {
    const spec = objectStorySpec({ ...common, cards: [{ imageHash: "h1", link: "https://example.com" }] });
    expect(JSON.stringify(spec)).not.toContain("child_attachments");
  });
});

describe("postAdSet day parting", () => {
  const base = {
    adAccountId: "act_1",
    accessToken: "t",
    campaignId: "c1",
    name: "Set",
    startTime: 1,
    endTime: 2,
    optimizationGoal: "LINK_CLICKS",
    billingEvent: "IMPRESSIONS",
    targeting: { countries: ["TR"] },
    advantageAudience: 0 as const,
    status: "ACTIVE" as const,
  };
  const schedule = { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 };

  function sentBody(): URLSearchParams {
    const call = graph.metaFetch.mock.calls.at(-1)!;
    return new URLSearchParams(String(call[1].body));
  }

  it("sends pacing and the schedule with a total budget", async () => {
    graph.metaFetch.mockResolvedValue({ id: "s1" });
    await postAdSet({ ...base, lifetimeBudgetMinor: 70_000, schedule });
    const body = sentBody();
    expect(body.get("pacing_type")).toBe('["day_parting"]');
    expect(JSON.parse(body.get("adset_schedule")!)).toEqual([
      { start_minute: 540, end_minute: 1080, days: [1, 2, 3, 4, 5], timezone_type: "ADVERTISER" },
    ]);
    expect(body.get("lifetime_budget")).toBe("70000");
  });

  it("never sends a schedule with a daily budget (Meta refuses it)", async () => {
    graph.metaFetch.mockResolvedValue({ id: "s1" });
    await postAdSet({ ...base, dailyBudgetMinor: 10_000, schedule });
    expect(sentBody().get("pacing_type")).toBeNull();
    expect(sentBody().get("adset_schedule")).toBeNull();
  });
});
