import { describe, expect, it } from "vitest";

import fixtures from "./__fixtures__/graph-errors.json";
import {
  classifyMetaError,
  metaErrorCode,
  metaUserMessage,
  parseMetaErrorCode,
} from "./error-catalog";
import { MetaApiError, metaErrorFromBody } from "./errors";

// Contract: Meta's documented error bodies map to the right class, action and
// message (docs/meta-ads-plan.md §3.6, F1 acceptance: at least 25 codes).

describe("Meta error catalog fixtures", () => {
  it("covers at least 25 error bodies", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(25);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))(
    "%s",
    (_name, fixture) => {
      const error = metaErrorFromBody(fixture.body, fixture.httpStatus);
      expect(classifyMetaError(error).class).toBe(fixture.expectedClass);
      expect(error.details.fbtraceId).toBe("AbCdEf123");
    },
  );
});

describe("classifyMetaError", () => {
  it("reads code 1 as too much data on an insights call, transient elsewhere", () => {
    const error = new MetaApiError("Please reduce the amount of data", 1);
    expect(classifyMetaError(error, "ads_insights").class).toBe("INSIGHTS_SIZE");
    expect(classifyMetaError(error, "ads_management").class).toBe("TRANSIENT");
  });

  it("treats a network failure (no code, no HTTP status) as transient", () => {
    expect(
      classifyMetaError(new MetaApiError("Could not reach Meta API")).class,
    ).toBe("TRANSIENT");
  });

  it("only a Meta-wide temporary failure degrades the shared provider", () => {
    expect(
      classifyMetaError(new MetaApiError("x", 2, undefined, { httpStatus: 500 }))
        .degradesProvider,
    ).toBe(true);
    for (const code of [190, 200, 100, 368, 4]) {
      expect(
        classifyMetaError(new MetaApiError("x", code)).degradesProvider,
      ).toBe(false);
    }
  });
});

describe("error details", () => {
  it("keeps the blamed field from error_data", () => {
    const error = metaErrorFromBody(
      {
        error: {
          code: 100,
          message: "Invalid parameter",
          error_data: '{"blame_field_specs":[["targeting","age_min"]]}',
        },
      },
      400,
    );
    expect(error.details.blameFieldSpecs).toEqual([["targeting", "age_min"]]);
  });

  it("shows Meta's own user message when there is one", () => {
    const error = new MetaApiError("Invalid parameter", 100, 1885272, {
      userMessage: "Daily budget is below Meta's minimum.",
    });
    expect(metaUserMessage(error)).toBe("Daily budget is below Meta's minimum.");
  });

  it("writes and reads back the structured job error code", () => {
    const code = metaErrorCode(new MetaApiError("x", 100, 1885272));
    expect(code).toBe("META:VALIDATION:100/1885272");
    expect(parseMetaErrorCode(code)).toBe("VALIDATION");
    expect(parseMetaErrorCode("SOMETHING_ELSE")).toBeNull();
  });
});
