import { describe, expect, it } from "vitest";

import {
  LOW_ALLOWANCE_FRACTION,
  comparisonRows,
  discountPercent,
  displayedPrice,
  extraPackCards,
  formatDay,
  formatUsd,
  limitLevel,
  planCards,
  trialSummary,
  usedPercent,
} from "./catalog";
import {
  EXTRA_PACKS,
  PLANS,
  PLAN_KEYS,
  YEARLY_DISCOUNT_PCT,
  yearlyCents,
} from "./plans";

describe("formatUsd", () => {
  it("shows whole dollars without cents and others with two decimals", () => {
    expect(formatUsd(7_900)).toBe("$79");
    expect(formatUsd(250)).toBe("$2.50");
    expect(formatUsd(1_200)).toBe("$12");
    expect(formatUsd(123_456)).toBe("$1,234.56");
  });
});

describe("formatDay", () => {
  it("shows the UTC calendar day, whatever the machine's timezone", () => {
    expect(formatDay("2026-11-15T00:00:00.000Z")).toBe("Nov 15, 2026");
    expect(formatDay("2026-11-15T23:59:59.000Z")).toBe("Nov 15, 2026");
    expect(formatDay(new Date("2026-12-01T00:00:00.000Z"))).toBe("Dec 1, 2026");
    expect(formatDay("2026-10-08T12:00:00.000Z", { year: false })).toBe("Oct 8");
  });
});

