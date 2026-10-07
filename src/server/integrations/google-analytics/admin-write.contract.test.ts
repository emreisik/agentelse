import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleApiError } from "@/server/integrations/google/errors";

import {
  createGaAdminWriter,
  GA_ADMIN_PATHS,
  isGaResourceName,
} from "./admin-write";
import {
  EARLIEST,
  FX_ACCOUNT,
  FX_PROPERTY,
  FX_STREAM,
  FX_TOKEN,
  GA_ADMIN_FIXTURES,
  LATEST,
} from "./admin-write.fixtures";

// Bu dosyanın kanıtladığı (GA-F7, Analytics Admin yazma istemcisi): her yöntem
// Google'a tam olarak fixture'daki isteği yollar (URL, HTTP yöntemi, yalnız
// Bearer başlığı, JSON gövde, updateMask sırası); oluşturma çağrıları 5xx ve
// zaman aşımında tekrar edilmez, PATCH ve DELETE bir kez tekrar edilir;
// biçimi kayan v1alpha yanıtı UNEXPECTED_SHAPE verir; geçersiz kimlik ve kaynak
// adı fetch'ten önce reddedilir; hata sınıfları mevcut katalogdan gelir ve
// sayaçlara yazılır.

const mocks = vi.hoisted(() => ({ recordGaApiOutcome: vi.fn() }));
vi.mock("@/server/website-analytics/api-counters", () => ({
  recordGaApiOutcome: mocks.recordGaApiOutcome,
}));

const fetchMock = vi.fn();
const sleep = vi.fn(async () => undefined);

function writer() {
  return createGaAdminWriter(FX_TOKEN, { sleep, random: () => 0.5 });
}

function json(status: number, body: unknown): Response {
  return new Response(body === null ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function failure(promise: Promise<unknown>): Promise<GoogleApiError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GoogleApiError);
  return error as GoogleApiError;
}

beforeEach(() => {
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "live");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  sleep.mockClear();
  mocks.recordGaApiOutcome.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GA_ADMIN_PATHS", () => {
  it("pins both Admin API roots", () => {
    expect(GA_ADMIN_PATHS).toEqual({
      v1beta: "https://analyticsadmin.googleapis.com/v1beta",
      v1alpha: "https://analyticsadmin.googleapis.com/v1alpha",
    });
  });
});

describe("request contract", () => {
  it.each(GA_ADMIN_FIXTURES.map((fx) => [fx.method, fx] as const))(
    "%s sends exactly the fixture request and parses the answer",
    async (_method, fx) => {
      fetchMock.mockResolvedValueOnce(json(200, fx.response));

      const result = await fx.call(writer());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(fx.request.url);
      expect(url.startsWith(GA_ADMIN_PATHS[fx.api])).toBe(true);
      expect(init.method).toBe(fx.request.http);
      // Yalnız Bearer (+ gövdeli isteklerde Content-Type); başka başlık yok.
      expect(init.headers).toEqual(
        fx.request.body === null
          ? { Authorization: `Bearer ${FX_TOKEN}` }
          : {
              Authorization: `Bearer ${FX_TOKEN}`,
              "Content-Type": "application/json",
            },
      );
      if (fx.request.body === null) {
        expect(init.body).toBeUndefined();
      } else {
        expect(JSON.parse(String(init.body))).toEqual(fx.request.body);
      }
      expect(result).toEqual(fx.expected);
      expect(mocks.recordGaApiOutcome).toHaveBeenCalledTimes(1);
      expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith("ok");
    },
  );

  it("DELETE accepts an empty response body", async () => {
    fetchMock.mockResolvedValueOnce(json(200, null));
    await expect(
      writer().deleteKeyEvent(`properties/${FX_PROPERTY}/keyEvents/11`),
    ).resolves.toBeUndefined();
  });

  it("an empty list answer is an empty list", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await expect(writer().listChannelGroups(FX_PROPERTY)).resolves.toEqual([]);
  });

  it("updateMask follows a stable field order whatever the patch order", async () => {
    const fx = GA_ADMIN_FIXTURES.find(
      (item) => item.method === "updateEnhancedMeasurement",
    );
    expect(fx).toBeDefined();
    fetchMock.mockResolvedValueOnce(json(200, fx!.response));
    await writer().updateEnhancedMeasurement(FX_PROPERTY, FX_STREAM, {
      formInteractionsEnabled: false,
      searchQueryParameter: "q",
      streamEnabled: true,
      outboundClicksEnabled: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.split("?")[1]).toBe(
      "updateMask=streamEnabled,outboundClicksEnabled,formInteractionsEnabled,searchQueryParameter",
    );
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual([
      "streamEnabled",
      "outboundClicksEnabled",
      "formInteractionsEnabled",
      "searchQueryParameter",
    ]);
  });

  it("searchChangeHistory defaults to 100 per page and omits an absent token", async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    const result = await writer().searchChangeHistory({
      accountId: FX_ACCOUNT,
      propertyId: FX_PROPERTY,
      earliest: EARLIEST,
      latest: LATEST,
    });
    expect(result).toEqual({ events: [], nextPageToken: null });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      property: `properties/${FX_PROPERTY}`,
      earliestChangeTime: EARLIEST.toISOString(),
      latestChangeTime: LATEST.toISOString(),
      pageSize: 100,
    });
  });
});

