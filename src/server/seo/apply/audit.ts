import "server-only";

import type {
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoChangeSource,
} from "@/lib/seo/apply/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// SC-F8 denetim kaydı. Metadata YALNIZ {changeId, kind, source?, code?,
// dailyLimit?}: sayfa adresi, başlık, makale metni, WordPress ham hatası ya da
// kimlik bilgisi hiçbir zaman girmez.

export type SeoApplyAuditAction =
  | "seo_change.proposed"
  | "seo_change.approved"
  | "seo_change.applied"
  | "seo_change.verified"
  | "seo_change.failed"
  | "seo_change.undone"
  | "seo_change.expired"
  | "seo_change.rejected"
  | "seo_apply.settings_saved";

export type SeoApplyAuditMeta = {
  changeId?: string;
  kind?: SeoChangeKind;
  source?: SeoChangeSource;
  code?: SeoChangeErrorCode;
  dailyLimit?: number;
};

export async function recordSeoApplyAudit(
  action: SeoApplyAuditAction,
  meta: SeoApplyAuditMeta,
  ctx: { workspaceId: string; projectId: string; userId?: string | null },
): Promise<void> {
  try {
    const metadata: Record<string, unknown> = {};
    if (meta.changeId) metadata.changeId = meta.changeId;
    if (meta.kind) metadata.kind = meta.kind;
    if (meta.source) metadata.source = meta.source;
    if (meta.code) metadata.code = meta.code;
    if (meta.dailyLimit !== undefined) metadata.dailyLimit = meta.dailyLimit;

    await AuditLogRepository.record({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      actorType: ctx.userId ? "USER" : "SYSTEM",
      actorId: ctx.userId ?? undefined,
      action,
      entityType: meta.changeId ? "SeoChange" : "Project",
      entityId: meta.changeId ?? ctx.projectId,
      metadata,
    });
  } catch (error) {
    // Denetim yazılamazsa asıl iş bozulmaz.
    console.error(
      "[seo-apply] audit could not be recorded:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
