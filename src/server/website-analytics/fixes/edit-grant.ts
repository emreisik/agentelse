import "server-only";

import { prisma } from "@/lib/prisma";
import {
  parseGaEditGrant,
  type GaEditGrant,
} from "@/lib/website-analytics/fixes/edit-grant";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";

// analytics.edit izninin sunucu tarafı: metadata.gaEdit okuma/yazma. İzin
// her yazmanın kapısıdır; yazılması yalnız yükseltme callback'inde olur.

export type GaEditAccess = {
  credentialId: string;
  workspaceId: string;
  granted: boolean;
  grantedAt: string | null;
  grantedByUserId: string | null;
  connectedEmail: string | null;
  mock: boolean;
};

// ACTIVE ve token'ı olan google_analytics bağlantısı yoksa null. Mock modda
// izin verilmiş sayılır (Google'a hiç gidilmez).
export async function loadGaEditAccess(
  projectId: string,
  options?: { mock?: boolean },
): Promise<GaEditAccess | null> {
  const mock = options?.mock ?? gaMockMode();
  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: {
        projectId,
        provider: GOOGLE_PROVIDER.analytics,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      encryptedSecret: true,
      metadata: true,
    },
  });
  if (!credential || credential.status !== "ACTIVE") return null;
  if (!credential.encryptedSecret) return null;

  const metadata = credential.metadata as { connectedEmail?: unknown } | null;
  const grant = parseGaEditGrant(credential.metadata);
  return {
    credentialId: credential.id,
    workspaceId: credential.workspaceId,
    granted: mock || grant !== null,
    grantedAt: grant?.grantedAt ?? null,
    grantedByUserId: grant?.grantedByUserId ?? null,
    connectedEmail:
      typeof metadata?.connectedEmail === "string"
        ? metadata.connectedEmail
        : null,
    mock,
  };
}

// Anahtar anahtar yazılır (jsonb_set): bütün nesneyi yazmak, başka bir işin
// yazdığı googleHealth gibi alanları geri alırdı. Koparılmış ya da süresi
// dolmuş satıra yazılmaz.
export async function markGaEditGranted(
  credentialId: string,
  grant: GaEditGrant,
): Promise<void> {
  await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{gaEdit}', ${JSON.stringify(grant)}::jsonb) WHERE id = ${credentialId} AND status = 'ACTIVE'`;
  // İzin yeniden verilince değişiklik geçmişi imleci sıfırlanır: düzenleme
  // kapalıyken geçen boşluk için uyarı üretilmez.
  await prisma.$executeRaw`UPDATE "GaChangeWatch" SET "cursorAt" = NULL WHERE "linkId" IN (SELECT id FROM "GaPropertyLink" WHERE "credentialId" = ${credentialId})`;
}

export async function clearGaEditGrant(credentialId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "IntegrationCredential" SET metadata = coalesce(metadata, '{}'::jsonb) - 'gaEdit' WHERE id = ${credentialId}`;
}
