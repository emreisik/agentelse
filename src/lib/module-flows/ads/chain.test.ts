import { describe, expect, it } from "vitest";

import { approvalLinkOf, chainOf, isChainMoving } from "./chain";
import { boostAdHref, boostCreativeOf } from "./boost";

const statesOf = (chain: ReturnType<typeof chainOf>) =>
  chain.links.map((link) => link.state);

describe("chainOf", () => {
  it("a fresh launch: the campaign is on its way, the rest waits", () => {
    const chain = chainOf([null, null, null]);
    expect(statesOf(chain)).toEqual(["preparing", "waiting", "waiting"]);
    expect(isChainMoving(chain)).toBe(true);
    expect(chain.complete).toBe(false);
  });

  it("the campaign waits for approval: nothing moves until the person acts", () => {
    const chain = chainOf([
      { status: "WAITING_APPROVAL", pendingApprovalId: "ap1" },
      null,
      null,
    ]);
    expect(statesOf(chain)).toEqual(["approval", "waiting", "waiting"]);
    expect(approvalLinkOf(chain)?.approvalId).toBe("ap1");
    expect(isChainMoving(chain)).toBe(false);
  });

  it("an approved link runs; a created one hands over to the next", () => {
    expect(statesOf(chainOf([{ status: "QUEUED" }, null, null]))).toEqual([
      "running",
      "waiting",
      "waiting",
    ]);
    // Approved a moment ago: the approval is no longer pending.
    expect(
      statesOf(chainOf([{ status: "WAITING_APPROVAL" }, null, null])),
    ).toEqual(["running", "waiting", "waiting"]);
    const chain = chainOf([{ status: "COMPLETED", metaId: "c-1" }, null, null]);
    expect(statesOf(chain)).toEqual(["created", "preparing", "waiting"]);
    expect(chain.campaignId).toBe("c-1");
  });

  it("all three created: complete", () => {
    const chain = chainOf([
      { status: "COMPLETED", metaId: "c-1" },
      { status: "COMPLETED", metaId: "s-1" },
      { status: "COMPLETED", metaId: "a-1" },
    ]);
    expect(chain.complete).toBe(true);
    expect(chain.stopped).toBe(false);
    expect(isChainMoving(chain)).toBe(false);
  });

  it("a failure says why and stops the links after it", () => {
    const chain = chainOf([
      { status: "COMPLETED", metaId: "c-1" },
      {
        status: "FAILED",
        error: `Meta API error: ${"budget too low ".repeat(30)}`,
      },
      null,
    ]);
    expect(statesOf(chain)).toEqual(["created", "failed", "blocked"]);
    expect(chain.links[1]?.reason?.length).toBeLessThanOrEqual(220);
    expect(chain.stopped).toBe(true);
    expect(isChainMoving(chain)).toBe(false);
  });

  it("a declined approval is declined, a cancel without one a failure", () => {
    expect(
      statesOf(chainOf([{ status: "CANCELLED", rejected: true }, null, null])),
    ).toEqual(["declined", "blocked", "blocked"]);
    const cancelled = chainOf([{ status: "CANCELLED" }, null, null]);
    expect(cancelled.links[0]).toMatchObject({
      state: "failed",
      reason: "It was cancelled.",
    });
  });
});

describe("boost", () => {
  it("uses the post's feed picture before its Story, only once approved", () => {
    expect(
      boostCreativeOf([
        {
          id: "story",
          stage: "APPROVED",
          assetId: "a1",
          formatKey: "instagram.story",
        },
        {
          id: "feed",
          stage: "PUBLISHED",
          assetId: "a2",
          formatKey: "instagram.post",
        },
      ]),
    ).toBe("feed");
    expect(
      boostCreativeOf([
        {
          id: "story",
          stage: "APPROVED",
          assetId: "a1",
          formatKey: "instagram.story",
        },
      ]),
    ).toBe("story");
    expect(
      boostCreativeOf([
        { id: "review", stage: "IN_REVIEW", assetId: "a1" },
        { id: "noPicture", stage: "APPROVED" },
        { id: "out", stage: "APPROVED", assetId: "a2", excluded: true },
      ]),
    ).toBeNull();
  });

  it("opens the Ads Manager with the post", () => {
    expect(boostAdHref("p1", "cr 1")).toBe("/projects/p1?module=ads&post=cr+1");
  });
});
