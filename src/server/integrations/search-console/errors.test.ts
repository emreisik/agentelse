import { describe, expect, it } from "vitest";

import {
  GoogleApiError,
  googleErrorFromResponse,
} from "@/server/integrations/google/errors";

import loadQuota from "./__fixtures__/error-load-quota.json";
import permission from "./__fixtures__/error-permission.json";
import rateLimit from "./__fixtures__/error-rate-limit.json";
import validation from "./__fixtures__/error-validation.json";
import { gscQuotaKind, isGscValidationError } from "./errors";

// Bu dosyanın kanıtladığı: kayıtlı Google hata gövdelerinden LOAD, RATE ve
// DAILY ayrılır; yetki ve doğrulama hataları kota sayılmaz; doğrulama
// hatası yalnız 400 gövdesinde tanınır.

const errors = {
  load: googleErrorFromResponse(429, loadQuota),
  rate: googleErrorFromResponse(429, rateLimit),
  permission: googleErrorFromResponse(403, permission),
  validation: googleErrorFromResponse(400, validation),
  daily: googleErrorFromResponse(429, {
    error: {
      code: 429,
      message:
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'searchconsole.googleapis.com'.",
      status: "RESOURCE_EXHAUSTED",
    },
  }),
};

describe("gscQuotaKind", () => {
  it("tells LOAD, RATE and DAILY apart", () => {
    expect(errors.load.errorClass).toBe("RATE_LIMIT");
    expect(gscQuotaKind(errors.load)).toBe("LOAD");
    expect(gscQuotaKind(errors.rate)).toBe("RATE");
    expect(errors.daily.errorClass).toBe("QUOTA_DAILY");
    expect(gscQuotaKind(errors.daily)).toBe("DAILY");
  });

  it("is null for other errors", () => {
    expect(gscQuotaKind(errors.permission)).toBeNull();
    expect(gscQuotaKind(errors.validation)).toBeNull();
    expect(gscQuotaKind(new Error("load quota exceeded"))).toBeNull();
    expect(gscQuotaKind(null)).toBeNull();
    expect(
      gscQuotaKind(
        new GoogleApiError("Too many downloads", "RESOURCE_EXHAUSTED", {
          httpStatus: 429,
        }),
      ),
    ).toBe("RATE");
  });
});

describe("isGscValidationError", () => {
  it("is true only for the 400 body", () => {
    expect(isGscValidationError(errors.validation)).toBe(true);
    expect(isGscValidationError(errors.load)).toBe(false);
    expect(isGscValidationError(errors.rate)).toBe(false);
    expect(isGscValidationError(errors.permission)).toBe(false);
    expect(isGscValidationError(new Error("invalid"))).toBe(false);
  });
});
