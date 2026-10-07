import { describe, expect, it } from "vitest";

import {
  gaBigQueryErrorOf,
  gaBigQueryMessage,
  isGaBigQueryErrorCode,
  type GaBigQueryErrorCode,
} from "./errors";

// Bu dosyanın kanıtladığı: SC-F9'un her BqErrorCode değeri belgelenen GA koduna
// eşlenir; iletiler sabit metindir (Google'ın ham metni yok); not_shared iletisi
// servis hesabının e-postasını ve iki rolü adlandırır.

const MAP: Record<string, GaBigQueryErrorCode> = {
  NOT_CONFIGURED: "not_configured",
  SA_AUTH: "auth",
  NO_ACCESS: "not_shared",
  NOT_FOUND: "dataset_not_found",
  BILLING_DISABLED: "billing",
  COST_CAP: "bytes_limit",
  RATE_LIMIT: "quota",
  INVALID_REQUEST: "invalid_query",
  INVALID_QUERY: "invalid_query",
  TIMEOUT: "unavailable",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unavailable",
};

describe("gaBigQueryErrorOf", () => {
  it.each(Object.entries(MAP))("maps %s to %s", (code, expected) => {
    expect(gaBigQueryErrorOf(code)).toBe(expected);
  });

  it("maps anything unrecognised to unavailable", () => {
    expect(gaBigQueryErrorOf("SOMETHING_NEW")).toBe("unavailable");
    expect(gaBigQueryErrorOf("")).toBe("unavailable");
  });
});

describe("gaBigQueryMessage", () => {
  const codes = Object.values(MAP).concat(["no_export_tables", "budget"]);

  it("gives every code a fixed, non-empty English message", () => {
    for (const code of new Set(codes)) {
      const message = gaBigQueryMessage(code, null);
      expect(message.length).toBeGreaterThan(10);
      expect(message).toBe(gaBigQueryMessage(code, null));
    }
  });

  it("names the service account and both roles for not_shared", () => {
    const message = gaBigQueryMessage(
      "not_shared",
      "reader@agentelse.iam.gserviceaccount.com",
    );
    expect(message).toBe(
      "Agentelse can't read that dataset yet. Give reader@agentelse.iam.gserviceaccount.com the BigQuery Data Viewer role on it and BigQuery Job User on the same project.",
    );
  });

  it("still names both roles when the email is unknown", () => {
    const message = gaBigQueryMessage("not_shared", null);
    expect(message).toContain("BigQuery Data Viewer");
    expect(message).toContain("BigQuery Job User");
  });

  it("only not_shared mentions the service account email", () => {
    for (const code of new Set(codes)) {
      if (code === "not_shared") continue;
      expect(gaBigQueryMessage(code, "sa@x.iam.gserviceaccount.com")).not.toContain(
        "sa@x.iam",
      );
    }
  });

  it("uses the documented not-configured sentence", () => {
    expect(gaBigQueryMessage("not_configured", null)).toBe(
      "BigQuery isn't set up on this Agentelse server yet.",
    );
  });
});

describe("isGaBigQueryErrorCode", () => {
  it("recognises stored codes only", () => {
    expect(isGaBigQueryErrorCode("budget")).toBe(true);
    expect(isGaBigQueryErrorCode("nope")).toBe(false);
    expect(isGaBigQueryErrorCode(null)).toBe(false);
  });
});
