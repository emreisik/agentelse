import { beforeEach, describe, expect, it, vi } from "vitest";

import { signStripePayload } from "@/server/billing/stripe/signature";

// The route hands the processor the mode of the key it runs with. route.test.ts only
// runs a test-mode key, so a route that always said "test" would pass it and would
// make every live event look like the other mode's (livemode-mismatch -> ignored).

const SECRET = "whsec_live_route_secret";
const state = vi.hoisted(() => ({
  config: null as null | {
    secretKey: string;
    webhookSecrets: string[];
    mode: "test" | "live";
  },
}));
const processStripeEvent = vi.hoisted(() => vi.fn());

vi.mock("@/server/billing/stripe/config", () => ({
  getStripeConfig: () => state.config,
}));
vi.mock("@/server/billing/payments/events", () => ({ processStripeEvent }));

const { POST } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  processStripeEvent.mockResolvedValue({ result: "processed" });
});

describe("POST /api/webhooks/billing with a live key", () => {
  it.each(["live", "test"] as const)("passes mode %s through", async (mode) => {
    state.config = {
      secretKey: `sk_${mode}_abcdefgh12345678`,
      webhookSecrets: [SECRET],
      mode,
    };
    const body = JSON.stringify({
      id: "evt_1LiveEvent",
      type: "invoice.paid",
      livemode: mode === "live",
      data: { object: { id: "in_1" } },
    });

    const response = await POST(
      new Request("https://app.test/api/webhooks/billing", {
        method: "POST",
        body,
        headers: {
          "stripe-signature": signStripePayload(
            body,
            SECRET,
            Math.floor(Date.now() / 1000),
          ),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(processStripeEvent.mock.calls[0]![1]).toMatchObject({ mode });
  });
});
