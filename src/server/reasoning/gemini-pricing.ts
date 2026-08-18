import "server-only";

// Gemini API list prices (paid tier, USD per 1M tokens).
// ai.google.dev/gemini-api/docs/pricing — verified as of 2026-08.
//
// Without this table, ReasoningCall.costUsd always stayed 0; as a result
// AgencyDailyStat.reasoningCostUsd also stayed 0, and AutonomyPolicy's
// `dailyBudgetUsd` budget cap could never be triggered.
type ModelPrice = { inputPerMillion: number; outputPerMillion: number };

const PRICES: Record<string, ModelPrice> = {
  "gemini-3.6-flash": { inputPerMillion: 1.5, outputPerMillion: 7.5 },
  "gemini-3.5-flash": { inputPerMillion: 1.5, outputPerMillion: 7.5 },
  "gemini-3.1-flash-lite": { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  "gemini-3.5-flash-lite": { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  "gemini-3.1-pro-preview": { inputPerMillion: 2, outputPerMillion: 12 },
  "gemini-3-pro-image": { inputPerMillion: 2, outputPerMillion: 12 },
  "gemini-3.1-flash-image": { inputPerMillion: 0.5, outputPerMillion: 3 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
};

// For unknown/alias model names (e.g. "gemini-pro-latest"): calculate
// using the Pro price. It's safer to overstate the cost than understate
// it — the budget cap triggers early rather than late.
const FALLBACK: ModelPrice = { inputPerMillion: 2, outputPerMillion: 12 };

function priceFor(model: string): ModelPrice {
  if (PRICES[model]) return PRICES[model];
  // Match aliases by family: "...-flash-lite" > "...-flash" > "...-pro".
  if (model.includes("flash-lite")) return PRICES["gemini-3.1-flash-lite"]!;
  if (model.includes("flash")) return PRICES["gemini-3.6-flash"]!;
  return FALLBACK;
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
