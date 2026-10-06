import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock("@/server/ads/webhooks", () => ({ AdsWebhookInbox: inbox }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    META_APP_SECRET: "app-secret",
    META_ADS_WEBHOOK_VERIFY_TOKEN: "verify-me",
  }),
}));

import { GET, POST } from "./route";

const URL_BASE = "https://agentelse.test/api/webhooks/meta-ads";
const body = JSON.stringify({
  object: "ad_account",
  entry: [
    {
      id: "123",
      time: 1791300000,
      changes: [
        {
          field: "with_issues_ad_objects",
          value: { ad_object_id: "555", ad_object_type: "AD" },
        },
      ],
    },
  ],
});

function signed(payload: string, secret = "app-secret"): Request {
  return new Request(URL_BASE, {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
  });
}

describe("Meta Ads webhook endpoint (docs/meta-ads-plan.md F7)", () => {
  beforeEach(() => {
    inbox.store.mockReset();
    inbox.store.mockResolvedValue(1);
    process.env.META_ADS_WEBHOOKS = "true";
  });
  afterEach(() => {
    delete process.env.META_ADS_WEBHOOKS;
  });

  it("answers Meta's verification only with the right token", async () => {
    const ok = await GET(
      new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    const wrong = await GET(
      new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`),
    );
    expect(wrong.status).toBe(403);
  });

  it("rejects an unsigned or wrongly signed request without storing anything", async () => {
    const unsigned = await POST(new Request(URL_BASE, { method: "POST", body }));
    const forged = await POST(signed(body, "someone-else"));
    expect(unsigned.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(inbox.store).not.toHaveBeenCalled();
  });

  it("stores the parsed events of a signed request and answers 200 at once", async () => {
    const response = await POST(signed(body));
    expect(response.status).toBe(200);
    expect(inbox.store).toHaveBeenCalledWith([
      expect.objectContaining({
        adAccountExternalId: "act_123",
        field: "with_issues_ad_objects",
        objectExternalId: "555",
        objectLevel: "AD",
        dedupeKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("acknowledges but ignores events while the flag is off", async () => {
    delete process.env.META_ADS_WEBHOOKS;
    const response = await POST(signed(body));
    expect(response.status).toBe(200);
    expect(inbox.store).not.toHaveBeenCalled();
  });

  it("asks Meta to retry when storing fails, and refuses oversized bodies", async () => {
    inbox.store.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(signed(body))).status).toBe(500);
    const big = await POST(
      new Request(URL_BASE, {
        method: "POST",
        body: "x",
        headers: { "content-length": String(10 * 1024 * 1024) },
      }),
    );
    expect(big.status).toBe(413);
  });
});
