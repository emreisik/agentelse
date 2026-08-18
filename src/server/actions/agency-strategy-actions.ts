"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";
import { prisma } from "@/lib/prisma";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

function fail(error: unknown): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : "İşlem başarısız",
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
    if (!goal) return { ok: false, message: "Hedef bulunamadı" };

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
