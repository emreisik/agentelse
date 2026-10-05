import { describe, expect, it } from "vitest";

import { summarizeContinuation } from "./continuation";

const at = (iso: string) => new Date(iso);
const row = (over: Record<string, unknown> = {}) => ({
  goal: "leads",
  channel: "instagram",
  formatKey: "instagram.post",
  scheduledFor: at("2026-10-12T07:00:00Z"),
  ...over,
});

describe("summarizeContinuation", () => {
  it("has nothing to inherit before there is a plan", () => {
    expect(summarizeContinuation([], "UTC", "2026-10-01")).toBeNull();
  });

  it("inherits the goal, the channels and their formats", () => {
    const result = summarizeContinuation(
      [
        row(),
        row({ formatKey: "instagram.reel" }),
        row({ formatKey: "instagram.post" }),
        row({ channel: "seo", formatKey: "seo.article" }),
      ],
      "UTC",
      "2026-10-01",
    );
    expect(result).toMatchObject({
      goal: "leads",
      formats: {
        instagram: ["instagram.post", "instagram.reel"],
        seo: ["seo.article"],
      },
    });
  });

  it("starts the next plan the day after the last planned piece", () => {
    const result = summarizeContinuation(
      [
        row({ scheduledFor: at("2026-10-05T07:00:00Z") }),
        row({ scheduledFor: at("2026-10-12T07:00:00Z") }),
      ],
      "UTC",
      "2026-10-01",
    );
    expect(result?.continueFrom).toBe("2026-10-13");
  });

  it("reads the last day in the project's timezone", () => {
    // 22:30Z on the 12th is already the 13th in Istanbul.
    const result = summarizeContinuation(
      [row({ scheduledFor: at("2026-10-12T22:30:00Z") })],
      "Europe/Istanbul",
      "2026-10-01",
    );
    expect(result?.continueFrom).toBe("2026-10-14");
  });

  it("a plan that has already ended does not dictate a start date", () => {
    const result = summarizeContinuation(
      [row({ scheduledFor: at("2026-09-20T07:00:00Z") })],
      "UTC",
      "2026-10-01",
    );
    expect(result?.continueFrom).toBeUndefined();
    // ...but its goal and channels are still the best default.
    expect(result?.goal).toBe("leads");
  });

  it("the most recent plan's goal wins, and unknown goals or formats are ignored", () => {
    const result = summarizeContinuation(
      [
        row({ goal: null }),
        row({ goal: "sales" }),
        row({ goal: "leads" }),
        row({ channel: "youtube", formatKey: "youtube.short" }),
        row({ channel: "instagram", formatKey: "instagram.thread" }),
      ],
      "UTC",
      "2026-10-01",
    );
    expect(result?.goal).toBe("sales");
    expect(Object.keys(result?.formats ?? {})).toEqual(["instagram"]);
    expect(result?.formats.instagram).toEqual(["instagram.post"]);
  });
});
