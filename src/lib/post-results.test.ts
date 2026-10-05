import { describe, expect, it } from "vitest";

import {
  compareToRecent,
  engagementOf,
  isPostVerdict,
  mergeIdeaResult,
  postResultInsight,
} from "./post-results";

// What this suite proves: the comparison next to a post's live numbers uses the
// median of the other recent posts (one viral post does not skew it) and says
// nothing with too little to compare; the lesson a verdict leaves carries the
// owner's judgment and never a number; and an idea's results merge per post.

const stat = (likes: number | null, comments: number | null = 0) => ({
  likes,
  comments,
});

describe("compareToRecent", () => {
  const others = [stat(10, 2), stat(20, 0), stat(30, 0), stat(500, 40)];

  it("compares with the median of the other posts, not the mean", () => {
    // median of [12, 20, 30, 540] = 25
    expect(compareToRecent(stat(40), others)).toBe("above");
    expect(compareToRecent(stat(25), others)).toBe("about");
    expect(compareToRecent(stat(10), others)).toBe("below");
  });

  it("says nothing without numbers or with fewer than three posts to compare", () => {
    expect(compareToRecent(stat(null, null), others)).toBeNull();
    expect(compareToRecent(stat(40), [stat(1), stat(2)])).toBeNull();
    expect(
      compareToRecent(stat(40), [stat(null, null), stat(1), stat(2)]),
    ).toBeNull();
  });

  it("handles a zero median", () => {
    const zeros = [stat(0), stat(0), stat(0)];
    expect(compareToRecent(stat(3), zeros)).toBe("above");
    expect(compareToRecent(stat(0), zeros)).toBe("about");
  });

  it("counts likes and comments together", () => {
    expect(engagementOf(stat(3, 4))).toBe(7);
    expect(engagementOf(stat(null, 4))).toBe(4);
    expect(engagementOf(stat(null, null))).toBeNull();
  });
});

describe("postResultInsight", () => {
  it("states the owner's verdict on the post, with no number from its stats", () => {
    const worked = postResultInsight({
      verdict: "WORKED",
      name: '"Clinic tour" (instagram.post)',
    });
    expect(worked).toContain('"Clinic tour" (instagram.post) worked');
    expect(worked).toContain("Make more posts like it.");

    const didnt = postResultInsight({
      verdict: "DIDNT",
      name: '"Clinic tour" (instagram.post)',
      note: "  too   salesy ",
    });
    expect(didnt).toContain("did not work");
    expect(didnt).toContain("Client's note: too salesy");
  });

  it("caps the note", () => {
    const text = postResultInsight({
      verdict: "WORKED",
      name: '"A"',
      note: "x".repeat(500),
    });
    expect(text.length).toBeLessThan(400);
  });
});

describe("isPostVerdict", () => {
  it("accepts only the two verdicts", () => {
    expect(isPostVerdict("WORKED")).toBe(true);
    expect(isPostVerdict("DIDNT")).toBe(true);
    expect(isPostVerdict("LIKE")).toBe(false);
    expect(isPostVerdict(undefined)).toBe(false);
  });
});

describe("mergeIdeaResult", () => {
  it("keeps other keys, replaces a post's earlier verdict and tallies", () => {
    let scores = mergeIdeaResult(
      { council: 0.8 },
      "c1",
      "WORKED",
      "2026-10-05T10:00:00.000Z",
    );
    scores = mergeIdeaResult(scores, "c2", "DIDNT", "2026-10-06T10:00:00.000Z");
    scores = mergeIdeaResult(scores, "c1", "DIDNT", "2026-10-07T10:00:00.000Z");
    expect(scores).toEqual({
      council: 0.8,
      results: {
        posts: {
          c1: { verdict: "DIDNT", at: "2026-10-07T10:00:00.000Z" },
          c2: { verdict: "DIDNT", at: "2026-10-06T10:00:00.000Z" },
        },
        worked: 0,
        didNotWork: 2,
      },
    });
  });

  it("starts from nothing on an empty or odd value, and drops broken entries", () => {
    expect(mergeIdeaResult(null, "c1", "WORKED", "t")).toEqual({
      results: {
        posts: { c1: { verdict: "WORKED", at: "t" } },
        worked: 1,
        didNotWork: 0,
      },
    });
    expect(
      mergeIdeaResult(
        { results: { posts: { bad: { verdict: "MAYBE", at: 1 } } } },
        "c1",
        "WORKED",
        "t",
      ),
    ).toEqual({
      results: {
        posts: { c1: { verdict: "WORKED", at: "t" } },
        worked: 1,
        didNotWork: 0,
      },
    });
  });
});
