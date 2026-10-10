import { EXTRA_PACKS, PLANS, PLAN_KEYS } from "@/lib/billing/plans";

import {
  firstMonthCouponId,
  firstMonthDiscountCents,
  planUnitAmountCents,
  productIdForPlan,
  stripeInterval,
} from "./catalog";
import { StripeApiError, StripeNetworkError, type StripeHttp } from "./client";
import {
  StripeShapeError,
  parseDispute,
  parseEventEnvelope,
  parsePaymentIntent,
} from "./facts";
import { createStripeGateway } from "./gateway";
import { signStripePayload, verifyStripeSignature } from "./signature";

// Stripe TEST API duman testi: ödeme kodunun Stripe'a gönderdiği istekleri ve okuduğu
// nesne şekillerini GERÇEK Stripe'a (test modu) karşı sınar. Birim testler sahte ağ
// geçidi kullanır; parametre adlarındaki ya da alan şeklindeki bir yanlışı yalnız bu
// koşu yakalar. Veritabanına dokunmaz, ücretsiz test kartı (pm_card_visa) kullanır, işi
// bitince kendi yarattığı abonelik ve müşteriyi siler. Ürünler/kuponlar bizim kimliklerimizle
// (agentelse_*) kalır (zaten bizim katalog nesnelerimizdir). CLI: prisma/stripe-smoke.ts.

export type SmokeStatus = "PASS" | "FAIL" | "WARN";

export type SmokeStep = { name: string; status: SmokeStatus; detail: string };

export type SmokeReport = { steps: SmokeStep[]; ok: boolean };

