import { describe, expect, it } from "vitest";

import {
  engagementRate,
  formatCount,
  formatRate,
  isMetaPermissionError,
} from "./instagram-overview";

// What this suite proves: the engagement rate is the average likes+comments of
// the posts that show their counters, as a share of followers, and is absent
// (not zero) when it cannot be told; the permission-error check tells a missing
// scope apart from other Meta failures; counts read well in a narrow panel.

const post = (likes: number | null, comments: number | null) => ({
  id: "x",
  caption: null,
  imageUrl: null,
  permalink: null,
  timestamp: null,
  likes,
  comments,
});

describe("engagementRate", () => {
  it("averages likes and comments per post, relative to followers", () => {
    // (10+0 + 20+10) / 2 posts = 20; 20 / 1000 followers = 2%
    expect(
      engagementRate([post(10, 0), post(20, 10)], 1000),
    ).toBeCloseTo(0.02);
  });

  it("leaves out posts that hide both counters instead of counting them as zero", () => {
    expect(engagementRate([post(40, 0), post(null, null)], 1000)).toBeCloseTo(
      0.04,
    );
  });

  it("treats one hidden counter as zero for that post", () => {
    expect(engagementRate([post(null, 10)], 100)).toBeCloseTo(0.1);
  });

  it("is null without followers, without posts, or when no post shows a counter", () => {
    expect(engagementRate([post(1, 1)], 0)).toBeNull();
    expect(engagementRate([post(1, 1)], null)).toBeNull();
    expect(engagementRate([], 500)).toBeNull();
    expect(engagementRate([post(null, null)], 500)).toBeNull();
  });
});

describe("isMetaPermissionError", () => {
  it("recognises Meta's permission codes and wording", () => {
    expect(isMetaPermissionError(10, "x")).toBe(true);
    expect(isMetaPermissionError(200, "x")).toBe(true);
    expect(isMetaPermissionError(299, "x")).toBe(true);
    expect(
      isMetaPermissionError(undefined, "(#10) Application does not have permission"),
    ).toBe(true);
  });

  it("does not mistake other failures for a missing permission", () => {
    expect(isMetaPermissionError(190, "Invalid OAuth access token")).toBe(false);
    expect(isMetaPermissionError(4, "Application request limit reached")).toBe(
      false,
    );
    expect(isMetaPermissionError(undefined, "Meta API request timed out")).toBe(
      false,
    );
  });
});

describe("formatCount / formatRate", () => {
  it("groups thousands in Turkish and shortens large numbers", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1234)).toBe("1.234");
    expect(formatCount(9999)).toBe("9.999");
    expect(formatCount(12_345)).toMatch(/^12,3\s?B$/);
  });

  it("shows a dash when a number is not known", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatRate(null)).toBe("—");
  });

  it("writes a rate as a Turkish percentage", () => {
    expect(formatRate(0.0243)).toBe("%2,4");
  });
});
