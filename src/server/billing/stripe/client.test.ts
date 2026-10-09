import { describe, expect, it, vi } from "vitest";

import {
  STRIPE_API_VERSION,
  StripeApiError,
  StripeNetworkError,
  createStripeHttp,
} from "./client";

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const noSleep = async () => undefined;

function client(fetchImpl: typeof fetch, extra: object = {}) {
  return createStripeHttp({
    secretKey: "sk_test_abcdefgh12345678",
    fetchImpl,
    sleep: noSleep,
    ...extra,
  });
}

describe("createStripeHttp", () => {
  it("sends the pinned API version, the bearer key, and a form body with an idempotency key on POST", async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: "cus_1" }));
    const http = client(fetchImpl as unknown as typeof fetch);

    const result = await http({
      method: "POST",
      path: "/v1/customers",
      body: { metadata: { workspaceId: "w1" } },
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ id: "cus_1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.stripe.com/v1/customers");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("metadata[workspaceId]=w1");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_abcdefgh12345678");
    expect(headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
    expect(headers["Idempotency-Key"]).toBe("key-1");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("puts GET parameters in the query string and sends no body or idempotency key", async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: "sub_1" }));
    const http = client(fetchImpl as unknown as typeof fetch);

    await http({
      method: "GET",
      path: "/v1/subscriptions/sub_1",
      query: { expand: ["latest_invoice"] },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.stripe.com/v1/subscriptions/sub_1?expand[0]=latest_invoice",
    );
    expect(init.body).toBeUndefined();
    expect(
      (init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeUndefined();
  });

  it("turns an error response into a StripeApiError carrying code, type, param and request id", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        402,
        {
          error: {
            type: "card_error",
            code: "card_declined",
            param: "payment_method",
            message: "Your card was declined.",
          },
        },
        { "request-id": "req_abc" },
      ),
    );
    const http = client(fetchImpl as unknown as typeof fetch);

    const error = await http({ method: "GET", path: "/v1/x" }).catch((e) => e);

    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({
      status: 402,
      code: "card_declined",
      type: "card_error",
      param: "payment_method",
      requestId: "req_abc",
    });
    // A 4xx is final: never retried.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recognises a missing resource", async () => {
    const http = client((async () =>
      json(404, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such x",
        },
      })) as unknown as typeof fetch);
    const error = await http({ method: "GET", path: "/v1/x" }).catch((e) => e);
    expect((error as StripeApiError).isNotFound).toBe(true);
  });

  it("retries a 5xx on a POST that has an idempotency key, with the SAME key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(503, { error: { message: "down" } }))
      .mockResolvedValueOnce(json(200, { id: "ok" }));
    const http = client(fetchImpl as unknown as typeof fetch);

    const result = await http({
      method: "POST",
      path: "/v1/x",
      body: {},
      idempotencyKey: "same",
    });

    expect(result).toEqual({ id: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const keys = fetchImpl.mock.calls.map(
      ([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toEqual(["same", "same"]);
  });

  it("never retries a POST without an idempotency key (it could charge twice)", async () => {
    const fetchImpl = vi.fn(async () =>
      json(503, { error: { message: "down" } }),
    );
    const http = client(fetchImpl as unknown as typeof fetch);

    await expect(
      http({ method: "POST", path: "/v1/x", body: {} }),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fetchImpl = vi.fn(async () =>
      json(500, { error: { message: "boom" } }),
    );
    const http = client(fetchImpl as unknown as typeof fetch, {
      maxRetries: 2,
    });

    await expect(http({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(
      StripeApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("respects Stripe-Should-Retry: false", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        500,
        { error: { message: "no" } },
        { "stripe-should-retry": "false" },
      ),
    );
    const http = client(fetchImpl as unknown as typeof fetch);

    await expect(http({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(
      StripeApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure and reports StripeNetworkError when it persists", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const http = client(fetchImpl as unknown as typeof fetch, {
      maxRetries: 1,
    });

    await expect(http({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(
      StripeNetworkError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not leak the secret key into an error message", async () => {
    const http = client((async () =>
      json(401, {
        error: {
          type: "invalid_request_error",
          message: "Invalid API Key provided: sk_test_****5678",
        },
      })) as unknown as typeof fetch);
    const error = (await http({ method: "GET", path: "/v1/x" }).catch(
      (e) => e,
    )) as Error;
    expect(error.message).not.toContain("abcdefgh12345678");
  });
});
