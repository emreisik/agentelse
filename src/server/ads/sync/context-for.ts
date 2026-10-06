import "server-only";

import type { AdsAccount } from "@prisma/client";

import { safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { decryptSecret } from "@/server/security/crypto";

import type { SyncContext, SyncProject } from "./context";

// Senkron dışı işlerin (webhook işleyicisi, async insights) hesap bağlamı:
// seçili projeler + ACTIVE bağlantının token'ı. Bağlantı yoksa null.

export type AccountWithProjects = AdsAccount & {
  projects: { projectId: string; brandId: string }[];
};

export async function syncContextFor(
  account: AccountWithProjects,
  now: Date,
): Promise<SyncContext | null> {
  if (!account.credentialId || account.projects.length === 0) return null;
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: account.credentialId },
    select: { status: true, encryptedSecret: true },
  });
  if (!credential || credential.status !== "ACTIVE" || !credential.encryptedSecret) {
    return null;
  }
  const rows = await prisma.project.findMany({
    where: { id: { in: account.projects.map((link) => link.projectId) } },
    select: { id: true, workspaceId: true, name: true, status: true },
  });
  const brandOf = new Map(account.projects.map((link) => [link.projectId, link.brandId]));
  const projects: SyncProject[] = rows.map((row) => ({
    projectId: row.id,
    workspaceId: row.workspaceId,
    brandId: brandOf.get(row.id) ?? "",
    name: row.name,
    status: row.status,
  }));
  const timezone = safeTimezone(account.timezoneName);
  return {
    account,
    accessToken: decryptSecret(credential.encryptedSecret),
    externalId: account.externalId,
    currency: account.currency,
    timezone,
    today: dayKeyInTimezone(now, timezone),
    now,
    projects,
    primaryProjectId: projects[0]?.projectId ?? null,
  };
}
