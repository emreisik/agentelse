"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/server/actions/agency-config-actions";
import { isIdeaEventCardData } from "@/types/idea-event-card";
import {
  CHANNELS,
  isChannelKey,
  resolveFormat,
} from "@/lib/content-channels";
import { dayKeyInTimezone } from "@/lib/timezone";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { CreativeRepository } from "@/server/repositories/creative.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { loadPlanResults } from "@/server/agency/journey/results";
import {
  enableScheduledPublishing,
  planPublishTimes,
} from "@/server/scheduler/plan-publishing";
import type { JourneyResult } from "@/lib/journey";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Clicks that move a saved content plan along (the plan card and the
// "next step" bar). Every one is a plain approval/state change the client
// could make piece by piece; these only make it one click.

export type ApproveAllResult =
  | { ok: true; approved: number; failed: number }
  | { ok: false; message: string };

// "Approve all" on a saved plan card: decides every creative of the plan that
// is waiting for the client, one after another through the same path a single
// Approve takes (applyApprovalDecision), so what approving does (queue for the
// planned time, publish, propose a campaign) is exactly what it does for one
// piece. A piece that cannot be approved is counted, never hides the others.
export async function approvePlanItemsAction(
  commandId: string,
): Promise<ApproveAllResult> {
  try {
    const { userId } = await requireUser();

    const command = await prisma.command.findUnique({
      where: { id: commandId },
      select: { projectId: true, parsedIntent: true },
    });
    if (!command?.projectId) return { ok: false, message: "Plan not found." };
    const access = await requireProjectAccess(userId, command.projectId);

    const card = (command.parsedIntent as { card?: unknown } | null)?.card;
    if (!isIdeaEventCardData(card) || card.kind !== "content-plan-draft") {
      return { ok: false, message: "Plan not found." };
    }
    const slotIds = card.savedCreativeIds ?? [];
    if (slotIds.length === 0) {
      return { ok: false, message: "This plan has no saved pieces." };
    }

    // Tenant-scoped: the approvals of THIS project's creatives only.
    const approvals = await prisma.approval.findMany({
      where: {
        projectId: command.projectId,
        entityType: "Creative",
        entityId: { in: slotIds },
        status: "PENDING",
      },
      orderBy: { createdAt: "asc" },
    });
    if (approvals.length === 0) {
      return { ok: false, message: "Nothing is waiting for your decision." };
    }

    let approved = 0;
    let failed = 0;
    for (const approval of approvals) {
      try {
        await applyApprovalDecision({
          approval,
          to: "APPROVED",
          reviewedByUserId: userId,
          actorType: "USER",
        });
        approved += 1;
      } catch (error) {
        failed += 1;
        console.error(
          "[plan-progress] approve failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: command.projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "content_plan.approved_all",
      entityType: "Command",
      entityId: commandId,
      metadata: { approved, failed },
    }).catch(() => undefined);

    revalidatePath(`/projects/${command.projectId}`);
    revalidatePath(`/projects/${command.projectId}/takvim`);
    revalidatePath("/dashboard");
    return { ok: true, approved, failed };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export type ScheduledPublishingResult =
  | { ok: true; times: string[] }
  | { ok: false; message: string };

// "Turn on scheduled posting": approved Instagram pieces with a planned time
// are released at that time by the Publishing schedule. Uses the client's own
// slots when they have some (just switches them on), otherwise makes them from
// the clock times the plan uses; either way they are the ones Settings ->
// Publishing shows.
export async function enablePlanPublishingAction(
  projectId: string,
): Promise<ScheduledPublishingResult> {
  try {
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const targets = await getPublishTargets(projectId);
    if (!targets.some((t) => t.platform === "instagram")) {
      return { ok: false, message: "Connect Instagram first." };
    }

    const [timezone, planned] = await Promise.all([
      getProjectTimezone(projectId),
      prisma.creative.findMany({
        where: {
          projectId,
          planId: { not: null },
          platform: "INSTAGRAM",
          status: { in: ["DRAFT", "IN_REVIEW", "APPROVED"] },
          scheduledFor: { gt: new Date() },
        },
        select: { scheduledFor: true },
      }),
    ]);
    const times = planPublishTimes(
      planned.flatMap((row) => (row.scheduledFor ? [row.scheduledFor] : [])),
      timezone,
    );
    const { turnedOn } = await enableScheduledPublishing({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      timezone,
      times,
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "instagram_publish_schedule.enabled_from_plan",
      entityType: "ProjectSchedule",
      entityId: projectId,
      metadata: { times, turnedOn },
    }).catch(() => undefined);

    revalidatePath(`/projects/${projectId}`);
    return { ok: true, times };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export type ManualPublishItem = {
  id: string;
  title: string;
  // "Blog / SEO · Article".
  where: string;
  // The planned day (YYYY-MM-DD in the project's timezone).
  date: string;
  // What to paste: the caption, else the copy.
  text: string;
  assetId?: string;
};

// What the client needs to post these pieces themselves: their text and image.
// Only approved pieces of the caller's project.
export async function getManualPublishItemsAction(
  projectId: string,
  creativeIds: string[],
): Promise<
  { ok: true; items: ManualPublishItem[] } | { ok: false; message: string }
> {
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    const timezone = await getProjectTimezone(projectId);

    const rows = await prisma.creative.findMany({
      where: { id: { in: creativeIds }, projectId, status: "APPROVED" },
      orderBy: [{ scheduledFor: { sort: "asc", nulls: "last" } }],
      select: {
        id: true,
        title: true,
        channel: true,
        formatKey: true,
        scheduledFor: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { caption: true, copy: true, assetId: true },
        },
      },
    });
    return {
      ok: true,
      items: rows.map((row) => {
        const channel = isChannelKey(row.channel) ? row.channel : undefined;
        const format =
          channel && row.formatKey
            ? resolveFormat(channel, row.formatKey)
            : undefined;
        const version = row.versions[0];
        return {
          id: row.id,
          title: row.title ?? "Untitled",
          where: channel
            ? format
              ? `${CHANNELS[channel].label} · ${format.label}`
              : CHANNELS[channel].label
            : "Post",
          date: row.scheduledFor
            ? dayKeyInTimezone(row.scheduledFor, timezone)
            : "",
          text: version?.caption || version?.copy || "",
          assetId: version?.assetId ?? undefined,
        };
      }),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// "I published it": the client posted an approved piece themselves (a Reel, a
// carousel, a blog article, a LinkedIn or X post...). The piece becomes
// PUBLISHED through the same state machine every publish goes through, and the
// chat card that carries it shows it.
export async function markCreativePublishedAction(
  creativeId: string,
): Promise<ActionResult> {
  try {
    const { userId } = await requireUser();
    const creative = await prisma.creative.findUnique({
      where: { id: creativeId },
      select: { projectId: true, status: true, createdByTaskId: true },
    });
    if (!creative) return { ok: false, message: "Piece not found." };
    const access = await requireProjectAccess(userId, creative.projectId);
    if (creative.status !== "APPROVED") {
      return {
        ok: false,
        message:
          creative.status === "PUBLISHED"
            ? "This piece is already marked as published."
            : "Approve this piece before marking it as published.",
      };
    }

    await CreativeRepository.transition(
      creativeId,
      creative.projectId,
      "PUBLISHED",
    );
    if (creative.createdByTaskId) {
      await IdeaChatRepository.markCreativePublishState({
        taskId: creative.createdByTaskId,
        creativeId,
        publishState: "published",
        publishedAt: new Date(),
      }).catch(() => false);
    }
    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId: creative.projectId,
      brandId: access.defaultBrandId,
      actorType: "USER",
      actorId: userId,
      action: "creative.marked_published",
      entityType: "Creative",
      entityId: creativeId,
    }).catch(() => undefined);

    revalidatePath(`/projects/${creative.projectId}`);
    revalidatePath(`/projects/${creative.projectId}/takvim`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

// What the measurement loop reported about the plan's published pieces, in its
// own words (nothing computed here). Tenant-scoped through the project access.
export async function getPlanResultsAction(
  projectId: string,
): Promise<
  { ok: true; results: JourneyResult[] } | { ok: false; message: string }
> {
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    return { ok: true, results: await loadPlanResults(projectId) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
