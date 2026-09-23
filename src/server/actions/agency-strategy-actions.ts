"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";
import { TaskRepository } from "@/server/repositories/task.repository";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "Operation failed",
  };
}

async function audit(
  workspaceId: string,
  projectId: string,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
) {
  await AuditLogRepository.record({
    workspaceId,
    projectId,
    actorType: "USER",
    actorId: userId,
    action,
    entityType,
    entityId,
  });
}

export async function approveGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const goalId = String(formData.get("goalId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await ProjectGoalRepository.transition(goalId, projectId, "APPROVED", {
      approvedByType: "USER",
      approvedByUserId: userId,
    });
    await ProjectGoalRepository.transition(goalId, projectId, "ACTIVE");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "goal.approved",
      "ProjectGoal",
      goalId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const goalId = String(formData.get("goalId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await ProjectGoalRepository.transition(goalId, projectId, "REJECTED");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "goal.rejected",
      "ProjectGoal",
      goalId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

const GoalUpdateSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  priority: z.coerce.number().int().min(1).max(5),
  targetValue: z
    .union([z.literal(""), z.coerce.number()])
    .transform((v) => (v === "" ? null : v)),
});

export async function updateGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const goalId = String(formData.get("goalId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const goal = await ProjectGoalRepository.findByIdInProject(
      goalId,
      projectId,
    );
    if (!goal) return { ok: false, message: "Goal not found" };

    const parsed = GoalUpdateSchema.parse({
      title: formData.get("title"),
      description: formData.get("description") ?? undefined,
      priority: formData.get("priority"),
      targetValue: formData.get("targetValue") ?? "",
    });

    await prisma.projectGoal.update({
      where: { id: goalId },
      data: {
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
        targetValue: parsed.targetValue,
      },
    });
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "goal.updated",
      "ProjectGoal",
      goalId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function dismissOpportunityAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const opportunityId = String(formData.get("opportunityId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await OpportunityRepository.transition(
      opportunityId,
      projectId,
      "DISMISSED",
    );
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "opportunity.dismissed",
      "Opportunity",
      opportunityId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function approveIdeaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const ideaId = String(formData.get("ideaId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await IdeaRepository.transition(ideaId, projectId, "APPROVED");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "idea.approved",
      "Idea",
      ideaId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectIdeaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const ideaId = String(formData.get("ideaId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await IdeaRepository.transition(ideaId, projectId, "REJECTED");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "idea.rejected",
      "Idea",
      ideaId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function archiveIdeaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const ideaId = String(formData.get("ideaId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    await IdeaRepository.transition(ideaId, projectId, "ARCHIVED");
    await audit(
      access.workspaceId,
      projectId,
      userId,
      "idea.archived",
      "Idea",
      ideaId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

const NON_TERMINAL_TASK_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_INPUT",
  "WAITING_HUMAN",
  "WAITING_APPROVAL",
  "WAITING_PROVIDER",
  "VERIFYING",
  "BLOCKED",
] as const;

// "This idea's direction is wrong, try again with feedback" — the one path
// that previously didn't exist at all: rejecting/archiving an idea was
// permanent (IDEA_TRANSITIONS: REJECTED/ARCHIVED have no legal exit), with
// no way to feed back what was wrong or get a fresh attempt at the same
// angle. Archives the idea (freeing its maxActiveIdeas slot — countActive
// excludes ARCHIVED/REJECTED), cancels whatever work was already in flight
// under it, then asks IdeaFoundry for exactly one new idea for the SAME
// lens, with the rejected attempt + feedback as explicit prompt context
// (idea-generation.ts). Requires the idea to have come from an
// Opportunity+lens (the Foundry's only entry point) — a manually-created
// idea with neither is archived but not regenerated; the caller creates a
// replacement idea directly instead.
export async function reviseIdeaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const ideaId = String(formData.get("ideaId"));
    const feedback = String(formData.get("feedback") ?? "").trim();
    if (!feedback) {
      return { ok: false, message: "Feedback is required to revise an idea" };
    }
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const idea = await IdeaRepository.findByIdInProject(ideaId, projectId);
    if (!idea) {
      return { ok: false, message: "Idea not found" };
    }

    if (idea.workPlanId) {
      const openTasks = await prisma.task.findMany({
        where: {
          workPlanId: idea.workPlanId,
          projectId,
          status: { in: [...NON_TERMINAL_TASK_STATUSES] },
        },
        select: { id: true },
      });
      for (const task of openTasks) {
        try {
          await TaskRepository.transition(task.id, projectId, "CANCELLED", {
            failureReason: "Idea revised — superseding the current direction",
          });
        } catch {
          // Best-effort — a task that raced to a terminal status between
          // the query above and here isn't worth failing the revision over.
        }
      }
    }

    if (idea.status !== "REJECTED" && idea.status !== "ARCHIVED") {
      await IdeaRepository.transition(ideaId, projectId, "ARCHIVED");
    }

    let regenerated = false;
    if (idea.opportunityId && idea.lens) {
      const created = await IdeaFoundry.generateForOpportunity(
        idea.opportunityId,
        projectId,
        {
          lenses: [idea.lens],
          feedback,
          priorIdea: { title: idea.title, description: idea.description },
        },
      );
      regenerated = created > 0;
    }

    await IdeaChatRepository.postSystemMessage({
      workspaceId: access.workspaceId,
      projectId,
      ideaId,
      text: regenerated
        ? `💡 Idea revised per your feedback: "${feedback}" — a new idea for this angle is starting above.`
        : `💡 Idea archived per your feedback: "${feedback}" — no opportunity/lens on this idea to regenerate from, so no automatic replacement was created.`,
    }).catch((error) => {
      console.error(
        "[agency-strategy-actions] revise chat message failed:",
        error,
      );
    });

    await audit(
      access.workspaceId,
      projectId,
      userId,
      "idea.revised",
      "Idea",
      ideaId,
    );
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
