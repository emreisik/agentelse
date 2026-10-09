import { describe, expect, it, vi } from "vitest";

import { PLANS, yearlyCents } from "@/lib/billing/plans";

import { StripeApiError, type StripeHttp, type StripeRequest } from "./client";
import { createStripeGateway } from "./gateway";

// What this suite proves: the exact requests the billing code sends to Stripe. There is
// no live Stripe here, so the parameter NAMES and the amounts are asserted literally;
// Faz 7 repeats the same flows against the real test API.

type Handler = (request: StripeRequest) => unknown;

function fakeHttp(handler: Handler) {
  const calls: StripeRequest[] = [];
  const http: StripeHttp = async (request) => {
    calls.push(request);
    const result = handler(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return { http, calls };
}

const notFound = () =>
  new StripeApiError({
    status: 404,
    code: "resource_missing",
    message: "Stripe 404 resource_missing: No such object",
  });

const subscriptionJson = (extra: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  livemode: false,
  metadata: {},
  items: {
    data: [
      {
        id: "si_1",
        price: {
          product: "agentelse_plan_growth",
          recurring: { interval: "month" },
        },
      },
    ],
  },
  latest_invoice: {
    id: "in_1",
    status: "paid",
    billing_reason: "subscription_update",
  },
  ...extra,
});

describe("reads", () => {
  it("expands the latest invoice when reading a subscription and returns null for a missing one", async () => {
    const { http, calls } = fakeHttp((request) =>
      request.path.endsWith("sub_missing") ? notFound() : subscriptionJson(),
    );
    const gateway = createStripeGateway(http);

    const found = await gateway.getSubscription("sub_1");
    const missing = await gateway.getSubscription("sub_missing");

    expect(found?.planKey).toBe("growth");
    expect(missing).toBeNull();
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/v1/subscriptions/sub_1",
      query: { expand: ["latest_invoice"] },
    });
  });

  it("lists a customer's invoices", async () => {
    const { http, calls } = fakeHttp(() => ({ data: [] }));
    await createStripeGateway(http).listInvoices("cus_1", 5);
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/v1/invoices",
      query: { customer: "cus_1", limit: 5 },
    });
  });

  it("does not hide an unexpected API error behind null", async () => {
    const { http } = fakeHttp(
      () => new StripeApiError({ status: 500, message: "boom" }),
    );
    await expect(
      createStripeGateway(http).getInvoice("in_1"),
    ).rejects.toBeInstanceOf(StripeApiError);
  });
});

describe("createCustomer", () => {
  it("sends the workspace in metadata with a stable idempotency key", async () => {
    const { http, calls } = fakeHttp(() => ({ id: "cus_9" }));
    const id = await createStripeGateway(http).createCustomer({
      workspaceId: "w1",
      email: "a@b.co",
      name: "Acme",
    });
    expect(id).toBe("cus_9");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/customers",
      body: { email: "a@b.co", name: "Acme", metadata: { workspaceId: "w1" } },
      idempotencyKey: "agentelse:customer:w1",
    });
  });
});

