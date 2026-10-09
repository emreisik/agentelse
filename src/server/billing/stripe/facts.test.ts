import { describe, expect, it } from "vitest";

import {
  StripeShapeError,
  parseCharge,
  parseCheckoutSession,
  parseDispute,
  parseEventEnvelope,
  parseInvoice,
  parseCoupon,
  parseInvoiceList,
  parsePaymentIntent,
  parsePromotionCodeList,
  parseRedirect,
  parseSubscription,
  parseSubscriptionList,
} from "./facts";

// Fixtures follow the pinned API version (2024-06-20).
const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  cancel_at: null,
  start_date: 1_760_000_000,
  current_period_end: 1_762_592_000,
  ended_at: null,
  livemode: false,
  metadata: { workspaceId: "w1", intro: "1" },
  cancellation_details: { reason: null },
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
    billing_reason: "subscription_create",
  },
  ...overrides,
});

describe("parseSubscription", () => {
  it("normalises the fields the billing code reads", () => {
    const facts = parseSubscription(subscription());
    expect(facts).toMatchObject({
      id: "sub_1",
      customerId: "cus_1",
      status: "active",
      cancelAtPeriodEnd: false,
      itemId: "si_1",
      productId: "agentelse_plan_growth",
      planKey: "growth",
      interval: "MONTH",
      metadata: { workspaceId: "w1", intro: "1" },
      latestInvoice: {
        id: "in_1",
        status: "paid",
        billingReason: "subscription_create",
      },
    });
    expect(facts.startDate).toEqual(new Date(1_760_000_000 * 1000));
    expect(facts.currentPeriodEnd).toEqual(new Date(1_762_592_000 * 1000));
  });

  it("accepts an expanded customer / product and a bare latest_invoice id", () => {
    const facts = parseSubscription(
      subscription({
        customer: { id: "cus_9", name: "x" },
        latest_invoice: "in_77",
        items: {
          data: [
            {
              id: "si_2",
              price: {
                product: { id: "agentelse_plan_business", name: "Business" },
                recurring: { interval: "year" },
              },
            },
          ],
        },
      }),
    );
    expect(facts.customerId).toBe("cus_9");
    expect(facts.planKey).toBe("business");
    expect(facts.interval).toBe("YEAR");
    expect(facts.latestInvoice).toEqual({
      id: "in_77",
      status: null,
      billingReason: null,
    });
  });

  it("does not guess a plan for a product it does not own", () => {
    const facts = parseSubscription(
      subscription({
        items: {
          data: [
            {
              id: "si_3",
              price: {
                product: "prod_other",
                recurring: { interval: "month" },
              },
            },
          ],
        },
      }),
    );
    expect(facts.planKey).toBeNull();
    expect(facts.productId).toBe("prod_other");
  });

  it("reads a cancellation reason", () => {
    expect(
      parseSubscription(
        subscription({
          status: "canceled",
          cancellation_details: { reason: "payment_failed" },
        }),
      ).cancellationReason,
    ).toBe("payment_failed");
  });

  it("refuses an object without the required fields", () => {
    expect(() => parseSubscription({ id: "sub_1" })).toThrow(StripeShapeError);
    expect(() => parseSubscription(null)).toThrow(StripeShapeError);
  });
});

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: "in_1",
  customer: "cus_1",
  subscription: "sub_1",
  status: "paid",
  billing_reason: "subscription_cycle",
  amount_paid: 14_900,
  currency: "usd",
  livemode: false,
  charge: "ch_1",
  payment_intent: "pi_1",
  status_transitions: { paid_at: 1_762_000_000 },
  lines: {
    data: [
      {
        type: "subscription",
        proration: false,
        period: { start: 1_760_000_000, end: 1_762_592_000 },
      },
    ],
  },
  ...overrides,
});

describe("parseInvoice", () => {
  it("takes the paid period from the regular subscription lines", () => {
    const facts = parseInvoice(invoice());
    expect(facts).toMatchObject({
      id: "in_1",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "paid",
      billingReason: "subscription_cycle",
      amountPaid: 14_900,
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      hasProration: false,
    });
    expect(facts.periodStart).toEqual(new Date(1_760_000_000 * 1000));
    expect(facts.periodEnd).toEqual(new Date(1_762_592_000 * 1000));
  });

  it("ignores proration lines when computing the paid period (a plan-change invoice moves nothing)", () => {
    const facts = parseInvoice(
      invoice({
        billing_reason: "subscription_update",
        lines: {
          data: [
            {
              type: "invoiceitem",
              proration: true,
              period: { start: 1_761_000_000, end: 1_762_592_000 },
            },
            {
              type: "invoiceitem",
              proration: true,
              period: { start: 1_761_000_000, end: 1_762_592_000 },
            },
          ],
        },
      }),
    );
    expect(facts.periodEnd).toBeNull();
    expect(facts.periodStart).toBeNull();
    expect(facts.hasProration).toBe(true);
  });

  it("spans several regular lines", () => {
    const facts = parseInvoice(
      invoice({
        lines: {
          data: [
            {
              type: "subscription",
              proration: false,
              period: { start: 100, end: 200 },
            },
            {
              type: "subscription",
              proration: false,
              period: { start: 150, end: 300 },
            },
          ],
        },
      }),
    );
    expect(facts.periodStart).toEqual(new Date(100_000));
    expect(facts.periodEnd).toEqual(new Date(300_000));
  });

  it("reads the subscription from the newer parent shape too", () => {
    const facts = parseInvoice(
      invoice({
        subscription: undefined,
        parent: { subscription_details: { subscription: "sub_new" } },
      }),
    );
    expect(facts.subscriptionId).toBe("sub_new");
  });

  it("treats a one-off invoice (no subscription) as such", () => {
    expect(
      parseInvoice(invoice({ subscription: null })).subscriptionId,
    ).toBeNull();
  });
});

