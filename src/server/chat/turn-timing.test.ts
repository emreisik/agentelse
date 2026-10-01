import { describe, expect, it } from "vitest";

import { formatTurnTiming } from "./turn-timing";

const base = {
  ok: true,
  startedAt: 1_000,
  modelStartedAt: 1_900,
  firstTokenAt: 4_400,
  modelEndedAt: 7_000,
  rounds: 2,
  tools: ["load_skill"],
  inputTokens: 21_000,
  cachedInputTokens: 18_000,
  outputTokens: 350,
};

describe("formatTurnTiming", () => {
  it("splits the turn into pre-model, first token, model loop and tail", () => {
    expect(formatTurnTiming(base, 7_800)).toBe(
      "[chat-timing] ok=true pre_model=900ms first_token=3400ms model_loop=5100ms tail=800ms total=6800ms rounds=2 tools=load_skill in=21000 cached=18000 out=350",
    );
  });

  it("shows a dash for a stage that never happened", () => {
    const line = formatTurnTiming(
      {
        ...base,
        ok: false,
        firstTokenAt: 0,
        modelEndedAt: 0,
        rounds: 1,
        tools: [],
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      3_000,
    );
    expect(line).toContain("first_token=-");
    expect(line).toContain("model_loop=-");
    expect(line).toContain("tail=-");
    expect(line).toContain("tools=-");
    expect(line).toContain("total=2000ms");
  });
});
