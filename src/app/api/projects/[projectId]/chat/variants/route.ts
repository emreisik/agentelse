import { NextResponse } from "next/server";
import { z } from "zod";

import { getCreativePlatformFormat } from "@/lib/creative-platform-format";
import {
  isChannelKey,
  resolveFormat,
  type ChannelKey,
} from "@/lib/content-channels";
import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { copyText } from "@/lib/works/copy";
import {
  MAX_VARIANT_ALTERNATIVES,
  VARIANT_COUNT,
  VARIANT_QUALITY,
  parseAlternatives,
} from "@/lib/works/variants";
import { isDepartmentInFocus } from "@/server/agency/agency-focus";
import { deriveItemStage } from "@/server/agency/journey/plan-progress";
import {
  RUN_CLAIM_TTL_MS,
  productionFor,
  runSingleSlotVariants,
  type PlanProduction,
} from "@/server/chat/plan-run";
import {
  createChannel,
  runProductionItem,
  type ProductionContext,
  type ProductionSpec,
} from "@/server/chat/production-run";
import { sseRunResponse } from "@/server/chat/run-response";
import type { ChatStreamEvent } from "@/server/chat/types";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
  type LimitNoticeCard,
} from "@/server/commands/limit-notice";
import { planCreativeIdOf } from "@/server/execution/plan-creative-link";
import { ensureProjectActive } from "@/server/projects/activation";
import { estimateImageCostUsd } from "@/server/reasoning/reasoning-pricing";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  assertWorkActive,
  idSchema,
  readBoundedJson,
} from "@/server/works/guard";
import { isWorksEnabled } from "@/server/works/flag";
import { worksProductionGate } from "@/server/works/production-gate";
import {
  isIdeaEventCardData,
  type IdeaEventCardData,
} from "@/types/idea-event-card";

// "Make 3 visuals" / "Make 3 more" on ONE image slot of a Work's plan: an
// EXPLICIT, PAID click, streamed like /chat/plan (run.items / item.* /
// package.done). Never reachable from the agent: RunGuard is not involved, the
// click is the consent. A Route Handler, never a Server Action (a slow render
// would block the same tab's other actions).
//
// Order, and why it matters for money:
//   1. the cheap guards (auth, flag, rate, bounded body, Work ACTIVE),
//   2. the claim: no live Task for the slot and no fresh production claim
//      (the mutex: a second click never pays again),
//   3. ONLY THEN the dollar reserve (checkAndIncrement), and
//   4. the run itself, which takes the card claim (more:false) or creates the
//      variantsOnly Task (more:true).
// The reserve is NOT refunded when the run fails (there is no decrement API):
// it overstates spend, the safe side. SelfHealingService skips variant jobs, so
// a failure never re-bills on its own.

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

const BodySchema = z.object({
  commandId: idSchema,
  creativeId: idSchema,
  more: z.boolean().optional(),
});

const TERMINAL_TASK = ["COMPLETED", "FAILED", "CANCELLED"] as const;

// One variants run per project at a time, in this process (the real mutex
// across processes is the Task / card claim above).
const runningProjects = new Set<string>();

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

function planCardOf(value: unknown): PlanCard | null {
  return isIdeaEventCardData(value) && value.kind === "content-plan-draft"
    ? value
    : null;
}

// A refusal that is the answer to a well-formed request: an SSE stream with one
// error event, like the plan route, so the client has a single reader.
function refuse(
  projectId: string,
  code: string,
  message: string,
  card?: LimitNoticeCard,
): Response {
  return sseRunResponse({
    projectId,
    logTag: "variants-route",
    failureMessage: copyText("variants.failed"),
    run: async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "error", code, message, ...(card ? { card } : {}) };
    },
  });
}

