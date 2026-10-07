import { describe, expect, it } from "vitest";

import { GoogleApiError, googleErrorFromResponse } from "../errors";
import {
  BQ_ERROR_TEXT,
  BigQueryError,
  classifyBigQueryError,
  type BqErrorCode,
} from "./errors";

// Bu dosyanın kanıtladığı: Google hataları HTTP durumu ve reason ile sabit
// kodlara çevrilir, geçici hatalar zaman aşımı olur ve ham Google mesajı
// hiçbir yerde saklanmaz.

function failure(
  httpStatus: number,
  reason: string | null,
  message: string,
): GoogleApiError {
  return googleErrorFromResponse(httpStatus, {
    error: {
      code: httpStatus,
      message,
      errors: reason ? [{ reason, message }] : [],
    },
  });
}

describe("classifyBigQueryError", () => {
  const table: [string, GoogleApiError, BqErrorCode][] = [
    ["401", failure(401, null, "Invalid Credentials"), "SA_AUTH"],
    [
      "403 accessDenied",
      failure(403, "accessDenied", "Access Denied: Dataset x"),
      "NO_ACCESS",
    ],
    [
      "403 permission text",
      failure(403, null, "Permission bigquery.jobs.create denied"),
      "NO_ACCESS",
    ],
    [
      "403 billingNotEnabled",
      failure(403, "billingNotEnabled", "Access Denied: billing disabled"),
      "BILLING_DISABLED",
    ],
    [
      "403 dataset named billing_export is still NO_ACCESS",
      failure(403, "accessDenied", "Access Denied: Dataset p:billing_export"),
      "NO_ACCESS",
    ],
    [
      "403 billing text without a reason",
      failure(403, null, "Billing has not been enabled for this project"),
      "BILLING_DISABLED",
    ],
    [
      "403 rateLimitExceeded",
      failure(403, "rateLimitExceeded", "Exceeded rate limits"),
      "RATE_LIMIT",
    ],
    ["429", failure(429, null, "Too many requests"), "RATE_LIMIT"],
    ["404", failure(404, "notFound", "Not found: Dataset p:d"), "NOT_FOUND"],
    [
      "400 bytesBilledLimitExceeded",
      failure(400, "bytesBilledLimitExceeded", "Query exceeded limit"),
      "COST_CAP",
    ],
    [
      "400 bytes billed text",
      failure(400, null, "Query exceeded limit for bytes billed: 10"),
      "COST_CAP",
    ],
    [
      "400 invalidQuery",
      failure(400, "invalidQuery", "Syntax error near x"),
      "INVALID_QUERY",
    ],
    [
      "TRANSIENT (timeout)",
      new GoogleApiError("timed out", undefined, { timedOut: true }),
      "TIMEOUT",
    ],
    ["502", failure(502, null, "Bad gateway"), "TIMEOUT"],
    ["503", failure(503, null, "Service unavailable"), "UNAVAILABLE"],
    ["500", failure(500, null, "Internal"), "UNAVAILABLE"],
    ["418", failure(418, null, "teapot"), "UNKNOWN"],
  ];

  for (const [label, error, code] of table) {
    it(`maps ${label} to ${code}`, () => {
      const result = classifyBigQueryError(error);
      expect(result).toBeInstanceOf(BigQueryError);
      expect(result.code).toBe(code);
    });
  }

  it("keeps the HTTP status and never the raw Google message", () => {
    const secret = "Access Denied: Dataset my-secret-project:private_dataset";
    const result = classifyBigQueryError(failure(403, "accessDenied", secret));
    expect(result.httpStatus).toBe(403);
    expect(result.message).toBe(BQ_ERROR_TEXT.NO_ACCESS);
    expect(result.message).not.toContain("my-secret-project");
    expect(JSON.stringify(result)).not.toContain("my-secret-project");
  });

  it("passes a BigQueryError through unchanged", () => {
    const original = new BigQueryError("COST_CAP");
    expect(classifyBigQueryError(original)).toBe(original);
  });

  it("turns anything else into UNKNOWN without its message", () => {
    const result = classifyBigQueryError(new Error("secret detail"));
    expect(result.code).toBe("UNKNOWN");
    expect(result.message).not.toContain("secret detail");
    expect(classifyBigQueryError("boom").code).toBe("UNKNOWN");
  });

  it("has a fixed English text for every code", () => {
    for (const text of Object.values(BQ_ERROR_TEXT)) {
      expect(text.length).toBeGreaterThan(10);
    }
    expect(BQ_ERROR_TEXT.NO_ACCESS).toBe(
      "Agentelse's service account can't read this dataset. Grant it BigQuery Data Viewer on the dataset and BigQuery Job User on the project.",
    );
  });
});