describe("planCards", () => {
  const cards = planCards();

  it("has the four plans in order, straight from plans.ts", () => {
    expect(cards.map((card) => card.key)).toEqual([...PLAN_KEYS]);
    expect(cards.map((card) => card.price.monthlyCents)).toEqual([
      7_900, 14_900, 29_900, 59_900,
    ]);
    for (const card of cards) {
      const plan = PLANS[card.key];
      expect(card.price.firstMonthCents).toBe(plan.firstMonthCents);
      expect(card.imagesPerMonth).toBe(plan.quota.IMAGE);
      expect(card.brandLimit).toBe(plan.brandLimit);
      expect(card.aiUsageUsd * 1_000_000).toBe(plan.quota.AI_MICROS);
    }
  });

  it("prices a year at the yearly discount, not at twelve full months", () => {
    for (const card of cards) {
      expect(card.price.yearlyCents).toBe(yearlyCents(card.key));
      expect(card.price.yearlyCents).toBeLessThan(card.price.monthlyCents * 12);
      expect(
        discountPercent(card.price.monthlyCents * 12, card.price.yearlyCents),
      ).toBe(YEARLY_DISCOUNT_PCT);
    }
  });

  it("shows a smaller first-month allowance only where the plan has one", () => {
    const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(byKey.starter!.firstMonthImages).toBeNull();
    expect(byKey.growth!.firstMonthImages).toBeNull();
    expect(byKey.business!.firstMonthImages).toBe(90); // 75% of 120
    expect(byKey.agency!.firstMonthImages).toBe(225); // 75% of 300
  });

  it("marks full automation on every plan except the first", () => {
    expect(cards.map((card) => card.fullAutomation)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});

describe("displayedPrice", () => {
  const growth = planCards().find((card) => card.key === "growth")!;

  it("monthly: the full price, nothing struck out", () => {
    expect(
      displayedPrice(growth, { interval: "month", firstMonthDiscount: false }),
    ).toEqual({
      perMonthCents: 14_900,
      struckCents: null,
      note: "billed monthly",
    });
  });

  it("monthly with the discount: the first-month price against the normal one", () => {
    const shown = displayedPrice(growth, {
      interval: "month",
      firstMonthDiscount: true,
    });
    expect(shown.perMonthCents).toBe(7_900);
    expect(shown.struckCents).toBe(14_900);
    expect(shown.note).toContain("first month");
    expect(shown.note).toContain("$149");
  });

  it("yearly: the discounted monthly equivalent and the yearly invoice", () => {
    const shown = displayedPrice(growth, {
      interval: "year",
      firstMonthDiscount: false,
    });
    expect(shown.perMonthCents).toBe(growth.price.yearlyPerMonthCents);
    expect(shown.struckCents).toBe(14_900);
    expect(shown.note).toContain(formatUsd(growth.price.yearlyCents));
  });

  it("the first-month discount does not stack on the yearly price", () => {
    expect(
      displayedPrice(growth, { interval: "year", firstMonthDiscount: true }),
    ).toEqual(
      displayedPrice(growth, { interval: "year", firstMonthDiscount: false }),
    );
  });
});

describe("discountPercent", () => {
  it("rounds, never goes negative and tolerates a zero base", () => {
    expect(discountPercent(14_900, 7_900)).toBe(47);
    expect(discountPercent(100, 150)).toBe(0);
    expect(discountPercent(0, 0)).toBe(0);
  });
});

describe("comparisonRows", () => {
  const rows = comparisonRows();

  it("has one cell per plan in every row", () => {
    for (const row of rows) expect(row.cells).toHaveLength(PLAN_KEYS.length);
  });

  it("sells no video", () => {
    const text = JSON.stringify(rows).toLowerCase();
    expect(text).not.toContain("video");
  });

  it("states the numbers plans.ts enforces", () => {
    const images = rows.find((row) => row.id === "images")!;
    expect(images.cells).toEqual([
      "20",
      "50",
      "120 (90 in the first month)",
      "300 (225 in the first month)",
    ]);
    const brands = rows.find((row) => row.id === "brands")!;
    expect(brands.cells).toEqual([
      "1 brand",
      "1 brand",
      "3 brands",
      "10 brands",
    ]);
    const ai = rows.find((row) => row.id === "ai")!;
    expect(ai.cells).toEqual(["$3", "$8", "$18", "$40"]);
    const automation = rows.find((row) => row.id === "automation")!;
    expect(automation.cells).toEqual(["Limited", "Full", "Full", "Full"]);
  });
});

describe("extra packs and the trial", () => {
  it("lists exactly the packs that are sold, at their prices", () => {
    const packs = extraPackCards();
    expect(packs.map((pack) => pack.key)).toEqual(Object.keys(EXTRA_PACKS));
    expect(packs.find((pack) => pack.key === "images20")!.priceCents).toBe(
      1_200,
    );
    expect(packs.find((pack) => pack.key === "ai250")!.priceCents).toBe(1_000);
    expect(packs.find((pack) => pack.key === "images20")!.title).toBe(
      "20 post images",
    );
    expect(packs.find((pack) => pack.key === "ai250")!.title).toBe(
      "$2.50 of AI assistant usage",
    );
  });

  it("describes the trial from the same constants", () => {
    expect(trialSummary()).toBe(
      "7-day trial: 5 post images and $1 of AI usage",
    );
  });
});

describe("usage bars", () => {
  it("usedPercent is the share spent, clamped", () => {
    expect(usedPercent(50, 50)).toBe(0);
    expect(usedPercent(50, 25)).toBe(50);
    expect(usedPercent(50, 0)).toBe(100);
    expect(usedPercent(50, -5)).toBe(100);
    expect(usedPercent(50, 80)).toBe(0);
    expect(usedPercent(0, 0)).toBe(0);
  });

  it("limitLevel warns at the low-allowance line and says out at zero", () => {
    expect(LOW_ALLOWANCE_FRACTION).toBe(0.2);
    expect(limitLevel(50, 50)).toBe("ok");
    expect(limitLevel(50, 11)).toBe("ok");
    expect(limitLevel(50, 10)).toBe("low");
    expect(limitLevel(50, 1)).toBe("low");
    expect(limitLevel(50, 0)).toBe("out");
    expect(limitLevel(0, 0)).toBe("ok");
  });
});
