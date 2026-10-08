import { describe, expect, it } from "vitest";

import {
  estimateFalImageCostUsd,
  estimateImageCostUsd,
  estimateReasoningCostUsd,
  priceReasoningCall,
} from "./reasoning-pricing";

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

describe("estimateImageCostUsd", () => {
  it("prices a render from its token usage, split by text / image input", () => {
    // $5/M text in, $8/M image in, $30/M image out.
    expect(
      estimateImageCostUsd({
        quality: "high",
        size: "1024x1024",
        usage: {
          input_tokens: 2_000_000,
          input_tokens_details: { text_tokens: 1_000_000, image_tokens: 1_000_000 },
          output_tokens: 1_000_000,
        },
      }),
    ).toBeCloseTo(5 + 8 + 30, 6);
  });

  it("prices input without a breakdown at the dearer image rate", () => {
    expect(
      estimateImageCostUsd({
        quality: "low",
        size: "1024x1024",
        usage: { input_tokens: 1_000_000, output_tokens: 1 },
      }),
    ).toBeCloseTo(8 + 0.00003, 6);
  });

  it("falls back to the per-image price by quality when usage is missing", () => {
    expect(estimateImageCostUsd({ quality: "low", size: "1024x1024" })).toBeCloseTo(0.006, 6);
    expect(estimateImageCostUsd({ quality: "medium", size: "1024x1024" })).toBeCloseTo(0.053, 6);
    expect(estimateImageCostUsd({ quality: "high", size: "1024x1024" })).toBeCloseTo(0.211, 6);
  });

  it("overstates 'auto' as 'high' and scales up for larger canvases", () => {
    expect(estimateImageCostUsd({ quality: "auto", size: "1024x1024" })).toBeCloseTo(0.211, 6);
    // 2048x2048 is 4x the pixels of 1024x1024.
    expect(estimateImageCostUsd({ quality: "high", size: "2048x2048" })).toBeCloseTo(0.211 * 4, 6);
    // Smaller canvases are not discounted — never understate.
    expect(estimateImageCostUsd({ quality: "high", size: "512x512" })).toBeCloseTo(0.211, 6);
  });
});

describe("priceReasoningCall", () => {
  it("prices cached input tokens at 10% and only when the API reported them", () => {
    const base = {
      model: "gpt-5.6-luna",
      inputTokens: 1_000_000,
      outputTokens: 0,
    };
    expect(priceReasoningCall(base).costUsd).toBeCloseTo(1, 8);
    expect(
      priceReasoningCall({ ...base, cachedTokens: 1_000_000 }).costUsd,
    ).toBeCloseTo(0.1, 8);
    // More cached than total is clamped, never a negative cost.
    expect(
      priceReasoningCall({ ...base, cachedTokens: 9_000_000 }).costUsd,
    ).toBeCloseTo(0.1, 8);
  });

  it("flags the cost as an estimate for an unknown model or missing usage", () => {
    expect(
      priceReasoningCall({ model: "gpt-5.6-luna", inputTokens: 10, outputTokens: 5 })
        .estimated,
    ).toBe(false);
    expect(
      priceReasoningCall({ model: "some-future-model", inputTokens: 10, outputTokens: 5 })
        .estimated,
    ).toBe(true);
    expect(priceReasoningCall({ model: "gpt-5.6-luna" }).estimated).toBe(true);
  });
});

describe("estimateFalImageCostUsd", () => {
  it("uses the listed price and overstates an unlisted endpoint", () => {
    expect(estimateFalImageCostUsd("fal-ai/flux/schnell")).toBeLessThan(0.01);
    expect(estimateFalImageCostUsd("fal-ai/unlisted")).toBeGreaterThan(
      estimateFalImageCostUsd("fal-ai/flux-pro/v1.1-ultra"),
    );
  });
});
