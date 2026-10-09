import { describe, expect, it } from "vitest";

import { StripeApiError, type StripeHttp } from "./client";
import { parseCheckoutSession, parseInvoice } from "./facts";
import { createStripeGateway } from "./gateway";
import { signStripePayload, verifyStripeSignature } from "./signature";

// Gaps found by the mutation review of Faz 4 (stripe layer): each test below fails
// against a one-line mutant that the original suites let through.

describe("signature: the documented five minutes, as a literal", () => {
  const SECRET = "whsec_gap_review_secret";
  const BODY = '{"id":"evt_gapreview"}';
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const at = Math.floor(NOW.getTime() / 1000);
  const verify = (timestamp: number) =>
    verifyStripeSignature({
      rawBody: BODY,
      header: signStripePayload(BODY, SECRET, timestamp),
      secrets: [SECRET],
      now: NOW,
    });

  it("accepts a 299 s old signature and a 299 s future one, rejects 301 s either way (default tolerance)", () => {
    expect(verify(at - 299).ok).toBe(true);
    expect(verify(at + 299).ok).toBe(true);
    expect(verify(at - 301)).toEqual({
      ok: false,
      reason: "timestamp-out-of-tolerance",
    });
    expect(verify(at + 301)).toEqual({
      ok: false,
      reason: "timestamp-out-of-tolerance",
    });
  });
});

describe("parseInvoice: only the regular subscription lines set the paid period", () => {
  const invoice = (lines: unknown[]) =>
    parseInvoice({
      id: "in_1",
      customer: "cus_1",
      subscription: "sub_1",
      status: "paid",
      billing_reason: "subscription_update",
      lines: { data: lines },
    });

  it("a proration line that is typed `subscription` still moves nothing", () => {
    const facts = invoice([
      {
        type: "subscription",
        proration: true,
        period: { start: 1_761_000_000, end: 1_790_000_000 },
      },
    ]);
    expect(facts.periodEnd).toBeNull();
    expect(facts.hasProration).toBe(true);
  });

  it("a one-off invoice item (not a subscription line) moves nothing either", () => {
    const facts = invoice([
      {
        type: "invoiceitem",
        proration: false,
        period: { start: 1_761_000_000, end: 1_790_000_000 },
      },
    ]);
    expect(facts.periodEnd).toBeNull();
  });
});

describe("parseCheckoutSession fails closed", () => {
  it("a session without payment_status is unpaid, never paid", () => {
    expect(
      parseCheckoutSession({ id: "cs_test_abcdefgh", mode: "payment" })
        .paymentStatus,
    ).toBe("unpaid");
  });
});

describe("the gateway's catalog creation", () => {
  const notFound = () =>
    new StripeApiError({
      status: 404,
      code: "resource_missing",
      message: "No such object",
    });
  const input = {
    customerId: "cus_1",
    workspaceId: "w1",
    planKey: "growth" as const,
    interval: "MONTH" as const,
    firstMonth: false,
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
  };

  it("swallows ONLY a lost creation race; any other failure reaches the caller and is retried next time", async () => {
    let productPosts = 0;
    let failWith: Error | null = new StripeApiError({
      status: 500,
      message: "Stripe is down",
    });
    const http: StripeHttp = async (request) => {
      if (
        request.method === "GET" &&
        request.path.startsWith("/v1/products/")
      ) {
        throw notFound();
      }
      if (request.method === "POST" && request.path === "/v1/products") {
        productPosts += 1;
        if (failWith) throw failWith;
        return { id: "agentelse_plan_growth" };
      }
      return { id: "cs_test_abc12345", url: "https://checkout.stripe.com/x" };
    };
    const gateway = createStripeGateway(http);

    await expect(
      gateway.createSubscriptionCheckout(input),
    ).rejects.toBeInstanceOf(StripeApiError);
    // The failure was not remembered as "ensured": the next call tries again.
    failWith = null;
    await expect(
      gateway.createSubscriptionCheckout(input),
    ).resolves.toMatchObject({
      id: "cs_test_abc12345",
    });
    expect(productPosts).toBe(2);
  });
});