describe("parseCheckoutSession", () => {
  it("reads a subscription session", () => {
    expect(
      parseCheckoutSession({
        id: "cs_test_abcdefgh",
        mode: "subscription",
        payment_status: "paid",
        status: "complete",
        customer: "cus_1",
        subscription: "sub_1",
        payment_intent: null,
        client_reference_id: "w1",
        metadata: { kind: "subscription" },
        amount_total: 3900,
        currency: "usd",
        livemode: false,
      }),
    ).toMatchObject({
      id: "cs_test_abcdefgh",
      mode: "subscription",
      paymentStatus: "paid",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      paymentIntentId: null,
      clientReferenceId: "w1",
      amountTotal: 3900,
    });
  });
});

describe("parseCharge / parsePaymentIntent / parseDispute", () => {
  it("reads a refunded charge", () => {
    expect(
      parseCharge({
        id: "ch_1",
        amount: 1200,
        amount_refunded: 600,
        refunded: false,
        customer: "cus_1",
        invoice: "in_9",
        payment_intent: "pi_1",
        livemode: false,
      }),
    ).toMatchObject({
      id: "ch_1",
      amount: 1200,
      amountRefunded: 600,
      refunded: false,
      invoiceId: "in_9",
      paymentIntentId: "pi_1",
    });
  });

  it("reads a payment intent with its metadata and latest charge", () => {
    expect(
      parsePaymentIntent({
        id: "pi_1",
        customer: "cus_1",
        metadata: { kind: "pack", pack: "images20", workspaceId: "w1" },
        latest_charge: "ch_1",
        livemode: false,
      }),
    ).toMatchObject({
      id: "pi_1",
      customerId: "cus_1",
      latestChargeId: "ch_1",
      metadata: { kind: "pack", pack: "images20", workspaceId: "w1" },
    });
  });

  it("reads a dispute", () => {
    expect(
      parseDispute({
        id: "dp_1",
        charge: "ch_1",
        status: "needs_response",
        livemode: false,
      }),
    ).toMatchObject({ id: "dp_1", chargeId: "ch_1", status: "needs_response" });
  });
});

describe("parseEventEnvelope", () => {
  const event = (overrides: Record<string, unknown> = {}) => ({
    id: "evt_1Abcdef",
    type: "invoice.paid",
    livemode: false,
    data: { object: { id: "in_1", object: "invoice" } },
    ...overrides,
  });

  it("reads the type and the object the event is about", () => {
    expect(parseEventEnvelope(event())).toEqual({
      id: "evt_1Abcdef",
      type: "invoice.paid",
      livemode: false,
      objectId: "in_1",
      objectType: "invoice",
    });
  });

  it("allows an event without an object id", () => {
    expect(
      parseEventEnvelope(event({ data: { object: { object: "balance" } } }))
        .objectId,
    ).toBeNull();
  });

  it.each([
    { id: "not-an-event" },
    { type: "" },
    { data: undefined },
    null,
    "string",
  ])("rejects a malformed envelope %j", (override) => {
    const raw =
      override && typeof override === "object" ? event(override) : override;
    expect(() => parseEventEnvelope(raw)).toThrow(StripeShapeError);
  });
});

describe("parseSubscriptionList", () => {
  it("parses every item and stamps them with the same read time; rejects a malformed list", () => {
    const started = new Date("2026-10-09T12:00:00.000Z");
    const item = (id: string) => ({
      id,
      customer: "cus_1",
      status: "active",
      livemode: false,
      metadata: {},
      items: { data: [] },
    });
    const list = parseSubscriptionList(
      { data: [item("sub_1"), item("sub_2")] },
      started,
    );
    expect(list.map((sub) => sub.id)).toEqual(["sub_1", "sub_2"]);
    expect(
      list.every((sub) => sub.fetchedAt.getTime() === started.getTime()),
    ).toBe(true);
    expect(parseSubscriptionList({ data: [] })).toEqual([]);
    expect(() => parseSubscriptionList({ nope: true })).toThrow(
      StripeShapeError,
    );
    expect(() => parseSubscriptionList({ data: [{ id: "sub_1" }] })).toThrow(
      StripeShapeError,
    );
  });
});

