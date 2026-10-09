import { describe, expect, it } from "vitest";

import { PLANS } from "@/lib/billing/plans";

import { firstMonthDiscountCents, planKeyFromProductId } from "./catalog";
import { StripeApiError, type StripeHttp, type StripeRequest } from "./client";
import { runStripeSmoke } from "./smoke";

// The smoke test's own logic against a small imitation of Stripe (the real run is the
// owner's: npm run billing:stripe-smoke). The imitation follows how Stripe behaves as
// documented: the Checkout total reflects the coupon, the first invoice is paid with the
// discount, an upgrade with always_invoice makes a proration invoice, a downgrade with
// proration none does not, and so on. Each test can switch one behavior off to prove the
// smoke test notices.

type Options = {
  // Stripe forgets to apply the coupon (first invoice and Checkout total at full price).
  ignoreCoupon?: boolean;
  // An always_invoice upgrade creates no invoice.
  noProrationInvoice?: boolean;
  // The portal has no default configuration saved.
  portalUnconfigured?: boolean;
  // The key is wrong.
  badKey?: boolean;
  // Customer creation fails.
  customerFails?: boolean;
  // A dispute shows up for the dispute card.
  dispute?: boolean;
  // A promotion code does not reduce the Checkout total.
  ignorePromotion?: boolean;
};

type Body = Record<string, unknown>;