describe("createSubscriptionCheckout", () => {
  const input = {
    customerId: "cus_1",
    workspaceId: "w1",
    planKey: "growth" as const,
    interval: "MONTH" as const,
    firstMonth: true,
    successUrl: "https://app.test/billing?session_id={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://app.test/billing?cancelled=1",
  };

  function setup(existing: { product: boolean; coupon: boolean }) {
    return fakeHttp((request) => {
      if (
        request.method === "GET" &&
        request.path.startsWith("/v1/products/")
      ) {
        return existing.product ? { id: "x" } : notFound();
      }
      if (request.method === "GET" && request.path.startsWith("/v1/coupons/")) {
        return existing.coupon ? { id: "x" } : notFound();
      }
      if (request.path === "/v1/checkout/sessions") {
        return {
          id: "cs_test_abc12345",
          url: "https://checkout.stripe.com/c/pay/cs_test_abc12345",
        };
      }
      return { id: "created" };
    });
  }

  it("creates the product and the first-month coupon once, then a subscription session priced from the catalog", async () => {
    const { http, calls } = setup({ product: false, coupon: false });
    const gateway = createStripeGateway(http);

    const session = await gateway.createSubscriptionCheckout(input);
    await gateway.createSubscriptionCheckout(input);

    expect(session).toEqual({
      id: "cs_test_abc12345",
      url: "https://checkout.stripe.com/c/pay/cs_test_abc12345",
    });
    const created = calls.filter((call) => call.method === "POST");
    const product = created.find((call) => call.path === "/v1/products")!;
    expect(product.body).toMatchObject({
      id: "agentelse_plan_growth",
      name: "Agentelse Growth",
    });
    const coupon = created.find((call) => call.path === "/v1/coupons")!;
    expect(coupon.body).toMatchObject({
      amount_off: PLANS.growth.monthlyCents - PLANS.growth.firstMonthCents,
      currency: "usd",
      duration: "once",
    });
    // Second checkout reuses what was ensured: one product + one coupon creation in total.
    expect(created.filter((call) => call.path === "/v1/products")).toHaveLength(
      1,
    );
    expect(created.filter((call) => call.path === "/v1/coupons")).toHaveLength(
      1,
    );

    const checkout = created.find(
      (call) => call.path === "/v1/checkout/sessions",
    )!;
    expect(checkout.body).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: "w1",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            product: "agentelse_plan_growth",
            unit_amount: PLANS.growth.monthlyCents,
            recurring: { interval: "month" },
          },
        },
      ],
      discounts: [
        { coupon: expect.stringContaining("agentelse_first_month_growth_") },
      ],
      metadata: {
        kind: "subscription",
        workspaceId: "w1",
        planKey: "growth",
        interval: "MONTH",
        intro: "1",
      },
      subscription_data: {
        metadata: {
          kind: "subscription",
          workspaceId: "w1",
          planKey: "growth",
          interval: "MONTH",
          intro: "1",
        },
      },
    });
    expect(checkout.idempotencyKey).toMatch(/^agentelse:checkout:w1:/);
  });

  it("does not touch Stripe's catalog when the objects already exist, and sends no coupon without the discount", async () => {
    const { http, calls } = setup({ product: true, coupon: true });
    await createStripeGateway(http).createSubscriptionCheckout({
      ...input,
      interval: "YEAR",
      firstMonth: false,
    });
    expect(
      calls.filter(
        (call) => call.path === "/v1/products" && call.method === "POST",
      ),
    ).toHaveLength(0);
    expect(calls.some((call) => call.path.startsWith("/v1/coupons"))).toBe(
      false,
    );
    const checkout = calls.find(
      (call) => call.path === "/v1/checkout/sessions",
    )!;
    expect(checkout.body).toMatchObject({
      line_items: [
        {
          price_data: {
            unit_amount: yearlyCents("growth"),
            recurring: { interval: "year" },
          },
        },
      ],
      metadata: { intro: "0" },
    });
    expect(checkout.body?.discounts).toBeUndefined();
  });

  it("tolerates losing the creation race (resource_already_exists)", async () => {
    const http: StripeHttp = async (request) => {
      if (request.method === "GET" && request.path.startsWith("/v1/products/"))
        throw notFound();
      if (request.method === "POST" && request.path === "/v1/products") {
        throw new StripeApiError({
          status: 400,
          code: "resource_already_exists",
          message: "exists",
        });
      }
      return { id: "cs_test_abc12345", url: "https://checkout.stripe.com/x" };
    };
    await expect(
      createStripeGateway(http).createSubscriptionCheckout({
        ...input,
        firstMonth: false,
      }),
    ).resolves.toMatchObject({ id: "cs_test_abc12345" });
  });

  it("propagates other creation errors", async () => {
    const http: StripeHttp = async (request) => {
      if (request.method === "GET") throw notFound();
      throw new StripeApiError({ status: 500, message: "boom" });
    };
    await expect(
      createStripeGateway(http).createSubscriptionCheckout({
        ...input,
        firstMonth: false,
      }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });
});

