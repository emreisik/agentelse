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

// Projeyi ve ona ait TÜM veriyi kalıcı olarak siler. Üç kapı var:
//   1. Çalışma alanı üyeliği (requireProjectAccess)
//   2. OWNER/ADMIN rolü — sıradan üye proje silemez
//   3. Kullanıcının proje adını harfi harfine yazması
// Yanlışlıkla tetiklenmesi mümkün olmasın diye onay sunucu tarafında da
// doğrulanır; istemci tarafı kontrolü tek başına yeterli değildir.
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
        message: "Proje silmek için yönetici yetkisi gerekir",
      };
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });
    if (!project) return { ok: false, message: "Proje bulunamadı" };

    if (confirmation !== project.name) {
      return {
        ok: false,
        message: `Onaylamak için proje adını tam olarak yazın: ${project.name}`,
      };
    }

    const result = await ProjectDeletionService.delete(projectId);

    // Silme kaydı çalışma alanı seviyesinde tutulur — projeye bağlanırsa
    // az önce silinen satırların arasına düşer ve iz kalmaz.
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
      message: error instanceof Error ? error.message : "Silme başarısız",
    };
  }

  // redirect() içeride bir hata fırlatarak çalışır; try/catch içinde
  // çağrılırsa kendi kontrol akışını yakalarız.
  if (redirectTo) redirect(redirectTo);
  return { ok: true };
}
