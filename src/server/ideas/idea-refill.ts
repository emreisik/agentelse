import "server-only";

import { prisma } from "@/lib/prisma";
import { isExpired, parseIdeaConcept } from "@/lib/ideas/concept";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { ideaSocialDef } from "@/server/reasoning/prompts/idea-social";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { isWorksEnabled } from "@/server/works/flag";
import { moduleRefillIfDue } from "@/server/ideas/idea-modules";
import {
  IDEA_LOW_WATER,
  IDEA_POOL_TARGET,
  IDEAS_PER_CALL,
  IdeaEngine,
  type GenerateIdeasResult,
} from "@/server/ideas/idea-engine";

// Keeps the idea pool full (docs/ideas.md, owner decision of 6 Oct 2026:
// "smart refill"). A project whose fresh post ideas fall below the low-water
// mark gets one engine run, at most every few hours, topping it up toward the
// target. Run by the worker's tick (agency-wiring.ts "idea-pool-refill") and by
// the Ideas board when it opens (so the pool fills even while the worker is
// not triggered). Bounded by the pool size and the daily AI limit in
// Settings -> Autonomy, like every other model call.

export const REFILL_INTERVAL_MS = 6 * 60 * 60_000;
// A failed run is tried again after this long, not on every tick.
export const REFILL_RETRY_MS = 60 * 60_000;
// Projects someone worked in recently: the only ones the tick tops up.
const ACTIVE_WINDOW_MS = 14 * 24 * 60 * 60_000;
// A project the tick looked at is not looked at again for this long.
const CHECK_MEMO_MS = 10 * 60_000;
const DEFAULT_POOL_SIZE = 20;

export type LastRun = { createdAt: Date; status: string } | null;

export function refillDue(input: {
  fresh: number;
  lowWater: number;
  last: LastRun;
  now: Date;
}): boolean {
  if (input.fresh >= input.lowWater) return false;
  if (!input.last) return true;
  const age = input.now.getTime() - input.last.createdAt.getTime();
  return (
    age >= (input.last.status === "OK" ? REFILL_INTERVAL_MS : REFILL_RETRY_MS)
  );
}

// How many ideas one run asks for: up to the target (never past the pool
// size), at most one call's worth.
export function refillCount(input: {
  fresh: number;
  poolSize: number;
  unlimited: boolean;
}): number {
  const target = input.unlimited
    ? IDEA_POOL_TARGET
    : Math.min(input.poolSize, IDEA_POOL_TARGET);
  return Math.max(0, Math.min(IDEAS_PER_CALL, target - input.fresh));
}

export function lowWaterOf(poolSize: number, unlimited: boolean): number {
  return unlimited ? IDEA_LOW_WATER : Math.min(IDEA_LOW_WATER, poolSize);
}

export type PoolHealth = {
  fresh: number;
  last: LastRun;
  poolSize: number;
  unlimited: boolean;
};

// Fresh post ideas waiting (saved ones count: a plan uses them first), the
// last run, and the pool size setting.
export async function poolHealth(
  projectId: string,
  now: Date,
): Promise<PoolHealth> {
  const [ideas, last, policy] = await Promise.all([
    prisma.idea.findMany({
      where: {
        projectId,
        isMock: false,
        status: { in: [...IDEA_POOL_STATUSES] },
      },
      select: { concept: true },
      take: 300,
    }),
    prisma.reasoningCall.findFirst({
      where: { projectId, purpose: ideaSocialDef.purpose },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, status: true },
    }),
    prisma.autonomyPolicy.findUnique({
      where: { projectId },
      select: { maxActiveIdeas: true, unlimitedMode: true },
    }),
  ]);
  const fresh = ideas.filter((row) => {
    const concept = parseIdeaConcept(row.concept);
    return concept?.module === "social" && !isExpired(concept, now);
  }).length;
  return {
    fresh,
    last: last
      ? { createdAt: last.createdAt, status: String(last.status) }
      : null,
    poolSize: policy?.maxActiveIdeas ?? DEFAULT_POOL_SIZE,
    unlimited: policy?.unlimitedMode ?? false,
  };
}

export type RefillResult =
  GenerateIdeasResult | { ok: false; reason: "NOT_DUE" };

export async function refillIfDue(
  projectId: string,
  now: Date = new Date(),
): Promise<RefillResult> {
  const health = await poolHealth(projectId, now);
  const due = refillDue({
    fresh: health.fresh,
    lowWater: lowWaterOf(health.poolSize, health.unlimited),
    last: health.last,
    now,
  });
  const count = refillCount(health);
  if (!due || count <= 0) return { ok: false, reason: "NOT_DUE" };
  return IdeaEngine.generate({ projectId, count, trigger: "refill", now });
}

const checked = new Map<string, number>();

// Tests only.
export function clearIdeaRefillMemo(): void {
  checked.clear();
}

export const IdeaRefill = {
  // The tick step: at most `limit` projects get a model run per tick; the
  // rest wait for the next ticks.
  async runDue(limit = 2, now: Date = new Date()): Promise<number> {
    if (!isWorksEnabled()) return 0;
    const candidates = await prisma.work.findMany({
      where: {
        lastActivityAt: { gte: new Date(now.getTime() - ACTIVE_WINDOW_MS) },
      },
      orderBy: { lastActivityAt: "desc" },
      distinct: ["projectId"],
      take: 50,
      select: { projectId: true },
    });
    let ran = 0;
    for (const { projectId } of candidates) {
      if (ran >= limit) break;
      const seen = checked.get(projectId);
      if (seen !== undefined && now.getTime() - seen < CHECK_MEMO_MS) continue;
      checked.set(projectId, now.getTime());
      if (!(await isProjectAgencyActive(projectId))) continue;
      try {
        const result = await refillIfDue(projectId, now);
        const modules = await moduleRefillIfDue(projectId, now);
        if (result.ok || result.reason !== "NOT_DUE" || modules.length > 0) ran += 1;
      } catch (error) {
        ran += 1;
        console.error(
          `[idea-refill] refill failed for project ${projectId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return ran;
  },
};
