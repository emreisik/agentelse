import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { resolvePlanItem, isPlanGoal } from "@/lib/content-channels";
import {
  blocksOf,
  checkItems,
  type BrandRuleSet,
} from "@/lib/works/brand-rules";
import {
  cleanWorksTextOrNull,
  flattenRuleText,
  NEUTRAL_IDEA_LABEL,
} from "@/lib/works/clean-text";
import { copyText } from "@/lib/works/copy";
import {
  ALTERNATIVES_CLAIM_TTL_MS,
  MAX_ALTERNATIVE_RUNS,
  MAX_ALTERNATIVE_SLOTS_PER_RUN,
  MAX_ALTERNATIVES_STORED,
  canSwapSlot,
  normalizeAlternatives,
  type PlanAlternative,
  type SwapSlotState,
} from "@/lib/works/plan-alternatives";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { RUN_CLAIM_TTL_MS } from "@/server/chat/plan-run";
import { updateCommandCard } from "@/server/chat/card-store";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { planSlotAlternativesDef } from "@/server/reasoning/prompts/plan-slot-alternatives";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  assertWorkActive,
  idSchema,
  readBoundedJson,
  refreshWorkPages,
} from "@/server/works/guard";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { isWorksEnabled } from "@/server/works/flag";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// "More ideas" on a plan card: ONE reasoning call that proposes other takes on
// the plan's posts and APPENDS them to items[i].alternatives. A Route Handler,
// never a Server Action: Next dispatches Server Actions one at a time per
// client, so a slow model call would block Save / Approve from the same tab.
//
// The card claim (alternativesMeta.runningSince + runs) is the mutex and the
// cost cap: two tabs make one model call, and a plan gets two paid runs.

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const MAX_PROMPT_RULES = 12;
const MAX_OTHER_TOPICS = 40;
const MAX_TOPIC = 120;
const MAX_CAPTION = 200;

const BodySchema = z.object({ commandId: idSchema });

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type PlanItem = PlanCard["items"][number];

type SlotFact = {
  index: number;
  date: string;
  channel: string;
  format: string;
  topic: string;
  captionIdea: string;
  existingAlternatives: string[];
};

// Soft refusals are 200 with ok:false: the card shows the message, nothing is
// wrong with the request itself.
function soft(code: string, message: string) {
  return NextResponse.json({ ok: false, code, message });
}

function isPlanCard(card: unknown): card is PlanCard {
  return (
    typeof card === "object" &&
    card !== null &&
    (card as { kind?: unknown }).kind === "content-plan-draft"
  );
}

function slotWhen(item: PlanItem): string {
  return `${item.date}T${item.time}`;
}

function claimIsLive(runningSince: string | undefined, now: number): boolean {
  if (!runningSince) return false;
  const since = Date.parse(runningSince);
  return Number.isFinite(since) && now - since < ALTERNATIVES_CLAIM_TTL_MS;
}

// Rule and claim text goes to the model flattened and clipped, never judged:
// the instruction filter would drop "Never mention competitors by name".
function ruleTexts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = flattenRuleText(value, 120);
    if (text) out.push(text);
    if (out.length >= MAX_PROMPT_RULES) break;
  }
  return out;
}

async function slotStatesOf(
  card: PlanCard,
  projectId: string,
  commandId: string,
  now: number,
): Promise<SwapSlotState[]> {
  const ids = card.savedCreativeIds ?? [];
  if (ids.length === 0) return [];
  const [creatives, tasks] = await Promise.all([
    prisma.creative.findMany({
      where: { id: { in: ids }, projectId, planId: commandId },
      select: { id: true, status: true, currentVersionId: true },
    }),
    prisma.task.findMany({
      where: {
        projectId,
        commandId,
        status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] },
      },
      select: { payload: true },
    }),
  ]);
  const byId = new Map(creatives.map((row) => [row.id, row]));
  const liveTaskFor = new Set(
    tasks.flatMap((task) => {
      const id = planCreativeIdOf(task.payload);
      return id ? [id] : [];
    }),
  );
  const production = card.production;
  const running =
    production?.state === "running" &&
    now - Date.parse(production.startedAt) < RUN_CLAIM_TTL_MS
      ? new Set(production.creativeIds)
      : new Set<string>();

  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) return null;
    return {
      status: row.status,
      hasVersion: row.currentVersionId !== null,
      liveTask: liveTaskFor.has(id),
      inRunningClaim: running.has(id),
    };
  });
}

