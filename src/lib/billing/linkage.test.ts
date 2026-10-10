import { describe, expect, it } from "vitest";

import { firstMonthUsed, linkedForMode, rowInMode } from "./linkage";

// The rule that keeps test-mode and live-mode Stripe data apart in one database.

const row = (
  stripeLivemode: boolean | null,
  extra: { stripeSubscriptionId?: string | null; introOffer?: boolean } = {},
) => ({
  stripeSubscriptionId: "stripeSubscriptionId" in extra
    ? extra.stripeSubscriptionId!
    : "sub_1",
  stripeLivemode,
  introOffer: extra.introOffer ?? false,
});

describe("rowInMode", () => {
  it.each([
    [null, "test", true],
    [null, "live", true],
    [false, "test", true],
    [false, "live", false],
    [true, "test", false],
    [true, "live", true],
  ] as const)("stripeLivemode %s under the %s key: %s", (mode, key, expected) => {
    expect(rowInMode({ stripeLivemode: mode }, key)).toBe(expected);
  });
});

describe("linkedForMode", () => {
  it("is never linked without a subscription id, whatever the mode", () => {
    for (const mode of [null, true, false]) {
      for (const key of ["test", "live"] as const) {
        expect(linkedForMode(row(mode, { stripeSubscriptionId: null }), key)).toBe(
          false,
        );
      }
    }
    expect(linkedForMode(null, "test")).toBe(false);
  });

  it("an old row without a mode counts for both keys; otherwise only the matching key", () => {
    expect(linkedForMode(row(null), "test")).toBe(true);
    expect(linkedForMode(row(null), "live")).toBe(true);
    expect(linkedForMode(row(false), "test")).toBe(true);
    expect(linkedForMode(row(false), "live")).toBe(false);
    expect(linkedForMode(row(true), "live")).toBe(true);
    expect(linkedForMode(row(true), "test")).toBe(false);
  });
});

describe("firstMonthUsed", () => {
  it("is false for a workspace that never paid", () => {
    expect(firstMonthUsed(null, "live")).toBe(false);
    expect(
      firstMonthUsed(row(null, { stripeSubscriptionId: null }), "live"),
    ).toBe(false);
  });

  it("a subscription or the used discount in THIS mode counts; in the other mode it does not", () => {
    // paid with a card in test mode: the live key still offers the discount
    expect(firstMonthUsed(row(false, { introOffer: true }), "live")).toBe(false);
    expect(firstMonthUsed(row(false), "live")).toBe(false);
    expect(firstMonthUsed(row(false), "test")).toBe(true);
    expect(firstMonthUsed(row(true), "live")).toBe(true);
    expect(firstMonthUsed(row(true), "test")).toBe(false);
  });

  it("the discount flag alone (the subscription link was dropped) still counts in its own mode", () => {
    expect(
      firstMonthUsed(
        row(true, { stripeSubscriptionId: null, introOffer: true }),
        "live",
      ),
    ).toBe(true);
  });
});