function imitation(options: Options = {}) {
  const calls: StripeRequest[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  const sessions = new Map<string, Body>();
  const invoices = new Map<string, Body>();
  const charges = new Map<string, Body>();
  const intents = new Map<string, Body>();
  const subs = new Map<string, Body>();
  const customerOf = new Map<string, string>();
  const now = 1_790_000_000;

  const notFound = () =>
    new StripeApiError({
      status: 404,
      code: "resource_missing",
      message: "Stripe 404 resource_missing: No such object",
    });

  const priceData = (body: Body) => {
    const items = body.items as Array<{ price_data: Body }> | undefined;
    const lines = body.line_items as Array<{ price_data: Body }> | undefined;
    return (items?.[0] ?? lines?.[0])!.price_data;
  };
  const discount = (planKey: string | undefined, couponGiven: boolean) =>
    couponGiven && !options.ignoreCoupon && planKey
      ? firstMonthDiscountCents(planKey as keyof typeof PLANS)
      : 0;
  const promotions = new Map<string, Body>();
  // A Checkout discount: a coupon, or a promotion code that points at a coupon.
  const discountOf = (body: Body, planKey: string | undefined) => {
    const given = (body.discounts as Array<Body> | undefined)?.[0];
    if (!given) return 0;
    if (given.promotion_code && options.ignorePromotion) return 0;
    return discount(planKey, true);
  };

  const http: StripeHttp = async (request) => {
    calls.push(request);
    const { method, path } = request;
    const body = (request.body ?? {}) as Body;

    if (options.badKey) {
      throw new StripeApiError({
        status: 401,
        type: "invalid_request_error",
        message: "Stripe 401: Invalid API Key provided: sk_test_****",
      });
    }
    if (method === "GET" && path === "/v1/products")
      return { object: "list", data: [] };
    if (method === "GET" && /^\/v1\/(products|coupons)\//.test(path))
      return { id: path.split("/").pop() };

    if (method === "POST" && path === "/v1/customers") {
      if (options.customerFails) {
        throw new StripeApiError({
          status: 400,
          message: "Stripe 400: customer could not be created",
        });
      }
      return { id: "cus_smoke1" };
    }
    if (method === "POST" && /^\/v1\/customers\/cus_/.test(path))
      return { id: path.split("/").pop() };
    if (method === "DELETE" && /^\/v1\/customers\//.test(path))
      return { id: path.split("/").pop(), deleted: true };

    if (method === "POST" && path === "/v1/checkout/sessions") {
      const sessionId = id("cs_test");
      const price = priceData(body);
      const metadata = (body.metadata ?? {}) as Record<string, string>;
      const total =
        (price.unit_amount as number) - discountOf(body, metadata.planKey);
      sessions.set(sessionId, {
        id: sessionId,
        mode: body.mode,
        payment_status: "unpaid",
        status: "open",
        customer: body.customer,
        client_reference_id: body.client_reference_id,
        metadata,
        amount_total: total,
        currency: "usd",
        livemode: false,
      });
      return {
        id: sessionId,
        url: `https://checkout.stripe.com/c/pay/${sessionId}`,
      };
    }
    if (method === "GET" && /^\/v1\/checkout\/sessions\//.test(path)) {
      const found = sessions.get(path.split("/").pop()!);
      if (!found) throw notFound();
      return found;
    }

    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (options.portalUnconfigured) {
        throw new StripeApiError({
          status: 400,
          type: "invalid_request_error",
          message:
            "Stripe 400 invalid_request_error: No configuration provided and your test mode default configuration has not been created.",
        });
      }
      return {
        id: "bps_1",
        url: "https://billing.stripe.com/p/session/test_x",
      };
    }

    if (method === "POST" && path === "/v1/promotion_codes") {
      const promoId = id("promo");
      promotions.set(promoId, {
        id: promoId,
        code: body.code,
        active: true,
        max_redemptions: body.max_redemptions,
        times_redeemed: 0,
        coupon: {
          id: body.coupon,
          valid: true,
          amount_off: firstMonthDiscountCents("starter"),
          currency: "usd",
          duration: "once",
        },
      });
      return { id: promoId };
    }
    if (method === "POST" && /^\/v1\/promotion_codes\/promo_/.test(path)) {
      const promo = promotions.get(path.split("/").pop()!)!;
      promo.active = body.active;
      return promo;
    }
    if (method === "GET" && path === "/v1/promotion_codes") {
      const wanted = String(request.query?.code ?? "").toLowerCase();
      const found = [...promotions.values()].find(
        (promo) => promo.active && String(promo.code).toLowerCase() === wanted,
      );
      return { data: found ? [found] : [] };
    }

    if (method === "POST" && /\/attach$/.test(path)) return { id: id("pm") };

    if (method === "POST" && path === "/v1/subscriptions") {
      const subId = id("sub");
      const price = priceData(body);
      const metadata = (body.metadata ?? {}) as Record<string, string>;
      const paid =
        (price.unit_amount as number) -
        discount(
          metadata.planKey,
          Array.isArray(body.discounts) && body.discounts.length > 0,
        );
      const invoiceId = id("in");
      const chargeId = id("ch");
      customerOf.set(subId, body.customer as string);
      invoices.set(invoiceId, {
        id: invoiceId,
        customer: body.customer,
        subscription: subId,
        status: "paid",
        billing_reason: "subscription_create",
        amount_paid: paid,
        currency: "usd",
        livemode: false,
        charge: chargeId,
        payment_intent: id("pi"),
        status_transitions: { paid_at: now },
        lines: {
          data: [
            {
              type: "subscription",
              proration: false,
              period: { start: now, end: now + 30 * 86400 },
            },
          ],
        },
      });
      charges.set(chargeId, {
        id: chargeId,
        amount: paid,
        amount_refunded: 0,
        refunded: false,
        customer: body.customer,
        invoice: invoiceId,
        payment_intent: "pi_for_charge",
        livemode: false,
      });
      subs.set(subId, {
        id: subId,
        customer: body.customer,
        status: "active",
        cancel_at_period_end: false,
        start_date: now,
        current_period_end: now + 30 * 86400,
        livemode: false,
        metadata,
        items: {
          data: [
            {
              id: "si_1",
              price: {
                product: price.product,
                recurring: { interval: (price.recurring as Body).interval },
              },
            },
          ],
        },
        latest_invoice: {
          id: invoiceId,
          status: "paid",
          billing_reason: "subscription_create",
        },
      });
      return subs.get(subId);
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      return {
        data: [...subs.values()].filter(
          (sub) => sub.customer === request.query?.customer,
        ),
      };
    }
    if (method === "GET" && /^\/v1\/subscriptions\//.test(path)) {
      const found = subs.get(path.split("/").pop()!);
      if (!found) throw notFound();
      return found;
    }
    if (method === "POST" && /^\/v1\/subscriptions\/sub_/.test(path)) {
      const sub = subs.get(path.split("/").pop()!)!;
      if ("cancel_at_period_end" in body)
        sub.cancel_at_period_end = body.cancel_at_period_end;
      if (body.items) {
        const price = priceData(body);
        sub.items = {
          data: [
            {
              id: "si_1",
              price: {
                product: price.product,
                recurring: { interval: (price.recurring as Body).interval },
              },
            },
          ],
        };
        if (
          body.proration_behavior === "always_invoice" &&
          !options.noProrationInvoice
        ) {
          const invoiceId = id("in");
          invoices.set(invoiceId, {
            id: invoiceId,
            customer: sub.customer,
            subscription: sub.id,
            status: "paid",
            billing_reason: "subscription_update",
            amount_paid: 3000,
            currency: "usd",
            livemode: false,
            lines: {
              data: [
                {
                  type: "invoiceitem",
                  proration: true,
                  period: { start: now + 86400, end: now + 30 * 86400 },
                },
              ],
            },
          });
          sub.latest_invoice = {
            id: invoiceId,
            status: "paid",
            billing_reason: "subscription_update",
          };
        }
      }
      return sub;
    }
    if (method === "DELETE" && /^\/v1\/subscriptions\//.test(path))
      return { id: path.split("/").pop(), status: "canceled" };

    if (method === "GET" && /^\/v1\/invoices\/in_/.test(path)) {
      const found = invoices.get(path.split("/").pop()!);
      if (!found) throw notFound();
      return found;
    }
    if (method === "GET" && path === "/v1/invoices") {
      return {
        data: [...invoices.values()].map((row) => ({
          id: row.id,
          amount_paid: row.amount_paid,
          status: row.status,
          created: now,
        })),
      };
    }

    if (method === "POST" && path === "/v1/refunds") {
      const charge = charges.get(body.charge as string)!;
      charge.amount_refunded = body.amount;
      return { id: id("re") };
    }
    if (method === "GET" && /^\/v1\/charges\//.test(path)) {
      const found = charges.get(path.split("/").pop()!);
      if (!found) throw notFound();
      return found;
    }

    if (method === "POST" && path === "/v1/payment_intents") {
      const intentId = id("pi");
      const chargeId = id("ch");
      intents.set(intentId, {
        id: intentId,
        customer: body.customer,
        metadata: body.metadata ?? {},
        latest_charge: chargeId,
        livemode: false,
      });
      charges.set(chargeId, {
        id: chargeId,
        amount: body.amount,
        amount_refunded: 0,
        refunded: false,
        customer: body.customer,
        invoice: null,
        payment_intent: intentId,
        livemode: false,
      });
      return { id: intentId };
    }
    if (method === "GET" && /^\/v1\/payment_intents\//.test(path))
      return intents.get(path.split("/").pop()!);

    if (method === "GET" && path === "/v1/disputes") {
      return options.dispute
        ? {
            data: [
              {
                id: "dp_1",
                charge: request.query?.charge,
                status: "needs_response",
                livemode: false,
              },
            ],
          }
        : { data: [] };
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };

  return { http, calls };
}

const run = (options: Options = {}, extra: { disputeWaitMs?: number } = {}) => {
  const fake = imitation(options);
  let time = 0;
  return runStripeSmoke({
    http: fake.http,
    runId: "t1",
    now: () => (time += 1_000),
    sleep: async () => undefined,
    ...extra,
  }).then((report) => ({ report, calls: fake.calls }));
};

const statusOf = (
  report: Awaited<ReturnType<typeof run>>["report"],
  fragment: string,
) => report.steps.find((step) => step.name.includes(fragment))?.status;

describe("runStripeSmoke", () => {
  it("passes against a Stripe that behaves as documented, and cleans up after itself", async () => {
    const { report, calls } = await run();

    expect(report.ok).toBe(true);
    expect(report.steps.filter((step) => step.status === "FAIL")).toEqual([]);
    expect(report.steps.filter((step) => step.status === "WARN")).toEqual([]);
    const deleted = calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.path);
    expect(deleted).toEqual([
      "/v1/subscriptions/sub_" + deleted[0]!.split("sub_")[1],
      "/v1/customers/cus_smoke1",
    ]);
  });

  it("really exercises the flows: every plan's Checkout, the coupon price, upgrade, downgrade, cancel, refund, pack", async () => {
    const { report, calls } = await run();

    const sessions = calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    );
    // 4 plans (monthly + coupon) + yearly + 2 packs + 1 with a promotion code.
    expect(sessions).toHaveLength(8);
    const updates = calls.filter(
      (call) =>
        /^\/v1\/subscriptions\/sub_/.test(call.path) && call.method === "POST",
    );
    expect(
      updates.map(
        (call) => (call.body as Body).proration_behavior ?? "cancel-flag",
      ),
    ).toEqual(["always_invoice", "none", "cancel-flag", "cancel-flag"]);
    expect(calls.some((call) => call.path === "/v1/refunds")).toBe(true);
    expect(report.steps.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        "API key works",
        "Customer is created with the workspace in metadata",
        "Billing portal session",
        "Upgrade is invoiced now and the paid period does not move",
        "Downgrade moves no money (no new invoice)",
        "Webhook signature round trip and event envelope",
      ]),
    );
    expect(planKeyFromProductId("agentelse_plan_growth")).toBe("growth");
  });

  it("FAILS when the first-month coupon does not give the catalog price (and still cleans up)", async () => {
    const { report, calls } = await run({ ignoreCoupon: true });

    expect(report.ok).toBe(false);
    expect(statusOf(report, "Checkout (subscription): every plan")).toBe(
      "FAIL",
    );
    expect(
      report.steps.find((step) => step.status === "FAIL")!.detail,
    ).toContain("first-month");
    expect(statusOf(report, "Subscription with the first-month coupon")).toBe(
      "FAIL",
    );
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" && call.path === "/v1/customers/cus_smoke1",
      ),
    ).toBe(true);
  });

  it("covers promotion codes: made, found by lowercase text, priced at checkout, and turned off at the end", async () => {
    const { report, calls } = await run();

    expect(statusOf(report, "Promotion code")).toBe("PASS");
    const turnedOff = calls.find(
      (call) =>
        call.method === "POST" &&
        /^\/v1\/promotion_codes\/promo_/.test(call.path) &&
        (call.body as Body).active === false,
    );
    expect(turnedOff).toBeDefined();
  });

  it("FAILS when a promotion code does not change the Checkout total", async () => {
    const { report } = await run({ ignorePromotion: true });

    expect(report.ok).toBe(false);
    expect(statusOf(report, "Promotion code")).toBe("FAIL");
    expect(
      report.steps.find((step) => step.name.startsWith("Promotion code"))!
        .detail,
    ).toContain("total with the code");
  });

  it("FAILS when an upgrade makes no proration invoice", async () => {
    const { report } = await run({ noProrationInvoice: true });

    expect(report.ok).toBe(false);
    expect(statusOf(report, "Upgrade is invoiced now")).toBe("FAIL");
  });

  it("a portal that was never configured is a WARNING with the fix, not a failure", async () => {
    const { report } = await run({ portalUnconfigured: true });

    expect(report.ok).toBe(true);
    const portal = report.steps.find(
      (step) => step.name === "Billing portal session",
    )!;
    expect(portal.status).toBe("WARN");
    expect(portal.detail).toContain("Customer portal");
  });

  it("stops at once on a wrong key, before creating anything", async () => {
    const { report, calls } = await run({ badKey: true });

    expect(report.ok).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({
      name: "API key works",
      status: "FAIL",
    });
    expect(calls).toHaveLength(1);
  });

  it("skips what depends on a missing customer instead of failing in a confusing way", async () => {
    const { report } = await run({ customerFails: true });

    expect(statusOf(report, "Customer is created")).toBe("FAIL");
    expect(statusOf(report, "Checkout (subscription): every plan")).toBe(
      "WARN",
    );
    expect(statusOf(report, "Upgrade is invoiced now")).toBe("WARN");
    expect(report.ok).toBe(false);
  });

  it("checks the dispute shape only when asked, and waits for Stripe to create it", async () => {
    const without = await run({ dispute: true });
    expect(
      without.report.steps.some((step) => step.name.startsWith("Dispute")),
    ).toBe(false);

    const found = await run({ dispute: true }, { disputeWaitMs: 5_000 });
    expect(statusOf(found.report, "Dispute shape")).toBe("PASS");

    const late = await run({ dispute: false }, { disputeWaitMs: 2_500 });
    expect(statusOf(late.report, "Dispute shape")).toBe("WARN");
    expect(late.report.ok).toBe(true);
  });
});
