import "server-only";

import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/env";

export type OpenAiCredit = {
  balance: number;
  spent: number;
  // The manual balance the estimate starts from. Once `spent` reaches it the
  // estimate has run out, and the real balance only the dashboard knows.
  snapshot: number;
  asOf: string;
};

let warnedBadAsOf = false;

// Balance is a manual snapshot minus what the app has spent on OpenAI since
// (ReasoningCall rows with a gpt-* model — reasoning, chat agent and, since
// openai-image-client.ts records them, gpt-image renders). Spend is summed
// across all workspaces because the API key and its credit are shared.
// Anything billed to the same credit outside this app (other projects on the
// key, the OpenAI dashboard playground) is invisible here.
export async function getOpenAiCredit(): Promise<OpenAiCredit | null> {
  const env = getEnv();
  const base = Number.parseFloat(env.OPENAI_CREDIT_BALANCE);
  if (!Number.isFinite(base)) return null;

  const parsed = new Date(env.OPENAI_CREDIT_BALANCE_AS_OF);
  const validAsOf = !Number.isNaN(parsed.getTime());
  const asOf = validAsOf ? parsed : new Date(0);
  // An unreadable date makes every call ever recorded count against the
  // snapshot and pins the header at $0 — say so instead of doing it silently.
  if (!validAsOf && !warnedBadAsOf) {
    warnedBadAsOf = true;
    console.warn(
      `[openai-credit] OPENAI_CREDIT_BALANCE_AS_OF ${JSON.stringify(env.OPENAI_CREDIT_BALANCE_AS_OF)} is not a valid date (check .env for a line broken/merged with another); counting all recorded spend.`,
    );
  }

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
    snapshot: base,
    asOf: asOf.toISOString(),
  };
}
