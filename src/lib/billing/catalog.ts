import {
  EXTRA_PACKS,
  PLANS,
  PLAN_KEYS,
  TRIAL,
  VIDEO_SELLABLE,
  YEARLY_DISCOUNT_PCT,
  yearlyCents,
  yearlyPerMonthCents,
  type PlanKey,
  type UsageUnit,
} from "./plans";

// What the Plan & usage screens show about the plans: derived from plans.ts (the
// one place prices and quotas live), never copied. Pure, so the pricing screen and
// the tests read the same numbers. Nothing here is invented: a feature appears only
// if the code enforces or sells it.

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString("en-US")}`
    : `$${dollars.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

// A calendar day for renewal dates and history rows: "Nov 15, 2026" (or "Nov 15"
// without the year). Always the UTC day, so the server and the browser agree and a
// renewal at midnight UTC is not shown a day early or late depending on the machine.
export function formatDay(
  value: string | Date,
  options: { year?: boolean } = {},
): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(options.year === false ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

export type PlanPrice = {
  // Per month, billed monthly.
  monthlyCents: number;
  // The first month of a new subscription.
  firstMonthCents: number;
  // Per month, billed yearly (the yearly discount applied).
  yearlyPerMonthCents: number;
  // The yearly invoice.
  yearlyCents: number;
};

export type PlanCard = {
  key: PlanKey;
  label: string;
  price: PlanPrice;
  brandLimit: number;
  imagesPerMonth: number;
  // Only Business and Agency: the first month's allowance is a share of the full one.
  firstMonthImages: number | null;
  aiUsageUsd: number;
  fullAutomation: boolean;
};

export function planCards(): PlanCard[] {
  return PLAN_KEYS.map((key) => {
    const plan = PLANS[key];
    const firstMonthImages = Math.floor(
      plan.quota.IMAGE * plan.firstMonthQuotaFactor,
    );
    return {
      key,
      label: plan.label,
      price: {
        monthlyCents: plan.monthlyCents,
        firstMonthCents: plan.firstMonthCents,
        yearlyPerMonthCents: yearlyPerMonthCents(key),
        yearlyCents: yearlyCents(key),
      },
      brandLimit: plan.brandLimit,
      imagesPerMonth: plan.quota.IMAGE,
      firstMonthImages:
        firstMonthImages < plan.quota.IMAGE ? firstMonthImages : null,
      aiUsageUsd: plan.quota.AI_MICROS / 1_000_000,
      fullAutomation: plan.autonomy === "full",
    };
  });
}

export type Interval = "month" | "year";

// The price a card shows for the chosen billing interval and discount switch.
// "Apply discount" only means the first-month price: it exists for monthly billing
// (the yearly price already carries the yearly discount and they do not stack).
export function displayedPrice(
  card: PlanCard,
  options: { interval: Interval; firstMonthDiscount: boolean },
): {
  perMonthCents: number;
  struckCents: number | null;
  note: string;
} {
  if (options.interval === "year") {
    return {
      perMonthCents: card.price.yearlyPerMonthCents,
      struckCents: card.price.monthlyCents,
      note: `${formatUsd(card.price.yearlyCents)} billed yearly`,
    };
  }
  if (options.firstMonthDiscount) {
    return {
      perMonthCents: card.price.firstMonthCents,
      struckCents: card.price.monthlyCents,
      note: `first month, then ${formatUsd(card.price.monthlyCents)}/month`,
    };
  }
  return {
    perMonthCents: card.price.monthlyCents,
    struckCents: null,
    note: "billed monthly",
  };
}

export function discountPercent(fromCents: number, toCents: number): number {
  if (fromCents <= 0) return 0;
  return Math.max(0, Math.round(((fromCents - toCents) / fromCents) * 100));
}

export { YEARLY_DISCOUNT_PCT };

export type ComparisonRow = {
  id: string;
  label: string;
  // One cell per plan, in plan order.
  cells: string[];
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function comparisonRows(): ComparisonRow[] {
  const cards = planCards();
  return [
    {
      id: "brands",
      label: "Brands",
      cells: cards.map((c) => plural(c.brandLimit, "brand", "brands")),
    },
    {
      id: "images",
      label: "Post images per month",
      cells: cards.map((c) =>
        c.firstMonthImages === null
          ? `${c.imagesPerMonth}`
          : `${c.imagesPerMonth} (${c.firstMonthImages} in the first month)`,
      ),
    },
    {
      id: "ai",
      label: "AI assistant usage per month",
      cells: cards.map((c) => formatUsd(c.aiUsageUsd * 100)),
    },
    {
      id: "modules",
      label: "Social Media, Ads, Analytics and SEO",
      cells: cards.map(() => "Included"),
    },
    {
      id: "automation",
      label: "Background automation",
      cells: cards.map((c) => (c.fullAutomation ? "Full" : "Limited")),
    },
    {
      id: "yearly",
      label: `Yearly billing (${YEARLY_DISCOUNT_PCT}% off)`,
      cells: cards.map(
        (c) => `${formatUsd(c.price.yearlyPerMonthCents)}/month`,
      ),
    },
  ];
}

// The extra usage a customer can add on top of a plan.
export type ExtraPackCard = {
  key: keyof typeof EXTRA_PACKS;
  unit: UsageUnit;
  title: string;
  detail: string;
  priceCents: number;
};

export function extraPackCards(): ExtraPackCard[] {
  return [
    {
      key: "images20",
      unit: "IMAGE",
      title: `${EXTRA_PACKS.images20.amount} post images`,
      detail:
        "Added to your balance right after payment. Does not expire at renewal.",
      priceCents: EXTRA_PACKS.images20.priceCents,
    },
    {
      key: "ai250",
      unit: "AI_MICROS",
      title: `${formatUsd(EXTRA_PACKS.ai250.amount / 10_000)} of AI assistant usage`,
      detail:
        "Added to your balance right after payment. Does not expire at renewal.",
      priceCents: EXTRA_PACKS.ai250.priceCents,
    },
  ];
}

// What the free trial includes, in customer words (counts only: the AI budget behind it
// is an internal figure and is never shown as dollars).
export function trialSummary(): string {
  return `${TRIAL.days}-day free trial: ${TRIAL.quota.IMAGE} post images and a starter amount of AI assistant usage`;
}

export { VIDEO_SELLABLE };

// Share of an allowance that is used (0-100), for the usage bars.
export function usedPercent(granted: number, available: number): number {
  if (granted <= 0) return 0;
  const used = Math.min(granted, Math.max(0, granted - available));
  return Math.round((used / granted) * 100);
}

export type LimitLevel = "ok" | "low" | "out";

// Limit warnings: a heads-up before the allowance runs out, then "out".
export const LOW_ALLOWANCE_FRACTION = 0.2;

export function limitLevel(granted: number, available: number): LimitLevel {
  if (granted <= 0) return "ok";
  if (available <= 0) return "out";
  return available / granted <= LOW_ALLOWANCE_FRACTION ? "low" : "ok";
}
