import {
  EXTRA_PACKS,
  PLANS,
  type ExtraPackKey,
  type PlanKey,
} from "@/lib/billing/plans";

import {
  firstMonthCouponId,
  firstMonthDiscountCents,
  packProductName,
  planProductName,
  planUnitAmountCents,
  productIdForPlan,
  stripeInterval,
  type BillingInterval,
} from "./catalog";
import { StripeApiError, type StripeHttp } from "./client";
import {
  parseCharge,
  parseCheckoutSession,
  parseDispute,
  parseId,
  parseInvoice,
  parseInvoiceList,
  parsePaymentIntent,
  parseRedirect,
  parseSubscription,
  type StripeChargeFacts,
  type StripeDisputeFacts,
  type StripeInvoiceFacts,
  type StripeInvoiceRow,
  type StripePaymentIntentFacts,
  type StripeSessionFacts,
  type StripeSubscriptionFacts,
} from "./facts";

// Stripe ile konuşan TEK katman: servisler ve işleyiciler bu arayüze bağlıdır (testler
// sahte bir ağ geçidi verir), Stripe'ın alan adları yalnız burada geçer. Her okuma,
// nesneyi güncel hâliyle SABİT API sürümünde getirir; bulunamazsa null.

export type CustomerInput = {
  workspaceId: string;
  email?: string | null;
  name?: string | null;
};

export type SubscriptionCheckoutInput = {
  customerId: string;
  workspaceId: string;
  planKey: PlanKey;
  interval: BillingInterval;
  // İlk ay kampanya kuponu uygulansın mı (sunucu karar verir, istemci değil).
  firstMonth: boolean;
  successUrl: string;
  cancelUrl: string;
};

export type PackCheckoutInput = {
  customerId: string;
  workspaceId: string;
  packKey: ExtraPackKey;
  successUrl: string;
  cancelUrl: string;
};

export type ChangePlanInput = {
  subscriptionId: string;
  itemId: string;
  planKey: PlanKey;
  interval: BillingInterval;
  // always_invoice: fark hemen faturalanır ve tahsil edilir; ödenemezse güncelleme
  // UYGULANMAZ (yükseltme). none: para hareketi yok, yeni fiyat bir sonraki yenilemede
  // geçerli olur (düşürme / bekleyen düşürmeyi geri alma).
  proration: "always_invoice" | "none";
};

export type StripeGateway = {
  getSubscription(id: string): Promise<StripeSubscriptionFacts | null>;
  getInvoice(id: string): Promise<StripeInvoiceFacts | null>;
  getCheckoutSession(id: string): Promise<StripeSessionFacts | null>;
  getCharge(id: string): Promise<StripeChargeFacts | null>;
  getPaymentIntent(id: string): Promise<StripePaymentIntentFacts | null>;
  getDispute(id: string): Promise<StripeDisputeFacts | null>;
  listInvoices(customerId: string, limit?: number): Promise<StripeInvoiceRow[]>;

  createCustomer(input: CustomerInput): Promise<string>;
  createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<{ id: string; url: string }>;
  createPackCheckout(
    input: PackCheckoutInput,
  ): Promise<{ id: string; url: string }>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  changeSubscriptionPlan(
    input: ChangePlanInput,
  ): Promise<StripeSubscriptionFacts>;
  setCancelAtPeriodEnd(
    subscriptionId: string,
    cancel: boolean,
  ): Promise<StripeSubscriptionFacts>;
  cancelSubscriptionNow(subscriptionId: string): Promise<void>;
};

async function getOrNull(
  http: StripeHttp,
  path: string,
  query?: Record<string, string | string[]>,
): Promise<unknown | null> {
  try {
    return await http({ method: "GET", path, query });
  } catch (error) {
    if (error instanceof StripeApiError && error.isNotFound) return null;
    throw error;
  }
}

