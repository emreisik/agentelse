import { describe, expect, it } from "vitest";

import {
  EXTRA_PACKS,
  PLANS,
  PLAN_KEYS,
  yearlyCents,
  yearlyPerMonthCents,
} from "@/lib/billing/plans";

import {
  firstMonthCouponId,
  firstMonthDiscountCents,
  intervalFromStripe,
  isBillingInterval,
  isExtraPackKey,
  isUpgrade,
  monthlyEquivalentCents,
  planKeyFromProductId,
  planUnitAmountCents,
  productIdForPlan,
  stripeInterval,
} from "./catalog";

describe("stripe catalog", () => {
  it("round-trips every plan through its product id and rejects anything else", () => {
    for (const key of PLAN_KEYS) {
      expect(planKeyFromProductId(productIdForPlan(key))).toBe(key);
    }
    expect(planKeyFromProductId("agentelse_plan_enterprise")).toBeNull();
    expect(planKeyFromProductId("prod_123")).toBeNull();
    expect(planKeyFromProductId(null)).toBeNull();
    expect(planKeyFromProductId(undefined)).toBeNull();
  });

  it("charges exactly the catalog price for each interval (what the page shows is what Stripe bills)", () => {
    for (const key of PLAN_KEYS) {
      expect(planUnitAmountCents(key, "MONTH")).toBe(PLANS[key].monthlyCents);
      expect(planUnitAmountCents(key, "YEAR")).toBe(yearlyCents(key));
    }
  });

  it("maps intervals both ways", () => {
    expect(stripeInterval("MONTH")).toBe("month");
    expect(stripeInterval("YEAR")).toBe("year");
    expect(intervalFromStripe("month")).toBe("MONTH");
    expect(intervalFromStripe("year")).toBe("YEAR");
    expect(intervalFromStripe("week")).toBeNull();
    expect(intervalFromStripe(null)).toBeNull();
    expect(isBillingInterval("MONTH")).toBe(true);
    expect(isBillingInterval("month")).toBe(false);
  });

  it("ranks plans by price per month: a bigger plan is an upgrade, a smaller one is not, a cheaper interval is not", () => {
    expect(
      isUpgrade(
        { planKey: "starter", interval: "MONTH" },
        { planKey: "growth", interval: "MONTH" },
      ),
    ).toBe(true);
    expect(
      isUpgrade(
        { planKey: "growth", interval: "MONTH" },
        { planKey: "starter", interval: "MONTH" },
      ),
    ).toBe(false);
    expect(
      isUpgrade(
        { planKey: "growth", interval: "MONTH" },
        { planKey: "growth", interval: "MONTH" },
      ),
    ).toBe(false);
    // Same plan, yearly is cheaper per month: not an upgrade.
    expect(
      isUpgrade(
        { planKey: "growth", interval: "MONTH" },
        { planKey: "growth", interval: "YEAR" },
      ),
    ).toBe(false);
    expect(monthlyEquivalentCents("growth", "YEAR")).toBe(
      yearlyPerMonthCents("growth"),
    );
  });

  it("ranks every pair of plans consistently on the same interval", () => {
    for (const interval of ["MONTH", "YEAR"] as const) {
      for (let i = 0; i < PLAN_KEYS.length; i += 1) {
        for (let j = 0; j < PLAN_KEYS.length; j += 1) {
          const up = isUpgrade(
            { planKey: PLAN_KEYS[i]!, interval },
            { planKey: PLAN_KEYS[j]!, interval },
          );
          expect(up).toBe(j > i);
        }
      }
    }
  });

  it("derives the first-month coupon from the catalog and bakes the amount into its id (coupons are immutable)", () => {
    for (const key of PLAN_KEYS) {
      expect(firstMonthDiscountCents(key)).toBe(
        PLANS[key].monthlyCents - PLANS[key].firstMonthCents,
      );
      expect(firstMonthCouponId(key)).toContain(
        String(firstMonthDiscountCents(key)),
      );
      // The discounted first invoice lands exactly on the catalog first-month price.
      expect(PLANS[key].monthlyCents - firstMonthDiscountCents(key)).toBe(
        PLANS[key].firstMonthCents,
      );
    }
  });

  it("knows the extra packs", () => {
    for (const key of Object.keys(EXTRA_PACKS))
      expect(isExtraPackKey(key)).toBe(true);
    expect(isExtraPackKey("toString")).toBe(false);
    expect(isExtraPackKey("images999")).toBe(false);
    expect(isExtraPackKey(5)).toBe(false);
  });
});