// Gives the claim back after a failed or empty run. Only the run that still
// holds the claim restores it: when the claim expired and another run took it
// over, that run already treated ours as failed. `refund` gives the run back
// too; it is false once the model was called, because that call was paid for:
// a deterministic failure must not be retryable past the two-run cap.
async function releaseClaim(
  commandId: string,
  projectId: string,
  stamp: string,
  refund = true,
): Promise<void> {
  try {
    await updateCommandCard({
      commandId,
      projectId,
      expectKinds: ["content-plan-draft"],
      update: (card) => {
        if (!isPlanCard(card)) return null;
        const meta = card.alternativesMeta;
        if (!meta || meta.runningSince !== stamp) return null;
        return {
          ...card,
          alternativesMeta: {
            runs: refund ? Math.max(0, meta.runs - 1) : meta.runs,
          },
        };
      },
    });
  } catch (error) {
    console.error(
      "[works] alternatives claim release failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  if (!isWorksEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let access: Awaited<ReturnType<typeof requireProjectAccess>>;
  try {
    access = await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  // Typed and bounded BEFORE it is parsed.
  const raw = await readBoundedJson(request);
  if (!raw.ok) {
    return NextResponse.json({ error: raw.message }, { status: raw.status });
  }
  const parsed = BodySchema.safeParse(raw.value);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { commandId } = parsed.data;

  if (
    isRateLimited(`plan-alt:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  ) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down for a moment." },
      { status: 429 },
    );
  }

  // Looked up WITH the project id: an id from another project never matches.
  const command = await prisma.command.findFirst({
    where: { id: commandId, projectId },
    select: { id: true, workId: true, parsedIntent: true },
  });
  if (!command || !command.workId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const work = await assertWorkActive(prisma, {
    workId: command.workId,
    projectId,
  });
  if (!work.ok) {
    return NextResponse.json({ error: work.message }, { status: 409 });
  }

  const storedCard = (command.parsedIntent as { card?: unknown } | null)?.card;
  if (
    !isPlanCard(storedCard) ||
    (storedCard.state !== "draft" && storedCard.state !== "saved")
  ) {
    return NextResponse.json(
      { error: "This plan can't get other ideas." },
      { status: 409 },
    );
  }

  // A mock answer must never be written into a real plan.
  if (ReasoningService.isMockMode()) {
    return soft("MOCK", copyText("planAlt.mock"));
  }

  // Which saved slots are still untouched (read before the claim: the claim
  // callback is synchronous).
  const slotStates =
    storedCard.state === "saved"
      ? await slotStatesOf(storedCard, projectId, commandId, Date.now())
      : null;

  // Claim: this write is the mutex. Two tabs, one model call.
  const stamp = new Date().toISOString();
  const claim = await updateCommandCard({
    commandId,
    projectId,
    expectKinds: ["content-plan-draft"],
    requireActiveWork: true,
    update: (card) => {
      if (
        !isPlanCard(card) ||
        (card.state !== "draft" && card.state !== "saved")
      ) {
        return { reject: "STATE" };
      }
      const now = Date.now();
      const meta = card.alternativesMeta;
      let runs = meta?.runs ?? 0;
      if (meta?.runningSince) {
        if (claimIsLive(meta.runningSince, now)) return { reject: "BUSY" };
        // A claim older than the TTL is a crashed run: it must not use up one
        // of the refreshes.
        runs = Math.max(0, runs - 1);
      }
      if (runs >= MAX_ALTERNATIVE_RUNS) return { reject: "LIMIT_RUNS" };
      return {
        ...card,
        alternativesMeta: { runs: runs + 1, runningSince: stamp },
      };
    },
  });
  if (!claim.ok) {
    if (claim.code === "REJECTED") {
      if (claim.message === "BUSY") {
        return soft("BUSY", copyText("planAlt.busy"));
      }
      if (claim.message === "LIMIT_RUNS") {
        return soft("LIMIT_RUNS", copyText("planAlt.limit"));
      }
    }
    if (claim.code === "WORK_INACTIVE") {
      return NextResponse.json({ error: claim.message }, { status: 409 });
    }
    if (claim.code === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: claim.message }, { status: 409 });
  }

  const claimed = claim.card;
  if (!isPlanCard(claimed)) {
    await releaseClaim(commandId, projectId, stamp);
    return soft("FAILED", copyText("planAlt.failed"));
  }

  // True from the moment the model is called: that call is billed whatever
  // happens next, so a failure after it keeps the run counted.
  let modelCalled = false;

  try {
    // The slots to rethink: every post of a draft, the untouched ones of a
    // saved plan; the soonest ones first, bounded.
    const candidates = claimed.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => {
        if (item.removed) return false;
        if ((item.alternatives?.length ?? 0) >= MAX_ALTERNATIVES_STORED) {
          return false;
        }
        const check = slotStates
          ? canSwapSlot("saved", slotStates[index] ?? null)
          : canSwapSlot("draft", null);
        return check.ok;
      })
      .sort((a, b) => slotWhen(a.item).localeCompare(slotWhen(b.item)))
      .slice(0, MAX_ALTERNATIVE_SLOTS_PER_RUN);

    if (candidates.length === 0) {
      await releaseClaim(commandId, projectId, stamp);
      return soft("NOTHING", copyText("planAlt.nothingLeft"));
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId },
      select: { language: true },
    });
    const language = project?.language || "tr";

    const [rules, twin]: [
      BrandRuleSet | null,
      Awaited<ReturnType<typeof getBrandTwin>>,
    ] = await Promise.all([
      loadBrandRules({ projectId, brandId: access.defaultBrandId, language }),
      getBrandTwin(projectId).catch(() => null),
    ]);

    const otherTopics: string[] = [];
    for (const item of claimed.items) {
      const topic = cleanWorksTextOrNull(item.topic, MAX_TOPIC);
      if (topic) otherTopics.push(topic);
      if (otherTopics.length >= MAX_OTHER_TOPICS) break;
    }

    // The topic that was sent is what a concurrent swap or edit is compared to.
    const sentTopic = new Map<number, string>();
    const slots: SlotFact[] = candidates.map(({ item, index }) => {
      sentTopic.set(index, item.topic);
      const resolved = resolvePlanItem(item);
      const existing = (item.alternatives ?? []).flatMap((alt) => {
        const topic = cleanWorksTextOrNull(alt.topic, MAX_TOPIC);
        return topic ? [topic] : [];
      });
      return {
        index,
        date: item.date,
        channel: item.channel ?? item.platform ?? "",
        format: resolved?.format.label ?? item.format ?? "",
        topic:
          cleanWorksTextOrNull(item.topic, MAX_TOPIC) ?? NEUTRAL_IDEA_LABEL,
        captionIdea: cleanWorksTextOrNull(item.captionIdea, MAX_CAPTION) ?? "",
        existingAlternatives: existing,
      };
    });

    const facts = {
      language,
      goal: isPlanGoal(claimed.goal) ? claimed.goal : null,
      slots,
      otherTopics,
      neverRules: ruleTexts(rules?.never.map((rule) => rule.text) ?? []),
      approvedClaims: ruleTexts(rules?.approvedClaims ?? []),
      competitors: ruleTexts(rules?.competitors ?? []),
      voice: {
        personality: cleanWorksTextOrNull(twin?.voice.personality, 160),
        toneOfVoice: cleanWorksTextOrNull(twin?.voice.toneOfVoice, 160),
      },
      positioning: cleanWorksTextOrNull(twin?.positioning, 200),
      currentFocus: cleanWorksTextOrNull(twin?.currentFocus?.title, 120),
    };

    modelCalled = true;
    const { output } = await ReasoningService.run(planSlotAlternativesDef, {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      context: { facts },
    });

    // Clean, brand-check and keep only what was asked for. A block drops the
    // alternative (the checker runs again when one is swapped in).
    const proposed = new Map<number, PlanAlternative[]>();
    for (const slot of output.slots) {
      if (!sentTopic.has(slot.index) || proposed.has(slot.index)) continue;
      const cleaned: PlanAlternative[] = [];
      for (const alt of slot.alternatives) {
        const topic = cleanWorksTextOrNull(alt.topic, MAX_TOPIC);
        const captionIdea = cleanWorksTextOrNull(alt.captionIdea, MAX_CAPTION);
        if (topic && captionIdea) cleaned.push({ topic, captionIdea });
      }
      const flags = blocksOf(checkItems(cleaned, rules));
      const blocked = new Set(flags.map((entry) => entry.index));
      proposed.set(
        slot.index,
        cleaned.filter((_, i) => !blocked.has(i)),
      );
    }

    let touched = 0;
    const write = await updateCommandCard({
      commandId,
      projectId,
      expectKinds: ["content-plan-draft"],
      requireActiveWork: true,
      update: (card) => {
        if (!isPlanCard(card)) return null;
        touched = 0;
        const allTopics = card.items.map((item) => item.topic);
        const items = card.items.map((item, index) => {
          const list = proposed.get(index);
          // A concurrent swap or edit wins: only the topic that was sent gets
          // new ideas.
          if (
            !list ||
            list.length === 0 ||
            item.topic !== sentTopic.get(index)
          ) {
            return item;
          }
          const existing = item.alternatives ?? [];
          const fresh = normalizeAlternatives(
            list,
            { topic: item.topic, captionIdea: item.captionIdea },
            allTopics,
            existing,
          );
          if (fresh.length === 0) return item;
          touched += 1;
          // Appended: the ideas that came with the pick stay where they are.
          return { ...item, alternatives: [...existing, ...fresh] };
        });
        const meta = card.alternativesMeta;
        const ownsClaim = meta?.runningSince === stamp;
        return {
          ...card,
          items,
          alternativesMeta: ownsClaim
            ? { runs: meta.runs }
            : (meta ?? { runs: 0 }),
        };
      },
    });
    if (!write.ok) {
      await releaseClaim(commandId, projectId, stamp, !modelCalled);
      return soft("FAILED", copyText("planAlt.failed"));
    }

    // Nothing usable came back (cleaned away, brand-blocked, or the topics
    // changed meanwhile). The claim is already cleared by the write; the paid
    // run stays counted. Not "ready": the person is told nothing fit.
    if (touched === 0) {
      return soft("EMPTY", copyText("planAlt.none"));
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "content_plan.alternatives_generated",
      entityType: "Command",
      entityId: commandId,
      metadata: { slots: touched },
    }).catch(() => undefined);

    refreshWorkPages(projectId);
    return NextResponse.json({ ok: true, slots: touched });
  } catch (error) {
    const notice = limitNoticeFromError(error);
    // A cap refusal happens before the model is reached: the run is given
    // back. Any other failure after the call keeps it counted.
    await releaseClaim(commandId, projectId, stamp, !modelCalled || !!notice);
    if (notice) {
      return soft("BUDGET", limitNoticeReplyText(notice));
    }
    console.error(
      "[works] plan alternatives failed:",
      error instanceof Error ? error.message : error,
    );
    return soft("FAILED", copyText("planAlt.failed"));
  }
}