describe("parseSubscription fetchedAt", () => {
  const raw = {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    livemode: false,
    metadata: {},
    items: { data: [] },
  };

  it("takes the time the caller started reading, and defaults to now", () => {
    const started = new Date("2026-10-09T12:00:00.000Z");
    expect(parseSubscription(raw, started).fetchedAt).toEqual(started);
    const before = Date.now();
    const defaulted = parseSubscription(raw).fetchedAt.getTime();
    expect(defaulted).toBeGreaterThanOrEqual(before);
    expect(defaulted).toBeLessThanOrEqual(Date.now());
  });
});

describe("parseInvoiceList / parseRedirect", () => {
  it("reads the fields the invoices table needs", () => {
    const rows = parseInvoiceList({
      data: [
        {
          id: "in_1",
          number: "ABC-0001",
          created: 1_760_000_000,
          amount_paid: 3900,
          amount_due: 0,
          currency: "usd",
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/x",
          invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
        },
      ],
    });
    expect(rows).toEqual([
      {
        id: "in_1",
        number: "ABC-0001",
        createdAt: new Date(1_760_000_000 * 1000),
        amountPaid: 3900,
        amountDue: 0,
        currency: "usd",
        status: "paid",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/x",
        invoicePdf: "https://pay.stripe.com/invoice/x/pdf",
      },
    ]);
  });

  it("requires a redirect url", () => {
    expect(
      parseRedirect("x", {
        id: "cs_1",
        url: "https://checkout.stripe.com/c/pay/cs_1",
      }),
    ).toEqual({
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });
    expect(() => parseRedirect("x", { id: "cs_1", url: null })).toThrow(
      StripeShapeError,
    );
  });
});

describe("parsePromotionCodeList / parseCoupon", () => {
  const promo = (overrides: Record<string, unknown> = {}) => ({
    id: "promo_1",
    object: "promotion_code",
    code: "SPRING20",
    active: true,
    expires_at: 1_790_000_000,
    max_redemptions: 100,
    times_redeemed: 3,
    customer: null,
    restrictions: { first_time_transaction: true, minimum_amount: 5_000 },
    coupon: {
      id: "coupon_1",
      object: "coupon",
      valid: true,
      percent_off: 20,
      amount_off: null,
      currency: null,
      duration: "repeating",
      duration_in_months: 3,
      redeem_by: null,
    },
    ...overrides,
  });

  it("reads the promotion code with its coupon (API 2024-06-20 shape)", () => {
    const [found] = parsePromotionCodeList({ object: "list", data: [promo()] });
    expect(found).toMatchObject({
      id: "promo_1",
      code: "SPRING20",
      active: true,
      maxRedemptions: 100,
      timesRedeemed: 3,
      firstTimeOnly: true,
      minimumAmount: 5_000,
      customerId: null,
      couponId: "coupon_1",
      coupon: {
        id: "coupon_1",
        valid: true,
        percentOff: 20,
        amountOff: null,
        duration: "repeating",
        durationInMonths: 3,
      },
    });
    expect(found!.expiresAt).toEqual(new Date(1_790_000_000 * 1000));
  });

  it("reads the newer shape that only names the coupon (the caller fetches it)", () => {
    const [found] = parsePromotionCodeList({
      data: [
        promo({
          coupon: undefined,
          promotion: { type: "coupon", coupon: "coupon_9" },
        }),
      ],
    });
    expect(found).toMatchObject({ couponId: "coupon_9", coupon: null });
  });

  it("copes with the optional fields absent", () => {
    const [found] = parsePromotionCodeList({
      data: [{ id: "promo_2", code: "X-1", active: true, coupon: { id: "c" } }],
    });
    expect(found).toMatchObject({
      expiresAt: null,
      maxRedemptions: null,
      timesRedeemed: 0,
      firstTimeOnly: false,
      minimumAmount: null,
      coupon: {
        valid: true,
        duration: "once",
        percentOff: null,
        amountOff: null,
      },
    });
  });

  it("returns an empty list for no match and refuses a malformed row", () => {
    expect(parsePromotionCodeList({ data: [] })).toEqual([]);
    expect(() => parsePromotionCodeList({ data: [{ id: "promo_3" }] })).toThrow(
      StripeShapeError,
    );
    expect(() => parsePromotionCodeList(null)).toThrow(StripeShapeError);
  });

  it("reads a coupon on its own", () => {
    expect(
      parseCoupon({
        id: "c1",
        valid: false,
        amount_off: 1000,
        currency: "usd",
        duration: "forever",
      }),
    ).toMatchObject({
      valid: false,
      amountOff: 1000,
      currency: "usd",
      duration: "forever",
    });
  });
});
