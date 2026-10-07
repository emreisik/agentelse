import "server-only";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

import type { GaFixAuditAction, GaFixAuditMeta } from "./types";

// GA-F7 denetim kaydı. Metadata YALNIZ {changeId, kind, source?, code?}:
// olay adı, kampanya adı, mülk adı ya da Google ham hatası hiçbir zaman
// girmez (AuditLog silinen bağla birlikte cascade ile gitmez).
export async function recordGaFixAudit(
  action: GaFixAuditAction,
  meta: GaFixAuditMeta,
  ctx: { workspaceId: string; projectId: string; userId?: string | null },
): Promise<void> {
  try {
    const metadata: Record<string, unknown> = {
      changeId: meta.changeId,
      kind: meta.kind,
    };
    if (meta.source) metadata.source = meta.source;
    if (meta.code) metadata.code = meta.code;

    await AuditLogRepository.record({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorType: ctx.userId ? "USER" : "SYSTEM",
      actorId: ctx.userId ?? undefined,
      action,
      entityType: "GaConfigChange",
      entityId: meta.changeId,
      metadata,
    });
  } catch (error) {
    // Denetim yazılamazsa asıl iş bozulmaz.
    console.error(
      "[ga-fixes] audit could not be recorded:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