describe("tolerant parsing and drift", () => {
  it("ignores unknown extra fields", async () => {
    const fx = GA_ADMIN_FIXTURES.find((item) => item.method === "createKeyEvent")!;
    fetchMock.mockResolvedValueOnce(
      json(200, { ...(fx.response as object), brandNewField: { a: 1 } }),
    );
    await expect(fx.call(writer())).resolves.toEqual(fx.expected);
  });

  it.each(
    GA_ADMIN_FIXTURES.filter((fx) => fx.drifted !== null).map(
      (fx) => [fx.method, fx] as const,
    ),
  )("%s: a drifted answer throws UNEXPECTED_SHAPE", async (_method, fx) => {
    fetchMock.mockResolvedValueOnce(json(200, fx.drifted));

    const error = await failure(fx.call(writer()));

    expect(error.googleErrorCode).toBe("UNEXPECTED_SHAPE");
    expect(error.errorClass).toBe("UNKNOWN");
    expect(error.message).toBe("Google returned an unexpected response");
    // Biçim kayması da sayaca UNKNOWN olarak yazılır.
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith("UNKNOWN");
  });

  it("an answer that is not an object is drift too", async () => {
    fetchMock.mockResolvedValueOnce(json(200, null));
    const error = await failure(writer().getDataRetention(FX_PROPERTY));
    expect(error.googleErrorCode).toBe("UNEXPECTED_SHAPE");
  });
});

