import { describe, expect, it } from "vitest";

import { sourceOf } from "@/lib/calendar/source";

import {
  EMPTY_OUTPUT_FILTER,
  activeOutputFilters,
  countOutputs,
  filterOutputs,
  kindOf,
  matchesOutputQuery,
  phaseOf,
  sortOutputs,
  type OutputItem,
} from "./panel";

function output(overrides: Partial<OutputItem> = {}): OutputItem {
  return {
    id: "o1",
    title: "Autumn launch",
    preview: "New season, new colours",
    text: "New season, new colours",
    status: "DRAFT",
    phase: "draft",
    kind: "post",
    label: "Instagram · Post",
    source: sourceOf("instagram", null),
    assetId: null,
    version: 1,
    approvalId: null,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    scheduledFor: null,
    scheduledLocal: null,
    ...overrides,
  };
}

const draft = output();
const review = output({
  id: "o2",
  title: "Behind the scenes",
  status: "IN_REVIEW",
  phase: "review",
  kind: "reel",
  label: "TikTok · Video",
  source: sourceOf("tiktok", null),
  approvalId: "a2",
  createdAt: "2026-10-02T08:00:00.000Z",
  updatedAt: "2026-10-02T09:00:00.000Z",
});
const scheduled = output({
  id: "o3",
  title: "Weekend offer",
  status: "APPROVED",
  phase: "scheduled",
  createdAt: "2026-09-28T08:00:00.000Z",
  updatedAt: "2026-10-03T08:00:00.000Z",
  scheduledFor: "2026-10-07T07:00:00.000Z",
});
const all = [draft, review, scheduled];

describe("output phase and kind", () => {
  it("shows an approved piece with a day as scheduled", () => {
    expect(phaseOf("APPROVED", "2026-10-07T07:00:00.000Z")).toBe("scheduled");
    expect(phaseOf("APPROVED", null)).toBe("approved");
    expect(phaseOf("IN_REVIEW", null)).toBe("review");
    expect(phaseOf("PUBLISHED", null)).toBe("published");
  });

  it("derives the format from the plan glyph, the version format or the type", () => {
    expect(kindOf({ type: "SOCIAL_POST", contentFormat: null, glyph: "carousel" })).toBe("carousel");
    expect(kindOf({ type: "SOCIAL_POST", contentFormat: "STORY", glyph: null })).toBe("story");
    expect(kindOf({ type: "SOCIAL_POST", contentFormat: "SHORTS", glyph: null })).toBe("reel");
    expect(kindOf({ type: "AD_CREATIVE", contentFormat: null, glyph: "image" })).toBe("ad");
    expect(kindOf({ type: "COPY", contentFormat: null, glyph: null })).toBe("text");
    expect(kindOf({ type: "SOCIAL_POST", contentFormat: "FEED_SQUARE", glyph: null })).toBe("post");
  });
});

describe("output filters", () => {
  it("searches title, caption and platform word by word", () => {
    expect(matchesOutputQuery(draft, "season instagram")).toBe(true);
    expect(matchesOutputQuery(draft, "season tiktok")).toBe(false);
  });

  it("combines status, platform and format", () => {
    const filter = {
      ...EMPTY_OUTPUT_FILTER,
      phases: new Set(["review", "scheduled"] as const),
      sources: new Set(["instagram"]),
    };
    expect(filterOutputs(all, filter).map((i) => i.id)).toEqual(["o3"]);
    expect(filterOutputs(all, filter, "sources").map((i) => i.id)).toEqual(["o2", "o3"]);
    expect(activeOutputFilters(filter)).toBe(3);
    expect(
      filterOutputs(all, { ...EMPTY_OUTPUT_FILTER, kinds: new Set(["reel"] as const) }).map((i) => i.id),
    ).toEqual(["o2"]);
  });

  it("counts by any key", () => {
    expect(countOutputs(all, (i) => i.source.key).get("instagram")).toBe(2);
  });
});

describe("output sorting", () => {
  it("sorts by creation, last change, attention and publish date", () => {
    expect(sortOutputs(all, "newest").map((i) => i.id)).toEqual(["o2", "o1", "o3"]);
    expect(sortOutputs(all, "oldest").map((i) => i.id)).toEqual(["o3", "o1", "o2"]);
    expect(sortOutputs(all, "updated").map((i) => i.id)).toEqual(["o3", "o2", "o1"]);
    expect(sortOutputs(all, "attention").map((i) => i.id)[0]).toBe("o2");
    expect(sortOutputs(all, "date").map((i) => i.id)).toEqual(["o3", "o2", "o1"]);
  });
});
