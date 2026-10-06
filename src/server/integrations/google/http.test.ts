import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleApiError } from "./errors";
import { googleFetchJson } from "./http";

// Bu dosyanın kanıtladığı: Google hata gövdeleri (OAuth, yeni API biçimi,
// eski `errors[]` biçimi) doğru sınıflanır; tekrar yalnız güvenli
// durumlarda ve sınırlı sayıda yapılır.

const fetchMock = vi.fn();
const sleep = vi.fn(async () => undefined);
const options = { sleep, random: () => 0.5 };

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  sleep.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<GoogleApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GoogleApiError);
  return error as GoogleApiError;
}

describe("error bodies", () => {
  it("reads an OAuth error", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
    );
    const error = await failure(
      googleFetchJson("https://oauth2.googleapis.com/token", {}, options),
    );
    expect(error.googleErrorCode).toBe("invalid_grant");
    expect(error.errorClass).toBe("AUTH");
    expect(error.message).toBe("Token has been expired or revoked.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an API error with ErrorInfo details", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            },
          ],
        },
      }),
    );
    const error = await failure(
      googleFetchJson("https://analyticsdata.googleapis.com/x", {}, options),
    );
    expect(error.googleErrorCode).toBe("PERMISSION_DENIED");
    expect(error.reason).toBe("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    expect(error.errorClass).toBe("SCOPE_MISSING");
  });

  it("reads the legacy errors[] shape Search Console uses", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: {
          code: 403,
          message:
            "User does not have sufficient permission for site 'sc-domain:example.com'.",
          errors: [{ domain: "global", reason: "forbidden" }],
        },
      }),
    );
    const error = await failure(
      googleFetchJson("https://searchconsole.googleapis.com/x", {}, options),
    );
    expect(error.errorClass).toBe("PERMISSION");
    expect(error.httpStatus).toBe(403);
  });

  it("returns null for an empty successful body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(
      googleFetchJson("https://oauth2.googleapis.com/revoke", {}, options),
    ).resolves.toBeNull();
  });
});

describe("retries", () => {
  it("retries a transient network failure twice", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(
      googleFetchJson("https://x.googleapis.com", {}, options),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 8_000);
  });

  it("retries a server error only once (GA4 counts them per hour)", async () => {
    // Her çağrıya yeni bir Response (gövde bir kez okunabilir).
    fetchMock.mockImplementation(async () =>
      json(503, { error: { code: 503, status: "UNAVAILABLE", message: "x" } }),
    );
    const error = await failure(
      googleFetchJson("https://x.googleapis.com", {}, options),
    );
    expect(error.errorClass).toBe("SERVER_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a client error", async () => {
    fetchMock.mockResolvedValue(
      json(400, {
        error: { code: 400, status: "INVALID_ARGUMENT", message: "bad metric" },
      }),
    );
    await failure(googleFetchJson("https://x.googleapis.com", {}, options));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a single-use call such as the code exchange", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await failure(
      googleFetchJson(
        "https://oauth2.googleapis.com/token",
        {},
        { ...options, retry: false },
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours a short Retry-After and gives up on a long one", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          503,
          { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
          { "Retry-After": "3" },
        ),
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    await googleFetchJson("https://x.googleapis.com", {}, options);
    expect(sleep).toHaveBeenCalledWith(3_000);

    fetchMock.mockReset();
    sleep.mockClear();
    fetchMock.mockResolvedValueOnce(
      json(
        503,
        { error: { code: 503, status: "UNAVAILABLE", message: "x" } },
        { "Retry-After": "120" },
      ),
    );
    await failure(googleFetchJson("https://x.googleapis.com", {}, options));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
