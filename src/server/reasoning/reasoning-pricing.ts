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

// Faturalama ölçümü (UsageEntry.priceTable): bu dosyadaki liste fiyatlarının
// son doğrulandığı ay. Fiyat değiştirirsen sürümü de güncelle; mutabakatta
// hangi satırın hangi tabloyla hesaplandığı buradan anlaşılır.
export const PRICE_TABLE_VERSION = "2026-08";

// Önbellekten okunan girdi tokenı normal girdi fiyatının %10'udur (OpenAI
// GPT-5 ailesi: $1.25 → $0.125; GPT-5.5: $5 → $0.50). İndirim YALNIZ API
// `cached_tokens` döndürdüğünde uygulanır; raporlanmayan önbellek tam fiyattan
// sayılır (fazla tahmin, eksik tahmin değil).
const CACHED_INPUT_MULTIPLIER = 0.1;

export type ReasoningCostDetail = {
  costUsd: number;
  // true: kullanım raporlanmadı ya da model tabloda yok (flagship fiyatı
  // kullanıldı) — gerçek maliyet değil, tahmin.
  estimated: boolean;
};

export function priceReasoningCall(input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  // inputTokens'ın içinde sayılan önbellek tokenları.
  cachedTokens?: number;
  webSearchCalls?: number;
}): ReasoningCostDetail {
  const known = Object.hasOwn(OPENAI_PRICES, input.model);
  const price = priceFor(input.model);
  const totalIn = input.inputTokens ?? 0;
  const cached = Math.min(Math.max(input.cachedTokens ?? 0, 0), totalIn);
  const inputCost =
    ((totalIn - cached) / 1_000_000) * price.inputPerMillion +
    (cached / 1_000_000) * price.inputPerMillion * CACHED_INPUT_MULTIPLIER;
  const outputCost =
    ((input.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  const searchCost = (input.webSearchCalls ?? 0) * WEB_SEARCH_USD_PER_CALL;
  const usageReported =
    input.inputTokens !== undefined || input.outputTokens !== undefined;
  return {
    costUsd: inputCost + outputCost + searchCost,
    estimated: !known || !usageReported,
  };
}

export function estimateReasoningCostUsd(input: {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  webSearchCalls?: number;
}): number {
  return priceReasoningCall(input).costUsd;
}

// fal.ai kullanım döndürmez: görsel başına liste fiyatı (USD). Hepsi TAHMİNDİR
// (UsageEntry.costEstimated = true) ve fal.ai/pricing ile doğrulanmalıdır;
// listede olmayan uç nokta fazla tahmin edilir.
const FAL_USD_PER_IMAGE: Record<string, number> = {
  "fal-ai/flux/schnell": 0.003,
  "fal-ai/flux/dev": 0.025,
  "fal-ai/flux-pro/v1.1-ultra": 0.06,
  "fal-ai/flux-2-pro": 0.045,
  "fal-ai/qwen-image": 0.02,
  "bytedance/seedream/v4": 0.03,
  "fal-ai/imagen3": 0.05,
  "fal-ai/imagen3/fast": 0.025,
  "fal-ai/recraft/v3/text-to-image": 0.04,
  "fal-ai/ideogram/v3": 0.06,
  "fal-ai/flux-pro/kontext": 0.04,
  "fal-ai/flux-pro/v1/fill": 0.05,
  "fal-ai/bria/background/remove": 0.018,
  "fal-ai/clarity-upscaler": 0.03,
};
const FAL_FALLBACK_USD_PER_IMAGE = 0.08;

export function estimateFalImageCostUsd(endpointId: string): number {
  return FAL_USD_PER_IMAGE[endpointId] ?? FAL_FALLBACK_USD_PER_IMAGE;
}
