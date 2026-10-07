import "server-only";

// LLM list prices (paid tier, USD per 1M tokens) for the reasoning backend —
// OpenAI (platform.openai.com/docs/pricing), verified as of 2026-08.
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

// OpenAI bills each web_search tool call on top of tokens (list price, USD per
// 1K calls: platform.openai.com/docs/pricing). Overstated on purpose, like the
// model fallbacks above: the budget cap should trip early, not late.
const WEB_SEARCH_USD_PER_CALL = 0.01;

// gpt-image-2 (platform.openai.com/docs/pricing), USD per 1M tokens. A render
// is billed on its real token usage, which the API returns with every image.
const IMAGE_TEXT_INPUT_PER_MILLION = 5;
const IMAGE_INPUT_PER_MILLION = 8;
const IMAGE_OUTPUT_PER_MILLION = 30;

// Per-image list price at 1024x1024, only used when a response carried no
// `usage`. "auto" is priced as "high" — overstating beats understating here
// too, because the header balance is read as "what I can still spend".
const IMAGE_FALLBACK_USD = { low: 0.006, medium: 0.053, high: 0.211 } as const;

export type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
};

export function estimateImageCostUsd(input: {
  quality: "low" | "medium" | "high" | "auto";
  size: string;
  usage?: ImageUsage;
}): number {
  const { usage } = input;
  if (usage?.output_tokens) {
    const details = usage.input_tokens_details;
    const textIn = details?.text_tokens ?? 0;
    // Without a breakdown the whole input is priced as image tokens (the
    // dearer rate).
    const imageIn = details
      ? (details.image_tokens ?? 0)
      : (usage.input_tokens ?? 0);
    return (
      (textIn / 1_000_000) * IMAGE_TEXT_INPUT_PER_MILLION +
      (imageIn / 1_000_000) * IMAGE_INPUT_PER_MILLION +
      (usage.output_tokens / 1_000_000) * IMAGE_OUTPUT_PER_MILLION
    );
  }
  const [width, height] = input.size.split("x").map(Number);
  const scale =
    width && height ? Math.max(1, (width * height) / (1024 * 1024)) : 1;
  const tier = input.quality === "auto" ? "high" : input.quality;
  return IMAGE_FALLBACK_USD[tier] * scale;
}

export function estimateReasoningCostUsd(input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  webSearchCalls?: number;
}): number {
  const price = priceFor(input.model);
  const inputCost =
    ((input.inputTokens ?? 0) / 1_000_000) * price.inputPerMillion;
  const outputCost =
    ((input.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  const searchCost = (input.webSearchCalls ?? 0) * WEB_SEARCH_USD_PER_CALL;
  return inputCost + outputCost + searchCost;
}
