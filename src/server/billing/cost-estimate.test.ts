import { describe, expect, it } from "vitest";

import { priceReasoningCall } from "@/server/reasoning/reasoning-pricing";

import {
  ASSUMED_SEARCH_CALLS,
  PROMPT_OVERHEAD_CHARS,
  estimateTextCallCostUsd,
  estimateTextCallMicros,
} from "./cost-estimate";

describe("estimateTextCallCostUsd", () => {
  it("prices the whole output budget plus the estimated input", () => {
    const usd = estimateTextCallCostUsd({
      model: "gpt-5.6-luna",
      inputChars: 3_000,
      maxOutputTokens: 4_096,
    });
    // 1_000 input tokens x $1/M + 4_096 output tokens x $6/M.
    expect(usd).toBeCloseTo(0.001 + 4_096 * 6e-6, 9);
  });

  it("adds the assumed web searches", () => {
    const base = { model: "gpt-5.6-luna", inputChars: 0, maxOutputTokens: 0 };
    expect(
      estimateTextCallCostUsd({ ...base, searchCalls: ASSUMED_SEARCH_CALLS }) -
        estimateTextCallCostUsd(base),
    ).toBeCloseTo(ASSUMED_SEARCH_CALLS * 0.01, 9);
  });

  it("is never below what a typical real call costs", () => {
    // A 4k-token answer to an 8k-token prompt, no cache.
    const real = priceReasoningCall({
      model: "gpt-5.6-luna",
      inputTokens: 8_000,
      outputTokens: 4_000,
    }).costUsd;
    const estimate = estimateTextCallCostUsd({
      model: "gpt-5.6-luna",
      inputChars: PROMPT_OVERHEAD_CHARS,
      maxOutputTokens: 4_096,
    });
    expect(estimate).toBeGreaterThanOrEqual(real);
  });

  it("prices an unknown model at the flagship rate (over-, not under-estimate)", () => {
    const unknown = estimateTextCallCostUsd({
      model: "some-future-model",
      inputChars: 3_000,
      maxOutputTokens: 1_000,
    });
    const flagship = estimateTextCallCostUsd({
      model: "gpt-5.6-sol",
      inputChars: 3_000,
      maxOutputTokens: 1_000,
    });
    expect(unknown).toBeCloseTo(flagship, 9);
  });

  it("clamps nonsense input instead of going negative", () => {
    expect(
      estimateTextCallCostUsd({
        model: "gpt-5.6-luna",
        inputChars: -5,
        maxOutputTokens: -5,
      }),
    ).toBe(0);
  });
});

describe("estimateTextCallMicros", () => {
  it("returns whole micro-dollars", () => {
    expect(
      estimateTextCallMicros({
        model: "gpt-5.6-luna",
        inputChars: 3_000,
        maxOutputTokens: 4_096,
      }),
    ).toBe(BigInt(Math.round((0.001 + 4_096 * 6e-6) * 1_000_000)));
  });
});
