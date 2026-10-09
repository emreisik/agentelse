import { describe, expect, it } from "vitest";

import { bannerFor } from "./banner";
import { pickerModeFor, type PickerSubscription } from "./picker-mode";

const paying = (
  overrides: Partial<PickerSubscription> = {},
): PickerSubscription => ({
  planKey: "growth",
  interval: "MONTH",
  status: "ACTIVE",
  paidThrough: "2026-12-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  pendingPlanKey: null,
  stripeLinked: true,
  introOffer: false,
  ...overrides,
});

describe("pickerModeFor", () => {
  it("is browse-only while payments are closed, whoever looks", () => {
    expect(
      pickerModeFor({
        paymentsOpen: false,
        canManage: true,
        subscription: paying(),
      }),
    ).toEqual({ kind: "browse" });
  });

  it("only owners and admins can press the buttons", () => {
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: false,
        subscription: paying(),
      }),
    ).toEqual({ kind: "blocked", reason: "not-manager", interval: "month" });
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: false,
        subscription: null,
      }),
    ).toEqual({ kind: "blocked", reason: "not-manager", interval: undefined });
  });

  it("a workspace without a paying subscription subscribes, and gets the discount only if it never paid", () => {
    for (const subscription of [
      null,
      paying({
        stripeLinked: false,
        status: "LEGACY",
        planKey: null,
        interval: null,
      }),
      paying({ stripeLinked: false, status: "TRIALING" }),
    ]) {
      expect(
        pickerModeFor({ paymentsOpen: true, canManage: true, subscription }),
      ).toEqual({ kind: "subscribe", firstMonthAvailable: true });
    }
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: true,
        subscription: paying({
          stripeLinked: false,
          status: "CANCELED",
          introOffer: true,
        }),
      }),
    ).toEqual({ kind: "subscribe", firstMonthAvailable: false });
    // A workspace that paid before (canceled) subscribes again at the normal price.
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: true,
        subscription: paying({ status: "CANCELED" }),
      }),
    ).toEqual({ kind: "subscribe", firstMonthAvailable: false });
  });

  it("an active subscription switches plans within its interval and shows a scheduled switch", () => {
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: true,
        subscription: paying({ interval: "YEAR", pendingPlanKey: "starter" }),
      }),
    ).toEqual({
      kind: "change",
      planKey: "growth",
      interval: "year",
      pendingPlanKey: "starter",
      renewsOn: "2026-12-01T00:00:00.000Z",
    });
  });

  it("blocks plan changes while a payment is failing or the subscription is set to end", () => {
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: true,
        subscription: paying({ status: "PAST_DUE" }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "past-due" });
    expect(
      pickerModeFor({
        paymentsOpen: true,
        canManage: true,
        subscription: paying({ cancelAtPeriodEnd: true }),
      }),
    ).toMatchObject({ kind: "blocked", reason: "ending" });
  });
});

describe("bannerFor", () => {
  it("says what happened after Stripe, and only from fixed text", () => {
    expect(bannerFor({ checkout: "success" }, "active")).toMatch(
      /plan is active/,
    );
    expect(bannerFor({ checkout: "success" }, "pending")).toMatch(
      /still being confirmed/,
    );
    expect(bannerFor({ checkout: "success" }, "unknown")).toMatch(
      /still being confirmed/,
    );
    expect(bannerFor({ checkout: "cancelled" }, null)).toMatch(
      /Nothing was charged/,
    );
    expect(bannerFor({ purchase: "success" }, "active")).toMatch(
      /extra usage was added/,
    );
    expect(bannerFor({ purchase: "success" }, "pending")).toMatch(
      /as soon as it clears/,
    );
    expect(bannerFor({ purchase: "cancelled" }, null)).toMatch(
      /Nothing was charged/,
    );
  });

  it("says what happened after a plan switch or a cancel", () => {
    expect(bannerFor({ notice: "upgraded" }, null)).toMatch(/Plan upgraded/);
    expect(bannerFor({ notice: "upgrade-processing" }, null)).toMatch(
      /processing/,
    );
    expect(bannerFor({ notice: "downgrade-scheduled" }, null)).toMatch(
      /next renewal/,
    );
    expect(bannerFor({ notice: "kept" }, null)).toMatch(/stay on your plan/);
    expect(bannerFor({ notice: "unchanged" }, null)).toMatch(
      /stay on your plan/,
    );
    expect(bannerFor({ notice: "canceled" }, null)).toMatch(
      /end of the paid period/,
    );
  });

  it("shows nothing for an unknown value and never echoes the address", () => {
    expect(bannerFor({}, null)).toBeNull();
    expect(bannerFor({ notice: "<script>alert(1)</script>" }, null)).toBeNull();
    expect(bannerFor({ checkout: ["success", "cancelled"] }, "active")).toMatch(
      /Payment received/,
    );
  });
});