export function createStripeGateway(http: StripeHttp): StripeGateway {
  // Yaratılmış (ya da var olduğu görülmüş) ürün/kupon kimlikleri: süreç ömrü boyunca
  // yeniden sorulmaz.
  const ensured = new Set<string>();

  async function ensureOnce(
    key: string,
    check: () => Promise<boolean>,
    create: () => Promise<void>,
  ): Promise<void> {
    if (ensured.has(key)) return;
    if (!(await check())) {
      try {
        await create();
      } catch (error) {
        // Eşzamanlı ikinci istek yarattı: sorun değil.
        if (
          !(error instanceof StripeApiError) ||
          error.code !== "resource_already_exists"
        ) {
          throw error;
        }
      }
    }
    ensured.add(key);
  }

  const ensureProduct = (planKey: PlanKey) => {
    const id = productIdForPlan(planKey);
    return ensureOnce(
      `product:${id}`,
      async () => (await getOrNull(http, `/v1/products/${id}`)) !== null,
      async () => {
        await http({
          method: "POST",
          path: "/v1/products",
          body: { id, name: planProductName(planKey), metadata: { planKey } },
          idempotencyKey: `agentelse:product:${id}`,
        });
      },
    );
  };

  const ensureCoupon = (planKey: PlanKey) => {
    const id = firstMonthCouponId(planKey);
    return ensureOnce(
      `coupon:${id}`,
      async () => (await getOrNull(http, `/v1/coupons/${id}`)) !== null,
      async () => {
        await http({
          method: "POST",
          path: "/v1/coupons",
          body: {
            id,
            name: `${PLANS[planKey].label} first month`,
            amount_off: firstMonthDiscountCents(planKey),
            currency: "usd",
            duration: "once",
            metadata: { planKey },
          },
          idempotencyKey: `agentelse:coupon:${id}`,
        });
      },
    );
  };

  const planPriceData = (planKey: PlanKey, interval: BillingInterval) => ({
    currency: "usd",
    product: productIdForPlan(planKey),
    unit_amount: planUnitAmountCents(planKey, interval),
    recurring: { interval: stripeInterval(interval) },
  });

  return {
    async getSubscription(id) {
      const raw = await getOrNull(http, `/v1/subscriptions/${id}`, {
        expand: ["latest_invoice"],
      });
      return raw === null ? null : parseSubscription(raw);
    },
    async getInvoice(id) {
      const raw = await getOrNull(http, `/v1/invoices/${id}`);
      return raw === null ? null : parseInvoice(raw);
    },
    async getCheckoutSession(id) {
      const raw = await getOrNull(http, `/v1/checkout/sessions/${id}`);
      return raw === null ? null : parseCheckoutSession(raw);
    },
    async getCharge(id) {
      const raw = await getOrNull(http, `/v1/charges/${id}`);
      return raw === null ? null : parseCharge(raw);
    },
    async getPaymentIntent(id) {
      const raw = await getOrNull(http, `/v1/payment_intents/${id}`);
      return raw === null ? null : parsePaymentIntent(raw);
    },
    async getDispute(id) {
      const raw = await getOrNull(http, `/v1/disputes/${id}`);
      return raw === null ? null : parseDispute(raw);
    },
    async listInvoices(customerId, limit = 12) {
      const raw = await http({
        method: "GET",
        path: "/v1/invoices",
        query: { customer: customerId, limit },
      });
      return parseInvoiceList(raw);
    },

    async createCustomer(input) {
      const raw = await http({
        method: "POST",
        path: "/v1/customers",
        body: {
          email: input.email ?? undefined,
          name: input.name ?? undefined,
          metadata: { workspaceId: input.workspaceId },
        },
        idempotencyKey: `agentelse:customer:${input.workspaceId}`,
      });
      return parseId("customer", raw);
    },

    async createSubscriptionCheckout(input) {
      await ensureProduct(input.planKey);
      if (input.firstMonth) await ensureCoupon(input.planKey);
      const metadata = {
        kind: "subscription",
        workspaceId: input.workspaceId,
        planKey: input.planKey,
        interval: input.interval,
        intro: input.firstMonth ? "1" : "0",
      };
      const raw = await http({
        method: "POST",
        path: "/v1/checkout/sessions",
        body: {
          mode: "subscription",
          customer: input.customerId,
          client_reference_id: input.workspaceId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          line_items: [
            {
              quantity: 1,
              price_data: planPriceData(input.planKey, input.interval),
            },
          ],
          discounts: input.firstMonth
            ? [{ coupon: firstMonthCouponId(input.planKey) }]
            : undefined,
          metadata,
          subscription_data: { metadata },
        },
        idempotencyKey: `agentelse:checkout:${input.workspaceId}:${cryptoRandom()}`,
      });
      return parseRedirect("checkout session", raw);
    },

    async createPackCheckout(input) {
      const pack = EXTRA_PACKS[input.packKey];
      const metadata = {
        kind: "pack",
        workspaceId: input.workspaceId,
        pack: input.packKey,
      };
      const raw = await http({
        method: "POST",
        path: "/v1/checkout/sessions",
        body: {
          mode: "payment",
          customer: input.customerId,
          client_reference_id: input.workspaceId,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: pack.priceCents,
                product_data: { name: packProductName(input.packKey) },
              },
            },
          ],
          invoice_creation: { enabled: true },
          metadata,
          payment_intent_data: { metadata },
        },
        idempotencyKey: `agentelse:pack:${input.workspaceId}:${cryptoRandom()}`,
      });
      return parseRedirect("checkout session", raw);
    },

    async createPortalSession(input) {
      const raw = await http({
        method: "POST",
        path: "/v1/billing_portal/sessions",
        body: { customer: input.customerId, return_url: input.returnUrl },
        idempotencyKey: `agentelse:portal:${input.customerId}:${cryptoRandom()}`,
      });
      return { url: parseRedirect("portal session", raw).url };
    },

    async changeSubscriptionPlan(input) {
      await ensureProduct(input.planKey);
      const raw = await http({
        method: "POST",
        path: `/v1/subscriptions/${input.subscriptionId}`,
        body: {
          items: [
            {
              id: input.itemId,
              price_data: planPriceData(input.planKey, input.interval),
            },
          ],
          proration_behavior: input.proration,
          payment_behavior:
            input.proration === "always_invoice"
              ? "error_if_incomplete"
              : undefined,
          metadata: { planKey: input.planKey, interval: input.interval },
          expand: ["latest_invoice"],
        },
        // Her çağrı kendi anahtarını taşır (ağ yeniden denemesi aynı anahtarı kullanır).
        // Stripe, anahtara ilk yanıtı HATA dahi olsa saklar: dakikaya bağlı bir anahtar,
        // kart düzeltilip yeniden denenince eski reddi tekrar ederdi.
        idempotencyKey: `agentelse:plan:${input.subscriptionId}:${cryptoRandom()}`,
      });
      return parseSubscription(raw);
    },

    async setCancelAtPeriodEnd(subscriptionId, cancel) {
      const raw = await http({
        method: "POST",
        path: `/v1/subscriptions/${subscriptionId}`,
        body: { cancel_at_period_end: cancel, expand: ["latest_invoice"] },
        idempotencyKey: `agentelse:cancel:${subscriptionId}:${cryptoRandom()}`,
      });
      return parseSubscription(raw);
    },

    async cancelSubscriptionNow(subscriptionId) {
      try {
        await http({
          method: "DELETE",
          path: `/v1/subscriptions/${subscriptionId}`,
        });
      } catch (error) {
        // Zaten iptal edilmiş: istenen sonuç.
        if (error instanceof StripeApiError && error.isNotFound) return;
        throw error;
      }
    },
  };
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID();
}
