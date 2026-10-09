import {
  EXTRA_PACKS,
  PLANS,
  PLAN_KEYS,
  isPlanKey,
  yearlyCents,
  yearlyPerMonthCents,
  type ExtraPackKey,
  type PlanKey,
} from "@/lib/billing/plans";

// Stripe tarafındaki nesnelerin kimlikleri ve fiyatları TEK yerden, plans.ts'ten
// türer: ekranda görülen fiyat ile tahsil edilen ayrışmaz. Stripe'ta elle fiyat
// nesnesi tutulmaz; her ödeme `price_data` ile SATIR İÇİ fiyat taşır, yalnız ürün
// (plan başına bir tane) ve ilk ay indirimi kuponu sabit kimlikle bir kez yaratılır.

export type BillingInterval = "MONTH" | "YEAR";

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "MONTH" || value === "YEAR";
}

const PRODUCT_PREFIX = "agentelse_plan_";

export function productIdForPlan(planKey: PlanKey): string {
  return `${PRODUCT_PREFIX}${planKey}`;
}

export function planKeyFromProductId(
  productId: string | null | undefined,
): PlanKey | null {
  if (!productId || !productId.startsWith(PRODUCT_PREFIX)) return null;
  const key = productId.slice(PRODUCT_PREFIX.length);
  return isPlanKey(key) ? key : null;
}

export function planProductName(planKey: PlanKey): string {
  return `Agentelse ${PLANS[planKey].label}`;
}

export function stripeInterval(interval: BillingInterval): "month" | "year" {
  return interval === "YEAR" ? "year" : "month";
}

export function intervalFromStripe(
  value: string | null | undefined,
): BillingInterval | null {
  if (value === "month") return "MONTH";
  if (value === "year") return "YEAR";
  return null;
}

// Faturalama aralığındaki tahsilat tutarı (cent).
export function planUnitAmountCents(
  planKey: PlanKey,
  interval: BillingInterval,
): number {
  return interval === "YEAR"
    ? yearlyCents(planKey)
    : PLANS[planKey].monthlyCents;
}

// Aylığa çevrilmiş fiyat: plan/aralık değişikliğinin yükseltme mi düşürme mi
// olduğunu sıralamak için.
export function monthlyEquivalentCents(
  planKey: PlanKey,
  interval: BillingInterval,
): number {
  return interval === "YEAR"
    ? yearlyPerMonthCents(planKey)
    : PLANS[planKey].monthlyCents;
}

export function isUpgrade(
  from: { planKey: PlanKey; interval: BillingInterval },
  to: { planKey: PlanKey; interval: BillingInterval },
): boolean {
  return (
    monthlyEquivalentCents(to.planKey, to.interval) >
    monthlyEquivalentCents(from.planKey, from.interval)
  );
}

// İlk ay kampanyası yalnız aylık faturalamada (yıllığa yığılmaz) ve kampanya fiyatı
// olan planlarda vardır.
export function firstMonthDiscountCents(planKey: PlanKey): number {
  const plan = PLANS[planKey];
  return Math.max(0, plan.monthlyCents - plan.firstMonthCents);
}

// Kupon kimliği tutarı da taşır: kuponlar değiştirilemez, fiyat değişirse yeni kimlik.
export function firstMonthCouponId(planKey: PlanKey): string {
  return `agentelse_first_month_${planKey}_${firstMonthDiscountCents(planKey)}`;
}

export function packProductName(packKey: ExtraPackKey): string {
  return packKey === "images20" ? "20 extra images" : "Extra AI budget";
}

export function isExtraPackKey(value: unknown): value is ExtraPackKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(EXTRA_PACKS, value)
  );
}

export const ALL_PLAN_PRODUCT_IDS = PLAN_KEYS.map(productIdForPlan);
