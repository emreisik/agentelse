import { describe, expect, it } from "vitest";
import { cardKinds, isIdeaEventCardData } from "./idea-event-card";

const NEW_KINDS = [
  "content-plan-options",
  "idea-options",
  "master-content",
  "daily-brief",
  "ads-insight",
];

describe("idea event card kinds", () => {
  it("lists every new and creative kind, sorted", () => {
    const kinds = cardKinds();
    for (const k of [
      ...NEW_KINDS,
      "creative-loading",
      "creative-ready",
      "creative-failed",
      "publish-prompt",
      "content-plan-draft",
      "channel-select",
    ]) {
      expect(kinds).toContain(k);
    }
    expect(kinds).toEqual([...kinds].sort());
  });

  it("accepts every registered kind", () => {
    for (const kind of cardKinds()) {
      expect(isIdeaEventCardData({ kind })).toBe(true);
    }
  });

  it("accepts old stored shapes without the new optional fields", () => {
    expect(
      isIdeaEventCardData({
        kind: "content-plan-draft",
        title: "t",
        timezone: "UTC",
        state: "draft",
        items: [{ date: "2026-10-01", time: "10:00", topic: "a", captionIdea: "b" }],
      }),
    ).toBe(true);
    expect(
      isIdeaEventCardData({
        kind: "creative-ready",
        title: "t",
        creativeId: "c",
        status: "DRAFT",
      }),
    ).toBe(true);
    expect(isIdeaEventCardData({ kind: "plan-brief" })).toBe(true);
    expect(isIdeaEventCardData({ kind: "channel-select" })).toBe(true);
  });

  it("rejects unknown kinds and non-objects", () => {
    expect(isIdeaEventCardData({ kind: "nope" })).toBe(false);
    expect(isIdeaEventCardData(null)).toBe(false);
    expect(isIdeaEventCardData("idea")).toBe(false);
  });
});
