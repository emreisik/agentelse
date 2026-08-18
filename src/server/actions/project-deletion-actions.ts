"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Permanently deletes the project and ALL of its data. There are three gates:
//   1. Workspace membership (requireProjectAccess)
//   2. OWNER/ADMIN role — a regular member cannot delete a project
//   3. The user typing the project name exactly
// To make accidental triggering impossible, the confirmation is also
// validated server-side; client-side validation alone is not sufficient.
export async function deleteProjectAction(
  formData: FormData,
): Promise<ActionResult> {
  let redirectTo: string | null = null;

  try {
    const projectId = String(formData.get("projectId"));
    const confirmation = String(formData.get("confirmation") ?? "").trim();

    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);

    const membership = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (membership?.role !== "OWNER" && membership?.role !== "ADMIN") {
      return {
        ok: false,
        message: "Admin privileges are required to delete a project",
      };
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    if (!project) return { ok: false, message: "Project not found" };

    if (confirmation !== project.name) {
      return {
        ok: false,
        message: `Type the project name exactly to confirm: ${project.name}`,
      };
    }

    const result = await ProjectDeletionService.delete(projectId);

    // The deletion record is kept at the workspace level — if linked to the
    // project, it would fall among the rows just deleted and leave no trace.
    await AuditLogRepository.record({
      workspaceId,
      actorType: "USER",
      actorId: userId,
      action: "project.deleted",
      entityType: "Project",
      entityId: projectId,
      metadata: {
        projectName: result.projectName,
        deletedRows: result.deletedRows,
        deletedFiles: result.deletedFiles,
      },
    }).catch(() => undefined);

    revalidatePath("/dashboard");
    redirectTo = "/dashboard";
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Deletion failed",
    };
  }

  // redirect() works internally by throwing an error; if called inside a
  // try/catch we'd catch its own control-flow signal.
  if (redirectTo) redirect(redirectTo);
  return { ok: true };
}
