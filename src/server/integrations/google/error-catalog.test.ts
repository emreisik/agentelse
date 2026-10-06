import { describe, expect, it } from "vitest";

import {
  classifyGoogleError,
  googleClassDegradesProvider,
  googleErrorCode,
  googleErrorUserMessage,
  googleRetryBudget,
  parseGoogleErrorCode,
  type GoogleErrorClass,
  type GoogleErrorSignal,
} from "./error-catalog";

// Bu dosyanın kanıtladığı: Google hataları metinle değil kod, durum ve
// `reason` ile sınıflanır; yalnız Google'ın kendi arızası paylaşılan
// sağlığı düşürür ve kör tekrar yalnız güvenli durumlarda yapılır.

describe("classifyGoogleError", () => {
  const cases: Array<[string, GoogleErrorSignal, GoogleErrorClass]> = [
    ["zaman aşımı", { timedOut: true }, "TRANSIENT"],
    ["ağ hatası", { network: true }, "TRANSIENT"],
    [
      "refresh'te invalid_grant",
      { httpStatus: 400, code: "invalid_grant" },
      "AUTH",
    ],
    [
      "yanlış istemci sırrı",
      { httpStatus: 401, code: "invalid_client" },
      "API_DISABLED",
    ],
    ["401", { httpStatus: 401, code: "UNAUTHENTICATED" }, "AUTH"],
    [
      "izin kapsamı yetersiz (ErrorInfo)",
      {
        httpStatus: 403,
        code: "PERMISSION_DENIED",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
      },
      "SCOPE_MISSING",
    ],
    [
      "izin kapsamı yetersiz (yalnız metin)",
      {
        httpStatus: 403,
        message: "Request had insufficient authentication scopes.",
      },
      "SCOPE_MISSING",
    ],
    [
      "API kapalı",
      {
        httpStatus: 403,
        code: "PERMISSION_DENIED",
        reason: "SERVICE_DISABLED",
      },
      "API_DISABLED",
    ],
    [
      "eski biçimde 403 ile gelen kota",
      { httpStatus: 403, reason: "rateLimitExceeded" },
      "RATE_LIMIT",
    ],
    [
      "eski biçimde günlük sınır",
      { httpStatus: 403, reason: "dailyLimitExceeded" },
      "QUOTA_DAILY",
    ],
    [
      "429 saatlik",
      {
        httpStatus: 429,
        code: "RESOURCE_EXHAUSTED",
        message: "Exhausted property tokens per hour",
      },
      "RATE_LIMIT",
    ],
    [
      "429 günlük",
      {
        httpStatus: 429,
        code: "RESOURCE_EXHAUSTED",
        message: "Exhausted property tokens per day",
      },
      "QUOTA_DAILY",
    ],
    [
      "mülkte rol yok",
      {
        httpStatus: 403,
        code: "PERMISSION_DENIED",
        message: "User does not have sufficient permissions for this property.",
      },
      "PERMISSION",
    ],
    [
      "Search Console sitesinde yetki yok",
      { httpStatus: 403, reason: "forbidden" },
      "PERMISSION",
    ],
    ["mülk silinmiş", { httpStatus: 404, code: "NOT_FOUND" }, "NOT_FOUND"],
    [
      "uyumsuz metrik",
      { httpStatus: 400, code: "INVALID_ARGUMENT" },
      "VALIDATION",
    ],
    ["500", { httpStatus: 500, code: "INTERNAL" }, "SERVER_ERROR"],
    ["503", { httpStatus: 503, code: "UNAVAILABLE" }, "SERVER_ERROR"],
    ["502", { httpStatus: 502 }, "TRANSIENT"],
    ["bilinmeyen", { httpStatus: 418 }, "UNKNOWN"],
  ];

  it.each(cases)("%s", (_label, signal, expected) => {
    expect(classifyGoogleError(signal)).toBe(expected);
  });
});

describe("provider health and retries", () => {
  it("only Google-wide problems degrade the shared provider", () => {
    expect(googleClassDegradesProvider("TRANSIENT")).toBe(true);
    expect(googleClassDegradesProvider("SERVER_ERROR")).toBe(true);
    expect(googleClassDegradesProvider("API_DISABLED")).toBe(true);
    for (const tenantClass of [
      "AUTH",
      "SCOPE_MISSING",
      "PERMISSION",
      "NOT_FOUND",
      "RATE_LIMIT",
      "QUOTA_DAILY",
      "VALIDATION",
    ] as const) {
      expect(googleClassDegradesProvider(tenantClass)).toBe(false);
    }
  });

  it("retries only transient failures, server errors once", () => {
    expect(googleRetryBudget("TRANSIENT")).toBe(2);
    expect(googleRetryBudget("SERVER_ERROR")).toBe(1);
    expect(googleRetryBudget("VALIDATION")).toBe(0);
    expect(googleRetryBudget("RATE_LIMIT")).toBe(0);
    expect(googleRetryBudget("AUTH")).toBe(0);
  });

  it("round-trips the structured error code and ignores other providers' codes", () => {
    expect(parseGoogleErrorCode(googleErrorCode("PERMISSION"))).toBe(
      "PERMISSION",
    );
    expect(parseGoogleErrorCode("META:AUTH:190")).toBeNull();
    expect(parseGoogleErrorCode("GOOGLE:NOPE")).toBeNull();
    expect(parseGoogleErrorCode(null)).toBeNull();
  });
});

describe("googleErrorUserMessage", () => {
  it("names the service and what was lost", () => {
    expect(googleErrorUserMessage("PERMISSION", "analytics")).toBe(
      "Your Google account no longer has access to this Google Analytics property.",
    );
    expect(googleErrorUserMessage("NOT_FOUND", "search_console")).toBe(
      "This Google Search Console site no longer exists.",
    );
    expect(googleErrorUserMessage("SCOPE_MISSING", "analytics")).toContain(
      "Reconnect and tick the box",
    );
  });

  it("leaves unknown errors to Google's own message", () => {
    expect(googleErrorUserMessage("UNKNOWN", "analytics")).toBeNull();
    expect(googleErrorUserMessage("VALIDATION", "search_console")).toBeNull();
  });
});
