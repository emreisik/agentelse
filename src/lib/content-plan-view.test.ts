import { describe, expect, it } from "vitest";

import {
  STAGE_LABEL,
  buildWeeks,
  countStages,
  effectivePublish,
  mondayOf,
  planChannels,
  publishSummary,
  stageSummary,
  toViewItems,
} from "./content-plan-view";
import { resolveFormat } from "./content-channels";

const items = [
  {
    date: "2026-09-29",
    time: "10:00",
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.post",
    topic: "a",
    captionIdea: "a",
  },
  {
    date: "2026-10-02",
    time: "10:00",
    platform: "INSTAGRAM",
    channel: "instagram",
    formatKey: "instagram.reel",
    topic: "b",
    captionIdea: "b",
  },
  {
    date: "2026-10-06",
    time: "10:00",
    channel: "seo",
    formatKey: "seo.article",
    topic: "c",
    captionIdea: "c",
  },
  {
    date: "2026-10-07",
    time: "10:00",
    channel: "ads",
    formatKey: "ads.campaign",
    topic: "d",
    captionIdea: "d",
  },
];

describe("effectivePublish", () => {
  const post = resolveFormat("instagram", "instagram.post")!;
  const reel = resolveFormat("instagram", "instagram.reel")!;

  it("auto-publishes only when the channel is connected", () => {
    expect(
      effectivePublish("instagram", post, { instagram: { connected: true } }),
    ).toBe("auto");
    expect(
      effectivePublish("instagram", post, { instagram: { connected: false } }),
    ).toBe("manual");
  });

  it("stays unknown on plans without connection status, and honours fixed modes", () => {
    expect(effectivePublish("instagram", post, undefined)).toBeUndefined();
    expect(
      effectivePublish("instagram", reel, { instagram: { connected: true } }),
    ).toBe("manual");
  });
});

describe("plan view model", () => {
  const view = toViewItems(items, {
    instagram: { connected: true },
    ads: { connected: false },
  });

  it("resolves channels and publish modes, summarizing them", () => {
    expect(view.map((v) => v.publish)).toEqual([
      "auto",
      "manual",
      "manual",
      "approval",
    ]);
    expect(publishSummary(view)).toEqual({ auto: 1, manual: 2, approval: 1 });
    expect(planChannels(view)).toEqual(["instagram", "seo", "ads"]);
  });

  it("keeps an unknown platform visible without a channel", () => {
    const [facebook] = toViewItems(
      [{ date: "2026-10-01", time: "10:00", platform: "FACEBOOK", topic: "t", captionIdea: "c" }],
      undefined,
    );
    expect(facebook).toMatchObject({ platform: "FACEBOOK", channel: undefined });
  });
});

describe("weeks", () => {
  it("finds the Monday of any day", () => {
    expect(mondayOf("2026-09-29")).toBe("2026-09-28"); // Tuesday
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // Sunday
  });

  it("builds Monday-first weeks across the whole plan, empty weeks included", () => {
    const weeks = buildWeeks(items);
    expect(weeks.map((w) => w.start)).toEqual(["2026-09-28", "2026-10-05"]);
    expect(weeks[0]!.days).toHaveLength(7);
    expect(weeks[0]!.days[6]).toBe("2026-10-04");

    const gap = buildWeeks([{ date: "2026-09-29" }, { date: "2026-10-14" }]);
    expect(gap.map((w) => w.start)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(buildWeeks([])).toEqual([]);
  });
});

describe("saved plan progress", () => {
  const slot = (stage: import("./journey").PlanItemStage) => ({
    id: stage,
    stage,
  });

  it("attaches each slot to the item at the same index", () => {
    const view = toViewItems(items, undefined, [slot("IN_REVIEW"), undefined]);
    expect(view[0]?.slot).toEqual({ id: "IN_REVIEW", stage: "IN_REVIEW" });
    expect(view[1]?.slot).toBeUndefined();
    // A plan that is not saved yet has no slots at all.
    expect(toViewItems(items, undefined).every((item) => !item.slot)).toBe(true);
  });

  it("counts stages and skips items with no slot", () => {
    const counts = countStages([
      { slot: slot("IN_REVIEW") },
      { slot: slot("IN_REVIEW") },
      { slot: slot("PLANNED") },
      {},
    ]);
    expect(counts.IN_REVIEW).toBe(2);
    expect(counts.PLANNED).toBe(1);
    expect(counts.PUBLISHED).toBe(0);
  });

  it("summarises the stages in the order the client cares about", () => {
    expect(
      stageSummary([
        { slot: slot("PLANNED") },
        { slot: slot("PLANNED") },
        { slot: slot("IN_REVIEW") },
        { slot: slot("APPROVED") },
        { slot: slot("FAILED") },
      ]),
    ).toBe("1 failed · 1 in review · 2 need content · 1 approved");
    expect(stageSummary([{}])).toBe("");
  });

  it("names every stage", () => {
    expect(Object.values(STAGE_LABEL).every((label) => label.length > 0)).toBe(
      true,
    );
  });
});
