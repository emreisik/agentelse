import "server-only";

import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";

export type OpenAiCredit = {
  balance: number;
  spent: number;
  asOf: string;
};

// Balance is a manual snapshot minus what the app has spent on OpenAI since
// (ReasoningCall rows with a gpt-* model — reasoning + chat agent). Spend is
// summed across all workspaces because the API key and its credit are shared.
// Image generation is not recorded in ReasoningCall, so it isn't deducted.
export async function getOpenAiCredit(): Promise<OpenAiCredit | null> {
  const env = getEnv();
  const base = Number.parseFloat(env.OPENAI_CREDIT_BALANCE);
  if (!Number.isFinite(base)) return null;

  const parsed = new Date(env.OPENAI_CREDIT_BALANCE_AS_OF);
  const asOf = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;

  const agg = await prisma.reasoningCall.aggregate({
    where: {
      isMock: false,
      model: { startsWith: "gpt-" },
      createdAt: { gte: asOf },
    },
    _sum: { costUsd: true },
  });
  const spent = agg._sum.costUsd ?? 0;

  return {
    balance: Math.max(0, base - spent),
    spent,
    asOf: asOf.toISOString(),
  };
}
