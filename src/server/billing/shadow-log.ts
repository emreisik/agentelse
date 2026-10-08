import "server-only";

import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Gölge modda "enforce olsaydı engellenirdi" kararları: sorgulanabilir olsun diye
// AuditLog'a (workspace düzeyinde, projectId'siz) yazılır. Aynı workspace ve neden
// için süreç başına saatte en çok bir satır: sıcak yolu ve tabloyu şişirmez.
const WINDOW_MS = 60 * 60 * 1000;
const seen = new Map<string, number>();

export async function recordShadowDecision(input: {
  workspaceId: string;
  kind: "brand_limit" | "not_entitled" | "unit_not_sold" | "insufficient";
  detail?: Record<string, unknown>;
  now?: Date;
}): Promise<void> {
  const nowMs = (input.now ?? new Date()).getTime();
  const key = `${input.workspaceId}:${input.kind}`;
  const last = seen.get(key);
  if (last !== undefined && nowMs - last < WINDOW_MS) return;
  seen.set(key, nowMs);
  try {
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      actorType: "SYSTEM",
      action: `billing.shadow.${input.kind}`,
      entityType: "Workspace",
      entityId: input.workspaceId,
      metadata: input.detail,
    });
  } catch (error) {
    console.error(
      "[billing] could not record shadow decision:",
      error instanceof Error ? error.name : error,
    );
  }
}

// Testler için: bellek içi kısmayı sıfırla.
export function resetShadowLogThrottle(): void {
  seen.clear();
}
