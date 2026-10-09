import { randomUUID } from "node:crypto";

import type { PlanKey } from "@/lib/billing/plans";

import { productIdForPlan } from "../../stripe/catalog";
import { StripeApiError } from "../../stripe/client";
import type {
  StripeChargeFacts,
  StripeDisputeFacts,
  StripeInvoiceFacts,
  StripeInvoiceRow,
  StripePaymentIntentFacts,
  StripePromotionFacts,
  StripeSessionFacts,
  StripeSubscriptionFacts,
} from "../../stripe/facts";
import type { ChangePlanInput, StripeGateway } from "../../stripe/gateway";

// Testler için bellek içi Stripe: ağ geçidinin TÜM arayüzünü uygular, nesneleri testin
// kurduğu hâlde tutar ve yapılan çağrıları kaydeder. Gerçek Stripe davranışı Faz 7'de
// (test anahtarıyla) doğrulanır; burada işleyicilerin kararları sınanır.

export const T0 = new Date("2026-11-01T00:00:00.000Z");
export const T1 = new Date("2026-12-01T00:00:00.000Z");

export type FakeCall = { name: string; args: unknown };

export function createFakeStripe() {
  let seq = 0;
  // Kimlikler Stripe kimlikleri gibi benzersizdir (veritabanı tekillik kısıtları
  // testler arasında çakışmasın).
  const salt = randomUUID().slice(0, 8);
  const next = (prefix: string) => `${prefix}_${salt}${++seq}`;

  const subs = new Map<string, StripeSubscriptionFacts>();
  const invoices = new Map<string, StripeInvoiceFacts>();
  const sessions = new Map<string, StripeSessionFacts>();
  const charges = new Map<string, StripeChargeFacts>();
  const intents = new Map<string, StripePaymentIntentFacts>();
  const disputes = new Map<string, StripeDisputeFacts>();
  const promotions = new Map<string, StripePromotionFacts>();
  const invoiceRows: StripeInvoiceRow[] = [];
  const calls: FakeCall[] = [];
  const failures: {
    changePlan?: Error;
    // Yalnız seçilen plan değişikliği çağrıları patlar (ör. yalnız yükseltme reddedilir).
    changePlanWhen?: (input: ChangePlanInput) => Error | null | undefined;
    cancel?: Error;
    read?: Error;
    checkout?: Error;
  } = {};

  const record = (name: string, args: unknown) => calls.push({ name, args });

  function subscription(
    partial: Partial<StripeSubscriptionFacts> & { customerId: string },
  ): StripeSubscriptionFacts {
    const planKey: PlanKey = partial.planKey ?? "growth";
    const sub: StripeSubscriptionFacts = {
      id: partial.id ?? next("sub"),
      customerId: partial.customerId,
      status: partial.status ?? "active",
      cancelAtPeriodEnd: partial.cancelAtPeriodEnd ?? false,
      cancelAt: null,
      startDate: partial.startDate === undefined ? T0 : partial.startDate,
      currentPeriodEnd: partial.currentPeriodEnd ?? T1,
      endedAt: partial.endedAt ?? null,
      cancellationReason: partial.cancellationReason ?? null,
      livemode: partial.livemode ?? false,
      metadata: partial.metadata ?? {},
      itemId: partial.itemId === undefined ? next("si") : partial.itemId,
      productId:
        partial.productId === undefined
          ? productIdForPlan(planKey)
          : partial.productId,
      planKey: partial.planKey === undefined ? planKey : partial.planKey,
      interval: partial.interval === undefined ? "MONTH" : partial.interval,
      latestInvoice: partial.latestInvoice ?? null,
      fetchedAt: partial.fetchedAt ?? new Date(),
    };
    subs.set(sub.id, sub);
    return sub;
  }

  // Gerçek ağ geçidi gibi: her okuma/yazma yanıtı OKUNDUĞU anı taşır.
  const stamped = (sub: StripeSubscriptionFacts): StripeSubscriptionFacts => ({
    ...sub,
    fetchedAt: new Date(),
  });

  function invoice(
    partial: Partial<StripeInvoiceFacts> & {
      subscriptionId: string | null;
      customerId: string | null;
    },
  ): StripeInvoiceFacts {
    const inv: StripeInvoiceFacts = {
      id: partial.id ?? next("in"),
      customerId: partial.customerId,
      subscriptionId: partial.subscriptionId,
      status: partial.status ?? "paid",
      billingReason: partial.billingReason ?? "subscription_create",
      amountPaid: partial.amountPaid ?? 14_900,
      currency: "usd",
      livemode: partial.livemode ?? false,
      periodStart: partial.periodStart === undefined ? T0 : partial.periodStart,
      periodEnd: partial.periodEnd === undefined ? T1 : partial.periodEnd,
      hasProration: partial.hasProration ?? false,
      chargeId: partial.chargeId ?? null,
      paymentIntentId: partial.paymentIntentId ?? null,
      paidAt: T0,
    };
    invoices.set(inv.id, inv);
    return inv;
  }

  function session(partial: Partial<StripeSessionFacts>): StripeSessionFacts {
    const s: StripeSessionFacts = {
      id: partial.id ?? next("cs_test"),
      mode: partial.mode ?? "subscription",
      paymentStatus: partial.paymentStatus ?? "paid",
      status: partial.status ?? "complete",
      customerId: partial.customerId ?? null,
      subscriptionId: partial.subscriptionId ?? null,
      paymentIntentId: partial.paymentIntentId ?? null,
      clientReferenceId: partial.clientReferenceId ?? null,
      metadata: partial.metadata ?? {},
      amountTotal: partial.amountTotal ?? null,
      currency: "usd",
      livemode: partial.livemode ?? false,
    };
    sessions.set(s.id, s);
    return s;
  }

  function charge(partial: Partial<StripeChargeFacts>): StripeChargeFacts {
    const c: StripeChargeFacts = {
      id: partial.id ?? next("ch"),
      amount: partial.amount ?? 14_900,
      amountRefunded: partial.amountRefunded ?? 0,
      refunded: partial.refunded ?? false,
      customerId: partial.customerId ?? null,
      invoiceId: partial.invoiceId ?? null,
      paymentIntentId: partial.paymentIntentId ?? null,
      livemode: partial.livemode ?? false,
    };
    charges.set(c.id, c);
    return c;
  }

  function intent(
    partial: Partial<StripePaymentIntentFacts>,
  ): StripePaymentIntentFacts {
    const pi: StripePaymentIntentFacts = {
      id: partial.id ?? next("pi"),
      customerId: partial.customerId ?? null,
      metadata: partial.metadata ?? {},
      latestChargeId: partial.latestChargeId ?? null,
      livemode: partial.livemode ?? false,
    };
    intents.set(pi.id, pi);
    return pi;
  }

  function dispute(partial: Partial<StripeDisputeFacts>): StripeDisputeFacts {
    const d: StripeDisputeFacts = {
      id: partial.id ?? next("dp"),
      chargeId: partial.chargeId ?? null,
      status: partial.status ?? "needs_response",
      livemode: partial.livemode ?? false,
    };
    disputes.set(d.id, d);
    return d;
  }

  function promotion(
    partial: Partial<StripePromotionFacts> & { code: string },
  ): StripePromotionFacts {
    const id = partial.id ?? next("promo");
    const promo: StripePromotionFacts = {
      id,
      code: partial.code,
      active: partial.active ?? true,
      expiresAt: partial.expiresAt ?? null,
      maxRedemptions: partial.maxRedemptions ?? null,
      timesRedeemed: partial.timesRedeemed ?? 0,
      firstTimeOnly: partial.firstTimeOnly ?? false,
      minimumAmount: partial.minimumAmount ?? null,
      customerId: partial.customerId ?? null,
      couponId: partial.couponId ?? "coupon_fake",
      coupon:
        partial.coupon === undefined
          ? {
              id: "coupon_fake",
              valid: true,
              percentOff: 20,
              amountOff: null,
              currency: null,
              duration: "once",
              durationInMonths: null,
              redeemBy: null,
            }
          : partial.coupon,
    };
    promotions.set(id, promo);
    return promo;
  }

  const read = () => {
    if (failures.read) throw failures.read;
  };

  const gateway: StripeGateway = {
    async getSubscription(id) {
      record("getSubscription", id);
      read();
      const found = subs.get(id);
      return found ? stamped(found) : null;
    },
    async listSubscriptions(customerId) {
      record("listSubscriptions", customerId);
      read();
      return [...subs.values()]
        .filter((sub) => sub.customerId === customerId)
        .map(stamped);
    },
    async getInvoice(id) {
      record("getInvoice", id);
      read();
      return invoices.get(id) ?? null;
    },
    async getCheckoutSession(id) {
      record("getCheckoutSession", id);
      read();
      return sessions.get(id) ?? null;
    },
    async getCharge(id) {
      record("getCharge", id);
      read();
      return charges.get(id) ?? null;
    },
    async getPaymentIntent(id) {
      record("getPaymentIntent", id);
      read();
      return intents.get(id) ?? null;
    },
    async getDispute(id) {
      record("getDispute", id);
      read();
      return disputes.get(id) ?? null;
    },
    async listInvoices(customerId, limit) {
      record("listInvoices", { customerId, limit });
      return invoiceRows;
    },
    async lookupPromotionCode(code) {
      record("lookupPromotionCode", code);
      read();
      const wanted = code.toLowerCase();
      for (const promo of promotions.values()) {
        if (promo.active && promo.code.toLowerCase() === wanted) return promo;
      }
      return null;
    },
    async createCustomer(input) {
      record("createCustomer", input);
      return next("cus");
    },
    async createSubscriptionCheckout(input) {
      record("createSubscriptionCheckout", input);
      if (failures.checkout) throw failures.checkout;
      return { id: next("cs_test"), url: "https://checkout.test/subscription" };
    },
    async createPackCheckout(input) {
      record("createPackCheckout", input);
      if (failures.checkout) throw failures.checkout;
      return { id: next("cs_test"), url: "https://checkout.test/pack" };
    },
    async createPortalSession(input) {
      record("createPortalSession", input);
      return { url: "https://portal.test/session" };
    },
    async changeSubscriptionPlan(input) {
      record("changeSubscriptionPlan", input);
      if (failures.changePlan) throw failures.changePlan;
      const selective = failures.changePlanWhen?.(input);
      if (selective) throw selective;
      const sub = subs.get(input.subscriptionId);
      if (!sub)
        throw new StripeApiError({
          status: 404,
          code: "resource_missing",
          message: "no sub",
        });
      let latestInvoice = sub.latestInvoice;
      if (input.proration === "always_invoice") {
        const proration = invoice({
          subscriptionId: sub.id,
          customerId: sub.customerId,
          billingReason: "subscription_update",
          periodStart: null,
          periodEnd: null,
          hasProration: true,
          amountPaid: 5_000,
        });
        latestInvoice = {
          id: proration.id,
          status: "paid",
          billingReason: "subscription_update",
        };
      }
      const updated: StripeSubscriptionFacts = {
        ...sub,
        planKey: input.planKey,
        interval: input.interval,
        productId: productIdForPlan(input.planKey),
        latestInvoice,
      };
      subs.set(sub.id, updated);
      return stamped(updated);
    },
    async setCancelAtPeriodEnd(subscriptionId, cancel) {
      record("setCancelAtPeriodEnd", { subscriptionId, cancel });
      const sub = subs.get(subscriptionId);
      if (!sub)
        throw new StripeApiError({
          status: 404,
          code: "resource_missing",
          message: "no sub",
        });
      const updated = { ...sub, cancelAtPeriodEnd: cancel };
      subs.set(subscriptionId, updated);
      return stamped(updated);
    },
    async cancelSubscriptionNow(subscriptionId) {
      record("cancelSubscriptionNow", subscriptionId);
      if (failures.cancel) throw failures.cancel;
      const sub = subs.get(subscriptionId);
      if (sub) {
        subs.set(subscriptionId, {
          ...sub,
          status: "canceled",
          endedAt: new Date(),
          cancellationReason: "cancellation_requested",
        });
      }
    },
  };

  return {
    gateway,
    calls,
    failures,
    subs,
    invoices,
    sessions,
    charges,
    intents,
    disputes,
    promotions,
    invoiceRows,
    subscription,
    invoice,
    session,
    charge,
    intent,
    dispute,
    promotion,
    callsNamed: (name: string) => calls.filter((call) => call.name === name),
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
