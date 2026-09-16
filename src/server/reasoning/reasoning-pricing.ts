import "server-only";

// LLM list prices (paid tier, USD per 1M tokens) for OpenAI
// (platform.openai.com/docs/pricing), verified as of 2026-08.
//
// Without this table, ReasoningCall.costUsd always stayed 0; as a result
// AgencyDailyStat.reasoningCostUsd also stayed 0, and AutonomyPolicy's
// `dailyBudgetUsd` budget cap could never be triggered.
type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

const OPENAI_PRICES: Record<string, ModelPrice> = {
  "gpt-5.6-sol": { inputPerMillion: 5, outputPerMillion: 30 },
  "gpt-5.6-terra": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "gpt-5.6-luna": { inputPerMillion: 1, outputPerMillion: 6 },
  "gpt-5.5": { inputPerMillion: 5, outputPerMillion: 30 },
  "gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
};

// For unknown/alias model names: calculate using the flagship price. It's
// safer to overstate the cost than understate it — the budget cap triggers
// early rather than late.
const OPENAI_FALLBACK: ModelPrice = {
  inputPerMillion: 5,
  outputPerMillion: 30,
};

function priceFor(model: string): ModelPrice {
  if (OPENAI_PRICES[model]) return OPENAI_PRICES[model];
  if (model.includes("nano")) return OPENAI_PRICES["gpt-5.4-nano"]!;
  if (model.includes("mini")) return OPENAI_PRICES["gpt-5.4-mini"]!;
  return OPENAI_FALLBACK;
}

export function estimateReasoningCostUsd(input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): number {
  const price = priceFor(input.model);
  const inputCost =
    ((input.inputTokens ?? 0) / 1_000_000) * price.inputPerMillion;
  const outputCost =
    ((input.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  return inputCost + outputCost;
}
