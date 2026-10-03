import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { copyText } from "@/lib/works/copy";
import {
  ADAPT_CLAIM_TTL_MS,
  MAX_ADAPT_RUNS,
  type MasterContentCardData,
} from "@/lib/works/master-content";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { updateCommandCard } from "@/server/chat/card-store";
import { runMasterAdapt } from "@/server/chat/master-content";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import { isWorksEnabled } from "@/server/works/flag";
import {
  GUARD_MESSAGE,
  idSchema,
  readBoundedJson,
  refreshWorkPages,
} from "@/server/works/guard";

// "Adapt to channels" on a master-content card: ONE reasoning call (plus at
// most one repair) that rewrites the main message per ticked channel. A Route
// Handler, never a Server Action: Next dispatches Server Actions one at a time
// per client, so a slow model call would block Add to calendar from the same
// tab.
//
// The card claim (adapting.startedAt + adaptRuns) is the mutex and the cost
// cap: two tabs make one model call, and a card gets MAX_ADAPT_RUNS runs.

const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;

const BodySchema = z.object({
  commandId: idSchema,
  targets: z
    .array(
      z.object({ channel: z.string().max(32), formatKey: z.string().max(64) }),
    )
    .max(6)
    .optional(),
});


// Soft refusals are 200 with ok:false: the card shows the message, nothing is
// wrong with the request itself.
function soft(code: string, message: string) {
  return NextResponse.json({ ok: false, code, message });
}

function conflict(code: string, message: string) {
  return NextResponse.json({ ok: false, code, message }, { status: 409 });
}

function isMasterCard(card: unknown): card is MasterContentCardData {
  return (
    typeof card === "object" &&
    card !== null &&
    (card as { kind?: unknown }).kind === "master-content" &&
    Array.isArray((card as { targets?: unknown }).targets)
  );
}

function isOpenState(card: MasterContentCardData): boolean {
  return card.state === "draft" || card.state === "adapted";
}

function claimIsLive(startedAt: string | undefined, now: number): boolean {
  if (!startedAt) return false;
  const since = Date.parse(startedAt);
  return Number.isFinite(since) && now - since < ADAPT_CLAIM_TTL_MS;
}

