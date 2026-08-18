"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";

export type ActionResult = { ok: true } | { ok: false; message: string };

async function loadApprovalForUser(approvalId: string, userId: string) {
  const approval = await prisma.approval.findUniqueOrThrow({
    where: { id: approvalId },
  });
  await requireProjectAccess(userId, approval.projectId);
  return approval;
}

export async function approveApprovalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const approvalId = String(formData.get("approvalId"));
    const { userId } = await requireUser();
    const approval = await loadApprovalForUser(approvalId, userId);

    await applyApprovalDecision({
      approval,
      to: "APPROVED",
      reviewedByUserId: userId,
      actorType: "USER",
    });

    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}

export async function rejectApprovalAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const approvalId = String(formData.get("approvalId"));
    const { userId } = await requireUser();
    const approval = await loadApprovalForUser(approvalId, userId);

    await applyApprovalDecision({
      approval,
      to: "REJECTED",
      reviewedByUserId: userId,
      actorType: "USER",
    });

    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Operation failed",
    };
  }
}
