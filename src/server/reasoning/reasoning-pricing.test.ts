import { describe, expect, it } from "vitest";

import { estimateReasoningCostUsd } from "./reasoning-pricing";

// Cost feeds the daily budget cap, so what matters is that nothing is left out
// of it: tokens for both directions, and (new) each live web search, which
// OpenAI bills on top of tokens.

describe("estimateReasoningCostUsd", () => {
  it("prices input and output tokens per million for a known model", () => {
    // gpt-5.6-luna: $1 in / $6 out per million.
    expect(
      estimateReasoningCostUsd({
        model: "gpt-5.6-luna",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(7, 6);
  });

  it("adds a fixed fee for every web search the model ran", () => {
    const base = { model: "gpt-5.6-luna", inputTokens: 1_000, outputTokens: 500 };
    const tokensOnly = estimateReasoningCostUsd(base);

    expect(
      estimateReasoningCostUsd({ ...base, webSearchCalls: 3 }),
    ).toBeCloseTo(tokensOnly + 0.03, 6);
  });

  it("charges nothing extra when no search ran, or the count is unknown", () => {
    const base = { model: "gpt-5.6-luna", inputTokens: 1_000, outputTokens: 500 };
    const tokensOnly = estimateReasoningCostUsd(base);

    expect(estimateReasoningCostUsd({ ...base, webSearchCalls: 0 })).toBe(tokensOnly);
    expect(estimateReasoningCostUsd({ ...base, webSearchCalls: undefined })).toBe(
      tokensOnly,
    );
  });

  it("still bills the searches when the token counts are missing", () => {
    expect(
      estimateReasoningCostUsd({ model: "gpt-5.6-luna", webSearchCalls: 2 }),
    ).toBeCloseTo(0.02, 6);
  });

  it("errs on the high side for an unknown model, so the cap trips early", () => {
    const unknown = estimateReasoningCostUsd({
      model: "gpt-9-future",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const known = estimateReasoningCostUsd({
      model: "gpt-5.6-luna",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(unknown).toBeGreaterThan(known);
  });
});