describe("retry behaviour", () => {
  const creates = GA_ADMIN_FIXTURES.filter((fx) => !fx.request.retried);
  const retried = GA_ADMIN_FIXTURES.filter(
    (fx) => fx.request.retried && fx.request.http !== "GET",
  );

  it("covers every create call", () => {
    expect(creates.map((fx) => fx.method).sort()).toEqual([
      "createAnnotation",
      "createChannelGroup",
      "createKeyEvent",
    ]);
  });

  it.each(creates.map((fx) => [fx.method, fx] as const))(
    "%s is NOT retried after a 503",
    async (_method, fx) => {
      fetchMock.mockResolvedValue(json(503, { error: { status: "UNAVAILABLE" } }));
      const error = await failure(fx.call(writer()));
      expect(error.errorClass).toBe("SERVER_ERROR");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each(creates.map((fx) => [fx.method, fx] as const))(
    "%s is NOT retried after a timeout",
    async (_method, fx) => {
      fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      const error = await failure(fx.call(writer()));
      expect(error.errorClass).toBe("TRANSIENT");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(retried.map((fx) => [fx.method, fx] as const))(
    "%s is retried once after a 503",
    async (_method, fx) => {
      fetchMock
        .mockResolvedValueOnce(json(503, { error: { status: "UNAVAILABLE" } }))
        .mockResolvedValueOnce(json(200, fx.response));
      await fx.call(writer());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      const calls = fetchMock.mock.calls as [string, RequestInit][];
      expect(calls[1]?.[0]).toBe(calls[0]?.[0]);
      expect(calls[1]?.[1].body).toBe(calls[0]?.[1].body);
    },
  );

  it("a second 503 on PATCH gives up (one retry only)", async () => {
    fetchMock.mockResolvedValue(json(503, { error: { status: "UNAVAILABLE" } }));
    await failure(writer().updateDataRetention(FX_PROPERTY, "FOURTEEN_MONTHS"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("path guards (nothing is sent)", () => {
  const BAD_IDS = [
    "",
    "../1",
    "12/../3",
    "12 3",
    "abc",
    "1?x=1",
    "1#",
    "https://evil.example/1",
    "1/keyEvents",
    "-1",
  ];

  it.each(BAD_IDS)("rejects property id %j", async (bad) => {
    const w = writer();
    await failure(w.listKeyEvents(bad));
    await failure(w.createKeyEvent(bad, "generate_lead"));
    await failure(w.getDataRetention(bad));
    await failure(w.updateDataRetention(bad, "FOURTEEN_MONTHS"));
    await failure(w.listChannelGroups(bad));
    await failure(w.listAnnotations(bad));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordGaApiOutcome).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("rejects stream id %j", async (bad) => {
    await failure(writer().getEnhancedMeasurement(FX_PROPERTY, bad));
    await failure(
      writer().updateEnhancedMeasurement(FX_PROPERTY, bad, {
        scrollsEnabled: true,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(BAD_IDS)("rejects account id %j", async (bad) => {
    await failure(
      writer().searchChangeHistory({
        accountId: bad,
        propertyId: FX_PROPERTY,
        earliest: EARLIEST,
        latest: LATEST,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const BAD_NAMES = [
    "",
    "../properties/1/keyEvents/2",
    "properties/1/keyEvents/../../x",
    "properties/1/keyEvents/2/extra",
    "properties/1/keyEvents/2?x=1",
    "properties/1/keyEvents/",
    "https://analyticsadmin.googleapis.com/v1beta/properties/1/keyEvents/2",
    "//evil.example/properties/1/keyEvents/2",
    "properties/abc/keyEvents/2",
    "properties/1/dataStreams/2",
    "properties/1/dataRetentionSettings",
    "accounts/1",
  ];

  it.each(BAD_NAMES)("rejects resource name %j for every delete", async (bad) => {
    const w = writer();
    for (const run of [
      () => w.deleteKeyEvent(bad),
      () => w.deleteChannelGroup(bad),
      () => w.deleteAnnotation(bad),
    ]) {
      const error = await failure(run());
      expect(error.errorClass).toBe("VALIDATION");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a delete accepts only its own collection", async () => {
    const w = writer();
    await failure(w.deleteKeyEvent(`properties/${FX_PROPERTY}/channelGroups/1`));
    await failure(
      w.deleteChannelGroup(`properties/${FX_PROPERTY}/reportingDataAnnotations/1`),
    );
    await failure(w.deleteAnnotation(`properties/${FX_PROPERTY}/keyEvents/1`));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isGaResourceName accepts the three known collections only", () => {
    expect(isGaResourceName("properties/1/keyEvents/2")).toBe(true);
    expect(isGaResourceName("properties/1/channelGroups/abc_-9")).toBe(true);
    expect(isGaResourceName("properties/1/reportingDataAnnotations/3")).toBe(true);
    expect(isGaResourceName("properties/1/dataStreams/3")).toBe(false);
    expect(isGaResourceName("properties/1/keyEvents/3/")).toBe(false);
  });

  it("rejects bad payloads before sending", async () => {
    const w = writer();
    await failure(w.createKeyEvent(FX_PROPERTY, "bad name"));
    await failure(w.createKeyEvent(FX_PROPERTY, "1starts_with_digit"));
    await failure(w.updateDataRetention(FX_PROPERTY, "FOURTEEN MONTHS"));
    await failure(w.updateEnhancedMeasurement(FX_PROPERTY, FX_STREAM, {}));
    await failure(
      w.createAnnotation(FX_PROPERTY, {
        title: "x",
        description: "",
        day: "2026-02-30",
        color: "BLUE",
      }),
    );
    await failure(
      w.searchChangeHistory({
        accountId: FX_ACCOUNT,
        propertyId: FX_PROPERTY,
        earliest: new Date("nope"),
        latest: LATEST,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("error mapping through the catalog", () => {
  const cases: {
    name: string;
    status: number;
    body: unknown;
    errorClass: string;
  }[] = [
    {
      name: "403 insufficient scopes",
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Request had insufficient authentication scopes.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
        },
      },
      errorClass: "SCOPE_MISSING",
    },
    {
      name: "403 permission denied",
      status: 403,
      body: { error: { code: 403, message: "No access", status: "PERMISSION_DENIED" } },
      errorClass: "PERMISSION",
    },
    {
      name: "404",
      status: 404,
      body: { error: { code: 404, message: "gone", status: "NOT_FOUND" } },
      errorClass: "NOT_FOUND",
    },
    {
      name: "400",
      status: 400,
      body: { error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } },
      errorClass: "VALIDATION",
    },
    {
      name: "429",
      status: 429,
      body: { error: { code: 429, message: "slow", status: "RESOURCE_EXHAUSTED" } },
      errorClass: "RATE_LIMIT",
    },
    {
      name: "401",
      status: 401,
      body: { error: { code: 401, message: "no", status: "UNAUTHENTICATED" } },
      errorClass: "AUTH",
    },
  ];

  it.each(cases)("$name => $errorClass", async ({ status, body, errorClass }) => {
    fetchMock.mockResolvedValueOnce(json(status, body));
    const error = await failure(writer().listKeyEvents(FX_PROPERTY));
    expect(error.errorClass).toBe(errorClass);
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledTimes(1);
    expect(mocks.recordGaApiOutcome).toHaveBeenCalledWith(errorClass);
    // Sınıf tekrar bütçesi 0: tek istek.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("409 on create stays a 409 for the caller", async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, {
        error: { code: 409, message: "exists", status: "ALREADY_EXISTS" },
      }),
    );
    const error = await failure(writer().createKeyEvent(FX_PROPERTY, "generate_lead"));
    expect(error.httpStatus).toBe(409);
    expect(error.googleErrorCode).toBe("ALREADY_EXISTS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 404 on delete surfaces as NOT_FOUND", async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { error: { code: 404, message: "gone", status: "NOT_FOUND" } }),
    );
    const error = await failure(
      writer().deleteAnnotation(`properties/${FX_PROPERTY}/reportingDataAnnotations/3`),
    );
    expect(error.errorClass).toBe("NOT_FOUND");
    expect(error.httpStatus).toBe(404);
  });
});