// Gives the claim back after a failed run. The run is refunded only when no
// paid model answer was spent (`refund`): after a model call that ended in a
// validated failure the run stays counted, so a message that never adapts
// cannot be retried forever (the card's MAX_ADAPT_RUNS is the cost cap). Only
// the run that still holds the claim restores it: when the claim expired and
// another run took it over, that run already treated ours as failed.
async function releaseClaim(
  commandId: string,
  projectId: string,
  stamp: string,
  refund: boolean,
): Promise<void> {
  try {
    await updateCommandCard({
      commandId,
      projectId,
      expectKinds: ["master-content"],
      update: (card) => {
        if (!isMasterCard(card)) return null;
        if (card.adapting?.startedAt !== stamp) return null;
        const next: MasterContentCardData = {
          ...card,
          adaptRuns: refund
            ? Math.max(0, (card.adaptRuns ?? 0) - 1)
            : (card.adaptRuns ?? 0),
        };
        delete next.adapting;
        return next;
      },
    });
  } catch (error) {
    console.error(
      "[works] master adapt claim release failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

function sameAdaptation(
  a: MasterContentCardData["targets"][number]["adaptation"],
  b: MasterContentCardData["targets"][number]["adaptation"],
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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
  const { commandId, targets: askedTargets } = parsed.data;

  if (
    isRateLimited(
      `master-adapt:${userId}`,
      RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS,
    )
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
  const work = await WorkRepository.get(projectId, command.workId);
  if (!work) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (work.status !== "ACTIVE") {
    return conflict("WORK", GUARD_MESSAGE.completed);
  }

  // A card that was scheduled meanwhile is a content-plan-draft now: it is
  // never overwritten by an adaptation.
  const storedCard = (command.parsedIntent as { card?: unknown } | null)?.card;
  if (!isMasterCard(storedCard) || !isOpenState(storedCard)) {
    return conflict("WRONG_KIND", copyText("kit.failed"));
  }

  // A mock answer must never be written into a real card.
  if (ReasoningService.isMockMode()) {
    return soft("MOCK", copyText("master.adaptMock"));
  }

  // Claim: this write is the mutex. Two tabs, one model call.
  const stamp = new Date().toISOString();
  const claim = await updateCommandCard({
    commandId,
    projectId,
    expectKinds: ["master-content"],
    requireActiveWork: true,
    update: (card) => {
      if (!isMasterCard(card) || !isOpenState(card)) {
        return { reject: "STATE" };
      }
      if (!card.targets.some((target) => target.included)) {
        return { reject: "NO_TARGETS" };
      }
      const now = Date.now();
      let runs = card.adaptRuns ?? 0;
      if (card.adapting) {
        if (claimIsLive(card.adapting.startedAt, now)) {
          return { reject: "BUSY" };
        }
        // A claim older than the TTL is a crashed run: it must not use up one
        // of the runs.
        runs = Math.max(0, runs - 1);
      }
      if (runs >= MAX_ADAPT_RUNS) return { reject: "LIMIT" };
      return { ...card, adaptRuns: runs + 1, adapting: { startedAt: stamp } };
    },
  });
  if (!claim.ok) {
    if (claim.code === "REJECTED") {
      if (claim.message === "BUSY") {
        return soft("BUSY", copyText("master.adaptBusy"));
      }
      if (claim.message === "LIMIT") {
        return soft("LIMIT", copyText("master.adaptLimit"));
      }
      if (claim.message === "NO_TARGETS") {
        return soft("NO_TARGETS", copyText("master.noTargets"));
      }
      return conflict("WRONG_KIND", copyText("kit.failed"));
    }
    if (claim.code === "WORK_INACTIVE") {
      return conflict("WORK", claim.message);
    }
    if (claim.code === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (claim.code === "WRONG_KIND") {
      return conflict("WRONG_KIND", copyText("kit.failed"));
    }
    return conflict(claim.code, claim.message);
  }

  const claimed = claim.card;
  if (!isMasterCard(claimed)) {
    await releaseClaim(commandId, projectId, stamp, true);
    return soft("FAILED", copyText("master.adaptFailed"));
  }

  // True once the model may have been called (and paid for).
  let modelCalled = false;
  try {
    const language = await brandRuleLanguageOf(projectId);
    const rules = await loadBrandRules({
      projectId,
      brandId: access.defaultBrandId,
      language,
    });
    modelCalled = true;
    const result = await runMasterAdapt({
      scope: {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
      },
      card: claimed,
      commandId,
      targets: askedTargets,
      language,
      rules,
    });
    if (!result.ok) {
      // MOCK, BUDGET and NOTHING made no model call; FAILED did.
      await releaseClaim(commandId, projectId, stamp, result.code !== "FAILED");
      return soft(result.code, result.message);
    }

    // Only the adaptations (and their issues) of the targets this run changed
    // are written, over the CURRENT card: a tick toggled while the model was
    // thinking stays as the person left it.
    let adapted = 0;
    const write = await updateCommandCard({
      commandId,
      projectId,
      expectKinds: ["master-content"],
      requireActiveWork: true,
      update: (card) => {
        if (!isMasterCard(card)) return null;
        // A newer master replaced this one meanwhile: nothing to write into.
        if (card.state === "superseded") return { reject: "STATE" };
        adapted = 0;
        const targets = card.targets.map((target) => {
          const same = (t: { channel: string; formatKey: string }) =>
            t.channel === target.channel && t.formatKey === target.formatKey;
          const before = claimed.targets.find(same);
          const after = result.card.targets.find(same);
          if (!before || !after?.adaptation) return target;
          if (sameAdaptation(before.adaptation, after.adaptation))
            return target;
          adapted += 1;
          return { ...target, adaptation: after.adaptation };
        });
        const next: MasterContentCardData = {
          ...card,
          state: "adapted",
          targets,
        };
        // A run that took the claim over after ours expired keeps its claim.
        if (card.adapting?.startedAt === stamp) delete next.adapting;
        return next;
      },
    });
    if (!write.ok || !isMasterCard(write.card)) {
      await releaseClaim(commandId, projectId, stamp, false);
      return soft("FAILED", copyText("master.adaptFailed"));
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "master_content.adapted",
      entityType: "Command",
      entityId: commandId,
      metadata: { targets: adapted },
    }).catch(() => undefined);

    refreshWorkPages(projectId);
    return NextResponse.json({ ok: true, card: write.card });
  } catch (error) {
    await releaseClaim(commandId, projectId, stamp, !modelCalled);
    console.error(
      "[works] master adapt failed:",
      error instanceof Error ? error.message : error,
    );
    return soft("FAILED", copyText("master.adaptFailed"));
  }
}