export type SmokeOptions = {
  http: StripeHttp;
  runId: string;
  // Sahte webhook sırrı (ağsız imza turu için).
  signingSecret?: string;
  // İtiraz (dispute) test kartı için beklenecek azami süre; 0 = adımı atla.
  disputeWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

class Skip extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describeError(error: unknown): string {
  if (error instanceof StripeApiError) {
    return `${error.message}${error.param ? ` (param: ${error.param})` : ""}${error.requestId ? ` [${error.requestId}]` : ""}`;
  }
  if (
    error instanceof StripeShapeError ||
    error instanceof StripeNetworkError
  ) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

type State = {
  promotionCodeId?: string;
  customerId?: string;
  paymentMethodId?: string;
  subscriptionId?: string;
  itemId?: string;
  firstInvoiceId?: string;
  chargeId?: string;
  latestInvoiceId?: string;
};

export async function runStripeSmoke(
  options: SmokeOptions,
): Promise<SmokeReport> {
  const { http, runId } = options;
  const log = options.log ?? (() => undefined);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gateway = createStripeGateway(http);
  const workspaceId = `smoke-${runId}`;
  const state: State = {};
  const steps: SmokeStep[] = [];

  async function step(name: string, run: () => Promise<string | void>) {
    let result: SmokeStep;
    try {
      const detail = await run();
      result = { name, status: "PASS", detail: detail ?? "" };
    } catch (error) {
      result =
        error instanceof Skip
          ? { name, status: "WARN", detail: error.message }
          : { name, status: "FAIL", detail: describeError(error) };
    }
    steps.push(result);
    log(
      `${result.status.padEnd(4)}  ${result.name}${result.detail ? ` -- ${result.detail}` : ""}`,
    );
    return result;
  }

  const need = <K extends keyof State>(
    key: K,
    why: string,
  ): NonNullable<State[K]> => {
    const value = state[key];
    if (value === undefined) throw new Skip(`skipped: ${why}`);
    return value as NonNullable<State[K]>;
  };

  // 1. Anahtar çalışıyor mu (yoksa kalan adımların anlamı yok).
  const keyCheck = await step("API key works", async () => {
    await http({ method: "GET", path: "/v1/products", query: { limit: 1 } });
  });
  if (keyCheck.status === "FAIL") {
    return { steps, ok: false };
  }

  try {
    await step(
      "Customer is created with the workspace in metadata",
      async () => {
        state.customerId = await gateway.createCustomer({
          workspaceId,
          name: "Agentelse smoke test",
        });
        ensure(
          state.customerId.startsWith("cus_"),
          `unexpected customer id ${state.customerId}`,
        );
        return state.customerId;
      },
    );

    await step(
      "Checkout (subscription): every plan, first-month coupon",
      async () => {
        const customerId = need("customerId", "no customer");
        const seen: string[] = [];
        for (const planKey of PLAN_KEYS) {
          const session = await gateway.createSubscriptionCheckout({
            customerId,
            workspaceId,
            planKey,
            interval: "MONTH",
            firstMonth: true,
            successUrl:
              "https://example.com/billing?session_id={CHECKOUT_SESSION_ID}",
            cancelUrl: "https://example.com/billing?checkout=cancelled",
          });
          ensure(
            session.id.startsWith("cs_"),
            `unexpected session id ${session.id}`,
          );
          ensure(
            session.url.startsWith("https://checkout.stripe.com/"),
            `unexpected Checkout url ${session.url}`,
          );
          const read = await gateway.getCheckoutSession(session.id);
          ensure(read, `${planKey}: the created session cannot be read back`);
          ensure(read.mode === "subscription", `${planKey}: mode ${read.mode}`);
          ensure(
            read.customerId === customerId,
            `${planKey}: customer ${read.customerId}`,
          );
          ensure(
            read.clientReferenceId === workspaceId,
            `${planKey}: client_reference_id ${read.clientReferenceId}`,
          );
          ensure(
            read.metadata.planKey === planKey,
            `${planKey}: metadata ${JSON.stringify(read.metadata)}`,
          );
          ensure(
            read.amountTotal === PLANS[planKey].firstMonthCents,
            `${planKey}: first-month total ${read.amountTotal} != ${PLANS[planKey].firstMonthCents}`,
          );
          seen.push(planKey);
        }
        return `${seen.join(", ")}: totals equal the catalog first-month prices`;
      },
    );

    await step("Checkout (subscription): yearly, no coupon", async () => {
      const customerId = need("customerId", "no customer");
      const session = await gateway.createSubscriptionCheckout({
        customerId,
        workspaceId,
        planKey: "growth",
        interval: "YEAR",
        firstMonth: false,
        successUrl: "https://example.com/ok",
        cancelUrl: "https://example.com/no",
      });
      const read = await gateway.getCheckoutSession(session.id);
      ensure(read, "the created session cannot be read back");
      ensure(
        read.amountTotal === planUnitAmountCents("growth", "YEAR"),
        `yearly total ${read.amountTotal} != ${planUnitAmountCents("growth", "YEAR")}`,
      );
    });

    await step("Checkout (payment): extra packs", async () => {
      const customerId = need("customerId", "no customer");
      for (const [key, pack] of Object.entries(EXTRA_PACKS)) {
        const session = await gateway.createPackCheckout({
          customerId,
          workspaceId,
          packKey: key as keyof typeof EXTRA_PACKS,
          successUrl: "https://example.com/ok",
          cancelUrl: "https://example.com/no",
        });
        const read = await gateway.getCheckoutSession(session.id);
        ensure(read, `${key}: the created session cannot be read back`);
        ensure(read.mode === "payment", `${key}: mode ${read.mode}`);
        ensure(
          read.amountTotal === pack.priceCents,
          `${key}: total ${read.amountTotal} != ${pack.priceCents}`,
        );
        ensure(
          read.metadata.kind === "pack" && read.metadata.pack === key,
          `${key}: metadata`,
        );
      }
    });

    await step(
      "Promotion code: lookup, and the Checkout total reflects it",
      async () => {
        const customerId = need("customerId", "no customer");
        const code = `SMOKE${runId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`;
        const created = (await http({
          method: "POST",
          path: "/v1/promotion_codes",
          body: {
            coupon: firstMonthCouponId("starter"),
            code,
            max_redemptions: 1,
          },
          idempotencyKey: `smoke:${runId}:promo`,
        })) as { id?: string };
        ensure(created.id, "no promotion code id");
        state.promotionCodeId = created.id;

        // Customers type it in any letter case.
        const found = await gateway.lookupPromotionCode(code.toLowerCase());
        ensure(found, "the new promotion code cannot be found by its text");
        ensure(found.id === created.id, `found ${found.id}`);
        ensure(found.active, "the new promotion code is not active");
        ensure(
          found.coupon?.valid,
          "the promotion code carries no readable coupon",
        );
        ensure(
          found.coupon.amountOff === firstMonthDiscountCents("starter"),
          `coupon amount_off ${found.coupon.amountOff}`,
        );

        const session = await gateway.createSubscriptionCheckout({
          customerId,
          workspaceId,
          planKey: "starter",
          interval: "MONTH",
          firstMonth: false,
          promotionCodeId: found.id,
          successUrl: "https://example.com/ok",
          cancelUrl: "https://example.com/no",
        });
        const read = await gateway.getCheckoutSession(session.id);
        ensure(read, "the created session cannot be read back");
        ensure(
          read.amountTotal === PLANS.starter.firstMonthCents,
          `total with the code ${read.amountTotal} != ${PLANS.starter.firstMonthCents}`,
        );
        ensure(
          read.metadata.intro === "0",
          "a promo code must not count as the intro month",
        );
      },
    );

    await step("Billing portal session", async () => {
      const customerId = need("customerId", "no customer");
      try {
        const portal = await gateway.createPortalSession({
          customerId,
          returnUrl: "https://example.com/billing",
        });
        ensure(
          portal.url.startsWith("https://billing.stripe.com/"),
          `unexpected portal url ${portal.url}`,
        );
      } catch (error) {
        if (
          error instanceof StripeApiError &&
          /configuration/i.test(error.message)
        ) {
          throw new Skip(
            "the portal needs its default configuration saved once: Stripe Dashboard > Settings > Billing > Customer portal > Save (see docs/billing-payments.md)",
          );
        }
        throw error;
      }
    });

    await step("Test card is attached and set as the default", async () => {
      const customerId = need("customerId", "no customer");
      const attached = (await http({
        method: "POST",
        path: "/v1/payment_methods/pm_card_visa/attach",
        body: { customer: customerId },
        idempotencyKey: `smoke:${runId}:attach`,
      })) as { id?: string };
      ensure(attached.id, "attach returned no payment method id");
      state.paymentMethodId = attached.id;
      await http({
        method: "POST",
        path: `/v1/customers/${customerId}`,
        body: { invoice_settings: { default_payment_method: attached.id } },
        idempotencyKey: `smoke:${runId}:default-pm`,
      });
    });

    await step(
      "Subscription with the first-month coupon charges the discounted price",
      async () => {
        const customerId = need("customerId", "no customer");
        const paymentMethodId = need("paymentMethodId", "no payment method");
        const created = (await http({
          method: "POST",
          path: "/v1/subscriptions",
          body: {
            customer: customerId,
            items: [
              {
                price_data: {
                  currency: "usd",
                  product: productIdForPlan("starter"),
                  unit_amount: planUnitAmountCents("starter", "MONTH"),
                  recurring: { interval: stripeInterval("MONTH") },
                },
              },
            ],
            discounts: [{ coupon: firstMonthCouponId("starter") }],
            default_payment_method: paymentMethodId,
            metadata: {
              workspaceId,
              planKey: "starter",
              interval: "MONTH",
              intro: "1",
            },
            expand: ["latest_invoice"],
          },
          idempotencyKey: `smoke:${runId}:subscription`,
        })) as { id?: string };
        ensure(created.id, "no subscription id");
        state.subscriptionId = created.id;

        const sub = await gateway.getSubscription(created.id);
        ensure(sub, "the subscription cannot be read back");
        state.itemId = sub.itemId ?? undefined;
        ensure(sub.itemId, "the subscription has no item id");
        ensure(
          sub.status === "active",
          `status ${sub.status} (the test card should pay at once)`,
        );
        ensure(sub.planKey === "starter", `planKey ${sub.planKey}`);
        ensure(sub.interval === "MONTH", `interval ${sub.interval}`);
        ensure(sub.customerId === customerId, `customer ${sub.customerId}`);
        ensure(sub.startDate, "no start_date");
        ensure(
          sub.latestInvoice?.status === "paid",
          `latest invoice ${sub.latestInvoice?.status}`,
        );
        state.firstInvoiceId = sub.latestInvoice.id;
        state.latestInvoiceId = sub.latestInvoice.id;

        // Checkout asks Stripe for a customer's running subscriptions before it opens a
        // second one: the list request must return this one with its latest invoice.
        const listed = await gateway.listSubscriptions(customerId);
        const found = listed.find((item) => item.id === created.id);
        ensure(found, "the customer's subscription list does not contain it");
        ensure(
          found.latestInvoice?.status === "paid",
          `listed latest invoice ${found.latestInvoice?.status}`,
        );

        const invoice = await gateway.getInvoice(sub.latestInvoice.id);
        ensure(invoice, "the invoice cannot be read back");
        ensure(invoice.status === "paid", `invoice status ${invoice.status}`);
        ensure(
          invoice.billingReason === "subscription_create",
          `billing_reason ${invoice.billingReason}`,
        );
        ensure(
          invoice.subscriptionId === created.id,
          `invoice.subscription ${invoice.subscriptionId}`,
        );
        ensure(
          invoice.amountPaid === PLANS.starter.firstMonthCents,
          `first invoice paid ${invoice.amountPaid} != catalog first-month price ${PLANS.starter.firstMonthCents}`,
        );
        ensure(
          invoice.periodStart && invoice.periodEnd,
          "no regular line period on the first invoice",
        );
        const days =
          (invoice.periodEnd.getTime() - invoice.periodStart.getTime()) /
          DAY_MS;
        ensure(
          days >= 28 && days <= 31,
          `paid period is ${days.toFixed(1)} days`,
        );
        ensure(invoice.chargeId, "the invoice carries no charge id");
        state.chargeId = invoice.chargeId;
        return `paid ${invoice.amountPaid} cents, period ${days.toFixed(0)} days`;
      },
    );

    await step(
      "Upgrade is invoiced now and the paid period does not move",
      async () => {
        const subscriptionId = need("subscriptionId", "no subscription");
        const itemId = need("itemId", "no subscription item");
        const before = need("latestInvoiceId", "no invoice");
        const updated = await gateway.changeSubscriptionPlan({
          subscriptionId,
          itemId,
          planKey: "growth",
          interval: "MONTH",
          proration: "always_invoice",
        });
        ensure(updated.planKey === "growth", `planKey ${updated.planKey}`);
        ensure(updated.latestInvoice, "no latest invoice after the upgrade");
        ensure(
          updated.latestInvoice.id !== before,
          "the upgrade created no proration invoice",
        );
        ensure(
          updated.latestInvoice.status === "paid",
          `proration invoice ${updated.latestInvoice.status}`,
        );
        // The state machine grants an upgrade only for a PAID invoice of this exact kind,
        // read from the subscription's expanded latest_invoice.
        ensure(
          updated.latestInvoice.billingReason === "subscription_update",
          `latest_invoice billing_reason ${updated.latestInvoice.billingReason}`,
        );
        const invoice = await gateway.getInvoice(updated.latestInvoice.id);
        ensure(invoice, "the proration invoice cannot be read back");
        ensure(
          invoice.hasProration,
          "the upgrade invoice has no proration line",
        );
        ensure(
          invoice.periodEnd === null,
          "a proration invoice must not look like a paid period",
        );
        ensure(
          invoice.billingReason === "subscription_update",
          `billing_reason ${invoice.billingReason}`,
        );
        state.latestInvoiceId = updated.latestInvoice.id;
        return `proration invoice ${invoice.amountPaid} cents`;
      },
    );

    await step("Downgrade moves no money (no new invoice)", async () => {
      const subscriptionId = need("subscriptionId", "no subscription");
      const itemId = need("itemId", "no subscription item");
      const before = need("latestInvoiceId", "no invoice");
      const updated = await gateway.changeSubscriptionPlan({
        subscriptionId,
        itemId,
        planKey: "starter",
        interval: "MONTH",
        proration: "none",
      });
      ensure(updated.planKey === "starter", `planKey ${updated.planKey}`);
      ensure(
        updated.latestInvoice?.id === before,
        "the downgrade created an invoice",
      );
    });

    await step("Cancel at period end and resume", async () => {
      const subscriptionId = need("subscriptionId", "no subscription");
      const canceled = await gateway.setCancelAtPeriodEnd(subscriptionId, true);
      ensure(
        canceled.cancelAtPeriodEnd === true,
        "cancel_at_period_end did not turn on",
      );
      const resumed = await gateway.setCancelAtPeriodEnd(subscriptionId, false);
      ensure(
        resumed.cancelAtPeriodEnd === false,
        "cancel_at_period_end did not turn off",
      );
    });

    await step("Invoice list", async () => {
      const customerId = need("customerId", "no customer");
      const firstInvoiceId = need("firstInvoiceId", "no invoice");
      const rows = await gateway.listInvoices(customerId, 10);
      ensure(rows.length >= 2, `only ${rows.length} invoice(s) listed`);
      ensure(
        rows.some((row) => row.id === firstInvoiceId),
        "the first invoice is not listed",
      );
      return `${rows.length} invoices`;
    });

    await step(
      "Partial refund shows on the charge (charge.invoice, amount_refunded)",
      async () => {
        const chargeId = need("chargeId", "no charge");
        const firstInvoiceId = need("firstInvoiceId", "no invoice");
        await http({
          method: "POST",
          path: "/v1/refunds",
          body: { charge: chargeId, amount: 500 },
          idempotencyKey: `smoke:${runId}:refund`,
        });
        const charge = await gateway.getCharge(chargeId);
        ensure(charge, "the charge cannot be read back");
        ensure(
          charge.amountRefunded === 500,
          `amount_refunded ${charge.amountRefunded}`,
        );
        ensure(
          charge.refunded === false,
          "a partial refund must not read as fully refunded",
        );
        ensure(
          charge.invoiceId === firstInvoiceId,
          `charge.invoice ${charge.invoiceId} != ${firstInvoiceId} (API 2024-06-20 shape)`,
        );
        ensure(charge.paymentIntentId, "the charge carries no payment intent");
      },
    );

    await step(
      "Extra-pack payment: payment intent metadata and latest charge",
      async () => {
        const customerId = need("customerId", "no customer");
        const paymentMethodId = need("paymentMethodId", "no payment method");
        const pack = EXTRA_PACKS.images20;
        const created = (await http({
          method: "POST",
          path: "/v1/payment_intents",
          body: {
            amount: pack.priceCents,
            currency: "usd",
            customer: customerId,
            payment_method: paymentMethodId,
            confirm: true,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },
            metadata: { kind: "pack", pack: "images20", workspaceId },
          },
          idempotencyKey: `smoke:${runId}:pack-intent`,
        })) as { id?: string };
        ensure(created.id, "no payment intent id");
        const intent = await readIntent(http, created.id);
        ensure(
          intent.metadata.kind === "pack" &&
            intent.metadata.pack === "images20",
          "metadata lost",
        );
        ensure(
          intent.customerId === customerId,
          `customer ${intent.customerId}`,
        );
        ensure(
          intent.latestChargeId,
          "no latest_charge on a confirmed payment intent",
        );
        const charge = await gateway.getCharge(intent.latestChargeId);
        ensure(charge, "the charge cannot be read back");
        ensure(
          charge.amount === pack.priceCents,
          `charge ${charge.amount} != ${pack.priceCents}`,
        );
        ensure(
          charge.invoiceId === null,
          "a one-off charge should carry no invoice",
        );
      },
    );

    if ((options.disputeWaitMs ?? 0) > 0) {
      await step("Dispute shape (test card that always disputes)", async () => {
        const customerId = need("customerId", "no customer");
        const attached = (await http({
          method: "POST",
          path: "/v1/payment_methods/pm_card_createDispute/attach",
          body: { customer: customerId },
          idempotencyKey: `smoke:${runId}:attach-dispute`,
        })) as { id?: string };
        ensure(attached.id, "attach returned no payment method id");
        const created = (await http({
          method: "POST",
          path: "/v1/payment_intents",
          body: {
            amount: 1000,
            currency: "usd",
            customer: customerId,
            payment_method: attached.id,
            confirm: true,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: "never",
            },
          },
          idempotencyKey: `smoke:${runId}:dispute-intent`,
        })) as { id?: string };
        ensure(created.id, "no payment intent id");
        const intent = await readIntent(http, created.id);
        ensure(intent.latestChargeId, "no latest_charge");
        const deadline =
          (options.now ?? Date.now)() + (options.disputeWaitMs ?? 0);
        for (;;) {
          const list = (await http({
            method: "GET",
            path: "/v1/disputes",
            query: { charge: intent.latestChargeId, limit: 1 },
          })) as { data?: unknown[] };
          const first = list.data?.[0];
          if (first) {
            const dispute = parseDispute(first);
            ensure(
              dispute.chargeId === intent.latestChargeId,
              `dispute.charge ${dispute.chargeId}`,
            );
            return `dispute ${dispute.id} (${dispute.status})`;
          }
          if ((options.now ?? Date.now)() >= deadline) {
            throw new Skip(
              "Stripe had not created the test dispute yet; run again later to check its shape",
            );
          }
          await sleep(2_000);
        }
      });
    }

    await step("Webhook signature round trip and event envelope", async () => {
      const secret = options.signingSecret ?? "whsec_smoke_roundtrip_secret";
      const body = JSON.stringify({
        id: "evt_smoke0001",
        type: "invoice.paid",
        livemode: false,
        data: { object: { id: "in_smoke", object: "invoice" } },
      });
      const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
      const header = signStripePayload(body, secret, nowSec);
      const check = verifyStripeSignature({
        rawBody: body,
        header,
        secrets: [secret],
        now: new Date(nowSec * 1000),
      });
      ensure(check.ok, "a header we signed does not verify");
      const envelope = parseEventEnvelope(JSON.parse(body));
      ensure(
        envelope.objectId === "in_smoke" && envelope.type === "invoice.paid",
        "envelope misread",
      );
    });
  } finally {
    await step(
      "Cleanup: subscription canceled, customer deleted, test code turned off",
      async () => {
        // Each action on its own: the first failure must not leave the rest behind.
        const problems: string[] = [];
        const attempt = async (what: string, run: () => Promise<unknown>) => {
          try {
            await run();
          } catch (error) {
            problems.push(
              `${what}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        if (state.promotionCodeId) {
          const id = state.promotionCodeId;
          await attempt("promotion code", () =>
            http({
              method: "POST",
              path: `/v1/promotion_codes/${id}`,
              body: { active: false },
              idempotencyKey: `smoke:${runId}:promo-off`,
            }),
          );
        }
        if (state.subscriptionId) {
          const id = state.subscriptionId;
          await attempt("subscription", () => gateway.cancelSubscriptionNow(id));
        }
        if (state.customerId) {
          const id = state.customerId;
          await attempt("customer", () =>
            http({ method: "DELETE", path: `/v1/customers/${id}` }),
          );
        }
        if (problems.length > 0) {
          throw new Error(
            `could not clean up everything, remove these by hand in the Stripe TEST dashboard: ${problems.join("; ")}`,
          );
        }
      },
    );
  }

  return { steps, ok: steps.every((entry) => entry.status !== "FAIL") };
}

async function readIntent(http: StripeHttp, id: string) {
  const raw = await http({ method: "GET", path: `/v1/payment_intents/${id}` });
  return parsePaymentIntent(raw);
}
