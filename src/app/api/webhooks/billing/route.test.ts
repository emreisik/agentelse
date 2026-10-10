import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/ads/webhooks";
import { signStripePayload } from "@/server/billing/stripe/signature";

const SECRET = "whsec_current_secret_value";
const PREVIOUS = "whsec_previous_secret_value";

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

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_1TestEvent",
    type: "invoice.paid",
    livemode: false,
    data: { object: { id: "in_1", object: "invoice" } },
    ...overrides,
  });

function request(
  body: string,
  header: string | null,
  extra: Record<string, string> = {},
) {
  return new Request("https://app.test/api/webhooks/billing", {
    method: "POST",
    body,
    headers: {
      ...(header ? { "stripe-signature": header } : {}),
      ...extra,
    },
  });
}

const signed = (
  body: string,
  secret = SECRET,
  at = Math.floor(Date.now() / 1000),
) => signStripePayload(body, secret, at);

beforeEach(() => {
  vi.clearAllMocks();
  state.config = {
    secretKey: "sk_test_abcdefgh12345678",
    webhookSecrets: [SECRET, PREVIOUS],
    mode: "test",
  };
  processStripeEvent.mockResolvedValue({ result: "processed" });
});

describe("POST /api/webhooks/billing", () => {
  it("answers 503 when payments are not configured, so Stripe keeps the event and retries", async () => {
    state.config = null;
    const body = event();

    const response = await POST(request(body, signed(body)));

    expect(response.status).toBe(503);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before reading it", async () => {
    const response = await POST(
      request("{}", signed("{}"), {
        "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("rejects a body that grows past the limit even if Content-Length lied", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 10);

    const response = await POST(
      request(big, signed(big), { "content-length": "10" }),
    );

    expect(response.status).toBe(413);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["no signature", null],
    ["a malformed signature", "nonsense"],
    ["a signature from another secret", "WRONG"],
    ["a stale signature", "STALE"],
  ])("answers 401 for %s and never touches the event", async (_name, kind) => {
    const body = event();
    const header =
      kind === "WRONG"
        ? signed(body, "whsec_someone_elses_secret")
        : kind === "STALE"
          ? signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600)
          : kind;

    const response = await POST(request(body, header));

    expect(response.status).toBe(401);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("does not read the body of a request that carries no signature at all", async () => {
    const unsigned = request(event(), null);

    const response = await POST(unsigned);

    expect(response.status).toBe(401);
    expect(unsigned.bodyUsed).toBe(false);
    // Even an oversized claim gets the cheap answer first.
    const big = request("{}", null, {
      "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect((await POST(big)).status).toBe(401);
  });

  it("does not read the body when the header is junk or stale either: a made-up header buys no 512 KB buffer", async () => {
    const body = event();
    const stale = signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600);
    for (const header of [
      "x",
      "t=abc,v1=zz",
      "v1=" + "a".repeat(64), // no timestamp
      `t=${Math.floor(Date.now() / 1000)}`, // no signature
      `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(63)}`, // too short
      stale, // well formed, but a replay
    ]) {
      const junk = request(body, header);

      const response = await POST(junk);

      expect(response.status, header).toBe(401);
      expect(junk.bodyUsed, header).toBe(false);
    }
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("a well-formed header with the wrong signature is still checked against the body (and refused)", async () => {
    const body = event();
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`;
    const attempt = request(body, forged);

    const response = await POST(attempt);

    expect(response.status).toBe(401);
    expect(attempt.bodyUsed).toBe(true);
  });

  it("rejects a body changed after it was signed", async () => {
    const body = event();
    const header = signed(body);

    const response = await POST(
      request(body.replace("invoice.paid", "invoice.voided"), header),
    );

    expect(response.status).toBe(401);
  });

  it("answers 400 for a signed body that is not a valid event", async () => {
    const notJson = "not json at all";
    const noType = JSON.stringify({ id: "evt_1TestEvent", data: {} });

    expect((await POST(request(notJson, signed(notJson)))).status).toBe(400);
    expect((await POST(request(noType, signed(noType)))).status).toBe(400);
    expect(processStripeEvent).not.toHaveBeenCalled();
  });

  it("hands a valid event to the processor with the running mode and answers 200", async () => {
    const body = event();

    const response = await POST(request(body, signed(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      result: "processed",
    });
    expect(processStripeEvent).toHaveBeenCalledTimes(1);
    const [envelope, deps] = processStripeEvent.mock.calls[0]!;
    expect(envelope).toMatchObject({
      id: "evt_1TestEvent",
      type: "invoice.paid",
      objectId: "in_1",
    });
    expect(deps).toMatchObject({ mode: "test" });
  });

  it("accepts the previous secret while a secret is being rolled", async () => {
    const body = event();

    const response = await POST(request(body, signed(body, PREVIOUS)));

    expect(response.status).toBe(200);
  });

  it("answers 500 when processing fails (Stripe retries) without leaking the reason", async () => {
    processStripeEvent.mockRejectedValue(new Error("db password is hunter2"));
    const body = event();

    const response = await POST(request(body, signed(body)));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });
});
