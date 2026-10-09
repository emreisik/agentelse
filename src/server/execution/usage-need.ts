import "server-only";

import type { CapabilityKey } from "@prisma/client";

import { usdToMicros } from "@/server/billing/usage-recorder";
import {
  aiJobMaxCostUsd,
  isAiBudgetCapability,
} from "@/server/execution/providers/openai/openai-ai.provider";
import {
  creativeImageCount,
  isCreativeImageCapability,
} from "@/server/execution/providers/openai/openai-creative.provider";

// How much plan allowance a job needs before it can start, computed from the job
// alone (capability + payload), with no provider routing. A parked job is sized
// with this when the resume step decides which jobs the renewed allowance can
// pay for; the amounts are exactly what the providers declare through
// `usageEstimate` when the job actually runs, so the two cannot drift. The real
// arbiter stays the reservation in startExecution.
//
// null: the job spends no allowance (publishing, writes to ad platforms, jobs a
// mock provider would run).
export type UsageNeed =
  | { unit: "IMAGE"; amount: bigint }
  | { unit: "AI_MICROS"; amount: bigint };

export function usageNeedOf(
  capability: CapabilityKey,
  payload: unknown,
): UsageNeed | null {
  if (isCreativeImageCapability(capability)) {
    const images = creativeImageCount(
      (payload ?? {}) as Record<string, unknown>,
    );
    return images > 0 ? { unit: "IMAGE", amount: BigInt(images) } : null;
  }
  if (isAiBudgetCapability(capability)) {
    const micros = usdToMicros(aiJobMaxCostUsd(capability, payload));
    return micros > BigInt(0) ? { unit: "AI_MICROS", amount: micros } : null;
  }
  return null;
}