function slotRequest(
  production: PlanProduction,
  creative: { title: string | null; brief: string | null },
  card: PlanCard,
): string {
  const title = creative.title?.trim() || production.label;
  return [
    `${production.label}: ${title}`,
    creative.brief ? `Idea: ${creative.brief}` : undefined,
    card.master?.message
      ? `Master message: ${card.master.message.slice(0, 400)}`
      : undefined,
    `Deliverable: ${production.brief}.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

// Releases the per-project run slot when the stream ends, however it ends.
async function* releasing(
  projectId: string,
  inner: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  try {
    yield* inner;
  } finally {
    runningProjects.delete(projectId);
  }
}

// "Make 3 more" on a piece in review: no slot claim, no Creative, no Approval.
// One variantsOnly Task whose pictures are appended to the piece's alternatives
// (execution-service.ts re-checks the cap inside the write).
async function* runVariantsOnly(
  context: ProductionContext,
  spec: ProductionSpec,
): AsyncGenerator<ChatStreamEvent> {
  yield {
    type: "run.items",
    items: [
      {
        id: spec.itemId,
        title: spec.title,
        label: spec.label,
        department: spec.department,
        image: true,
      },
    ],
  };
  const channel = createChannel<ChatStreamEvent>();
  const work = runProductionItem(spec, context, channel.push).finally(() =>
    channel.close(),
  );
  for await (const event of channel) yield event;
  const outcome = await work;

  if (outcome.planned) {
    await AuditLogRepository.record({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      brandId: context.brandId,
      actorType: "USER",
      actorId: context.userId,
      action: "creative.variants_requested",
      entityType: "Creative",
      entityId: spec.itemId,
      metadata: { more: true, ok: outcome.ok },
    }).catch(() => undefined);
  }
  yield {
    type: "package.done",
    started: outcome.planned ? 1 : 0,
    failed: outcome.ok ? 0 : 1,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

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

  if (!isWorksEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    isRateLimited(`variants:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
  ) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down for a moment." },
      { status: 429 },
    );
  }

  // The PAID route: typed and bounded BEFORE anything is parsed.
  const raw = await readBoundedJson(request);
  if (!raw.ok) {
    return NextResponse.json({ error: raw.message }, { status: raw.status });
  }
  const parsed = BodySchema.safeParse(raw.value);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { commandId, creativeId } = parsed.data;
  const more = parsed.data.more === true;

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

  const card = planCardOf(
    (command.parsedIntent as { card?: unknown } | null)?.card,
  );
  if (!card || card.state !== "saved") {
    return NextResponse.json(
      { error: "This plan can't make visuals." },
      { status: 409 },
    );
  }
  // Single slot only, and only a slot of THIS saved plan.
  if (!(card.savedCreativeIds ?? []).includes(creativeId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId, planId: commandId },
    select: {
      id: true,
      status: true,
      currentVersionId: true,
      channel: true,
      formatKey: true,
      title: true,
      brief: true,
    },
  });
  if (!creative) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only an image format of a channel the catalog knows can be made in three.
  const channel: ChannelKey | undefined = isChannelKey(creative.channel)
    ? creative.channel
    : undefined;
  const format =
    channel && creative.formatKey
      ? resolveFormat(channel, creative.formatKey)
      : undefined;
  const production =
    channel && format ? productionFor(channel, format) : undefined;
  const cantMake = "This piece can't be made in three versions.";
  if (
    !production ||
    !production.image ||
    !isDepartmentInFocus(production.department)
  ) {
    return refuse(projectId, "STATE", cantMake);
  }

  // The Work's own channels (a slot on a channel the Work no longer covers).
  const gate = await worksProductionGate(prisma, {
    projectId,
    commandId,
    slotChannels: creative.channel ? [creative.channel] : undefined,
  });
  if (!gate.ok) return refuse(projectId, "STATE", gate.message);

  // One variants run per project at a time (this process).
  if (runningProjects.has(projectId)) {
    return refuse(projectId, "BUSY", "This piece is already being made.");
  }
  runningProjects.add(projectId);
  let streaming = false;
  try {
    // ---- 2. CLAIM, before any money moves ----------------------------------
    const now = Date.now();
    const running = card.production;
    if (
      running?.state === "running" &&
      now - Date.parse(running.startedAt) < RUN_CLAIM_TTL_MS
    ) {
      return refuse(projectId, "BUSY", "This plan is already being produced.");
    }
    const taskRows = await prisma.task.findMany({
      where: { projectId, commandId },
      select: { status: true, payload: true, updatedAt: true },
    });
    const slotTasks = taskRows.filter(
      (task) => planCreativeIdOf(task.payload) === creativeId,
    );
    if (
      slotTasks.some(
        (task) => !(TERMINAL_TASK as readonly string[]).includes(task.status),
      )
    ) {
      return refuse(projectId, "BUSY", "This plan is already being produced.");
    }

    if (more) {
      // A second set: only on a piece in review, while the cap has room.
      if (creative.status !== "IN_REVIEW" || !creative.currentVersionId) {
        return refuse(projectId, "STATE", cantMake);
      }
      const first = await prisma.creativeVersion.findFirst({
        where: { creativeId, version: 1 },
        select: { generationMetadata: true },
      });
      const have = parseAlternatives(first?.generationMetadata).length;
      // A "more" job appends VARIANT_COUNT pictures as alternatives.
      if (have + VARIANT_COUNT > MAX_VARIANT_ALTERNATIVES) {
        return refuse(projectId, "LIMIT", copyText("variants.limit"));
      }
    } else {
      // The first set: an empty slot (planned, or its last job failed).
      const stage = deriveItemStage(creative, slotTasks);
      if (stage !== "PLANNED" && stage !== "FAILED") {
        return refuse(projectId, "STATE", cantMake);
      }
    }

    const activation = await ensureProjectActive(projectId);
    if (!activation.usable) {
      return refuse(
        projectId,
        "PROJECT_INACTIVE",
        "This project is on hold, so no new work can start.",
      );
    }

    // ---- 3. RESERVE the dollars --------------------------------------------
    const size = (() => {
      const { width, height } = getCreativePlatformFormat(
        production.targetPlatform,
        production.contentFormat,
      ).pixelSize;
      return `${width}x${height}`;
    })();
    const costUsd =
      estimateImageCostUsd({ quality: VARIANT_QUALITY, size }) * VARIANT_COUNT;
    try {
      await AutonomyPolicyRepository.checkAndIncrement(
        {
          workspaceId: access.workspaceId,
          projectId,
          brandId: access.defaultBrandId,
        },
        "reasoningCalls",
        0,
        costUsd,
      );
    } catch (error) {
      const notice = limitNoticeFromError(error);
      if (notice) {
        return refuse(
          projectId,
          "BUDGET",
          limitNoticeReplyText(notice),
          notice,
        );
      }
      console.error(
        "[variants-route] reserve failed:",
        error instanceof Error ? error.message : error,
      );
      return refuse(projectId, "FAILED", copyText("variants.failed"));
    }

    // ---- 4. RUN -------------------------------------------------------------
    const context: ProductionContext = {
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      userId,
      commandId,
    };
    const run = more
      ? () =>
          runVariantsOnly(
            // The piece exists already and no card is polled for: do not wait.
            { ...context, finalCardPolls: { tries: 0, everyMs: 0 } },
            {
              itemId: creativeId,
              title: creative.title?.trim() || production.label,
              label: production.label,
              department: production.department,
              capability: production.capability,
              targetPlatform: production.targetPlatform,
              request: slotRequest(production, creative, card),
              payloadExtra: {
                planCreativeId: creativeId,
                variantsOnly: true,
                variantCount: VARIANT_COUNT,
                quality: VARIANT_QUALITY,
                contentFormat: production.contentFormat,
              },
              logPrefix: `[variants-route] ${production.label}`,
            },
          )
      : () => runSingleSlotVariants({ ...context, creativeId });

    streaming = true;
    return sseRunResponse({
      projectId,
      logTag: "variants-route",
      failureMessage: copyText("variants.failed"),
      run: () => releasing(projectId, run()),
    });
  } finally {
    // The stream releases the slot itself once it runs; every earlier exit
    // (a refusal, a throw) releases it here.
    if (!streaming) runningProjects.delete(projectId);
  }
}