describe("createPackCheckout", () => {
  it("sends a one-off payment with an invoice and the pack in the payment intent metadata", async () => {
    const { http, calls } = fakeHttp(() => ({
      id: "cs_test_pack00001",
      url: "https://checkout.stripe.com/c/pay/cs_test_pack00001",
    }));
    await createStripeGateway(http).createPackCheckout({
      customerId: "cus_1",
      workspaceId: "w1",
      packKey: "images20",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });
    expect(calls[0]!.body).toMatchObject({
      mode: "payment",
      customer: "cus_1",
      client_reference_id: "w1",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 1200,
            product_data: { name: "20 extra images" },
          },
        },
      ],
      invoice_creation: { enabled: true },
      metadata: { kind: "pack", workspaceId: "w1", pack: "images20" },
      payment_intent_data: {
        metadata: { kind: "pack", workspaceId: "w1", pack: "images20" },
      },
    });
  });
});

describe("portal, plan change, cancellation", () => {
  it("opens the portal for the customer and returns to the app", async () => {
    const { http, calls } = fakeHttp(() => ({
      id: "bps_1",
      url: "https://billing.stripe.com/p/session/x",
    }));
    const portal = await createStripeGateway(http).createPortalSession({
      customerId: "cus_1",
      returnUrl: "https://app.test/billing",
    });
    expect(portal.url).toBe("https://billing.stripe.com/p/session/x");
    expect(calls[0]).toMatchObject({
      path: "/v1/billing_portal/sessions",
      body: { customer: "cus_1", return_url: "https://app.test/billing" },
    });
  });

  it("an upgrade replaces the item, invoices the proration now, and refuses to apply if the payment fails", async () => {
    const { http, calls } = fakeHttp((request) =>
      request.path === "/v1/products/agentelse_plan_business"
        ? { id: "x" }
        : subscriptionJson(),
    );
    await createStripeGateway(http).changeSubscriptionPlan({
      subscriptionId: "sub_1",
      itemId: "si_1",
      planKey: "business",
      interval: "MONTH",
      proration: "always_invoice",
    });
    const update = calls.find((call) => call.method === "POST")!;
    expect(update.path).toBe("/v1/subscriptions/sub_1");
    expect(update.body).toMatchObject({
      items: [
        {
          id: "si_1",
          price_data: {
            currency: "usd",
            product: "agentelse_plan_business",
            unit_amount: PLANS.business.monthlyCents,
            recurring: { interval: "month" },
          },
        },
      ],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      metadata: { planKey: "business", interval: "MONTH" },
      expand: ["latest_invoice"],
    });
  });

  it("a downgrade moves no money now (proration none, no payment behaviour)", async () => {
    const { http, calls } = fakeHttp((request) =>
      request.method === "GET" ? { id: "x" } : subscriptionJson(),
    );
    await createStripeGateway(http).changeSubscriptionPlan({
      subscriptionId: "sub_1",
      itemId: "si_1",
      planKey: "starter",
      interval: "MONTH",
      proration: "none",
    });
    const update = calls.find((call) => call.method === "POST")!;
    expect(update.body).toMatchObject({ proration_behavior: "none" });
    expect(update.body?.payment_behavior).toBeUndefined();
  });

  it("each plan update carries its own idempotency key (a retry after a fixed card is not a replay of the old error)", async () => {
    const { http, calls } = fakeHttp((request) =>
      request.method === "GET" ? { id: "x" } : subscriptionJson(),
    );
    const gateway = createStripeGateway(http);
    const change = () =>
      gateway.changeSubscriptionPlan({
        subscriptionId: "sub_1",
        itemId: "si_1",
        planKey: "business",
        interval: "MONTH",
        proration: "always_invoice",
      });
    await change();
    await change();
    const keys = calls
      .filter((call) => call.method === "POST")
      .map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("sets and clears cancel-at-period-end", async () => {
    const { http, calls } = fakeHttp(() =>
      subscriptionJson({ cancel_at_period_end: true }),
    );
    const gateway = createStripeGateway(http);
    const sub = await gateway.setCancelAtPeriodEnd("sub_1", true);
    await gateway.setCancelAtPeriodEnd("sub_1", false);
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(calls[0]!.body).toMatchObject({ cancel_at_period_end: true });
    expect(calls[1]!.body).toMatchObject({ cancel_at_period_end: false });
  });

  it("cancels immediately and treats an already-gone subscription as done", async () => {
    const del = vi.fn();
    const http: StripeHttp = async (request) => {
      del(request);
      throw notFound();
    };
    await expect(
      createStripeGateway(http).cancelSubscriptionNow("sub_1"),
    ).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        path: "/v1/subscriptions/sub_1",
      }),
    );
  });
});
