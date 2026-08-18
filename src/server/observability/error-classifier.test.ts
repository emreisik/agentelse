import { describe, expect, it } from "vitest";

import {
  classifyError,
  isAutoRecoverable,
} from "@/server/observability/error-classifier";

describe("classifyError", () => {
  it("classifies a billing error as non-retryable", () => {
    const result = classifyError(
      '400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    );
    expect(result.category).toBe("BILLING");
    expect(result.strategy).toBe("NEEDS_CONFIG");
    expect(result.degradesProvider).toBe(true);
    expect(isAutoRecoverable(result)).toBe(false);
  });

  it("marks a rate limit as retryable after cooldown", () => {
    const result = classifyError("429 Too Many Requests — rate_limit_error");
    expect(result.category).toBe("RATE_LIMIT");
    expect(isAutoRecoverable(result)).toBe(true);
    expect(result.degradesProvider).toBe(true);
  });

  it("counts a timeout as retryable without degrading the provider", () => {
    const result = classifyError("aborted");
    expect(result.category).toBe("TIMEOUT");
    expect(isAutoRecoverable(result)).toBe(true);
    expect(result.degradesProvider).toBe(false);
  });

  it("separates out an unknown agent id as a configuration issue", () => {
    const result = classifyError(
      'Error: Unknown agent id "web-health-public_research".',
    );
    expect(result.category).toBe("CONFIGURATION");
    expect(isAutoRecoverable(result)).toBe(false);
  });

  it("classifies a missing provider as a missing integration", () => {
    const result = classifyError(
      "No execution provider available for capability SIGNAL_SCAN",
    );
    expect(result.category).toBe("PROVIDER_UNAVAILABLE");
    expect(result.degradesProvider).toBe(false);
  });

  it("counts a schema violation as retryable", () => {
    const result = classifyError(
      "openclaw agent --json did not return the confirmed schema",
    );
    expect(result.category).toBe("INVALID_RESULT");
    expect(isAutoRecoverable(result)).toBe(true);
  });

  it("falls back to human review for empty and unrecognized messages", () => {
    expect(classifyError(null).category).toBe("UNKNOWN");
    expect(classifyError("something unexpected happened").strategy).toBe(
      "NEEDS_HUMAN",
    );
  });

  it("matches the billing rule before the rate-limit rule", () => {
    // Ordering is decisive for a message containing both keywords: a
    // billing problem isn't solved by waiting, and misclassifying it
    // creates an infinite retry loop.
    const result = classifyError(
      "quota exceeded — too many requests for this billing period",
    );
    expect(result.category).toBe("BILLING");
  });
});
