import "server-only";

import { prisma } from "@/lib/prisma";
import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import {
  GOOGLE_PROVIDER,
  type GoogleAnalyticsMetadata,
} from "@/server/integrations/google-client";

// Proje ↔ GA4 mülkü bağları (docs/google-analytics-plan.md §4,
// "Backfill tembel ve idempotenttir"): bağ, seçili mülkü olan ACTIVE
// `google_analytics` bağlantısından oluşur. Seçim değişince yeni mülkün bağı
// birincil olur, eskisi birincilliğini kaybeder (senkron durur, verisi
// ga-retention'da silinir). Seçim kalkarsa projenin bütün bağları birincil
// olmaktan çıkar.

type CredentialRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  metadata: unknown;
};

async function reconcileProject(
  credential: CredentialRow | null,
  projectId: string,
) {
  const metadata = (credential?.metadata ??
    null) as GoogleAnalyticsMetadata | null;
  const propertyId = metadata?.selectedGa4PropertyId;
  const links = await prisma.gaPropertyLink.findMany({
    where: { projectId },
    select: {
      id: true,
      propertyId: true,
      isPrimary: true,
      isSecondary: true,
      credentialId: true,
    },
  });

  // Seçili mülk dışındaki birincil bağlar düşer.
  const stale = links
    .filter((link) => link.isPrimary && link.propertyId !== propertyId)
    .map((link) => link.id);
  if (stale.length > 0) {
    await prisma.gaPropertyLink.updateMany({
      where: { id: { in: stale } },
      data: { isPrimary: false, syncLeaseUntil: null, syncLeaseOwner: null },
    });
  }
  if (!credential || !propertyId) return false;

  const existing = links.find((link) => link.propertyId === propertyId);
  if (existing) {
    if (!existing.isPrimary || existing.credentialId !== credential.id) {
      await prisma.gaPropertyLink.update({
        where: { id: existing.id },
        data: {
          isPrimary: true,
          credentialId: credential.id,
          // GA-F8: ek mülk seçimle ana mülk olunca ek olmaktan çıkar.
          ...(existing.isSecondary ? { isSecondary: false } : {}),
        },
      });
    }
    return false;
  }
  const property = metadata?.ga4Properties?.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  await prisma.gaPropertyLink.upsert({
    where: { projectId_propertyId: { projectId, propertyId } },
    create: {
      workspaceId: credential.workspaceId,
      projectId,
      credentialId: credential.id,
      propertyId,
      isPrimary: true,
      isMock: gaMockMode(),
      propertyName: property?.propertyName ?? metadata?.selectedGa4PropertyName,
      accountName: property?.accountName || null,
    },
    update: { isPrimary: true, credentialId: credential.id },
  });
  return true;
}

// Bütün ACTIVE GA bağlantıları için (tick adımı, birkaç dakikada bir).
export async function ensureGaLinks(): Promise<number> {
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      provider: GOOGLE_PROVIDER.analytics,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
    },
    select: { id: true, workspaceId: true, projectId: true, metadata: true },
  });
  let created = 0;
  for (const credential of credentials) {
    if (!gaSyncAllowedFor(credential.projectId)) continue;
    if (await reconcileProject(credential, credential.projectId)) created += 1;
  }
  return created;
}

// Tek proje (mülk seçimi, bağlanma): senkron bir sonraki tick'te başlar.
export async function ensureGaLinkForProject(projectId: string): Promise<void> {
  if (!gaSyncAllowedFor(projectId)) return;
  const credential = await prisma.integrationCredential.findFirst({
    where: {
      projectId,
      provider: GOOGLE_PROVIDER.analytics,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
    },
    select: { id: true, workspaceId: true, projectId: true, metadata: true },
  });
  await reconcileProject(credential, projectId);
}

// Disconnect: bağ ve bütün ambar verisi hemen silinir (cascade). Gizlilik
// metni bunu söyler: "deletes ... the Google data in that connection right
// away".
export async function deleteGaLinksForProject(
  projectId: string,
): Promise<number> {
  const result = await prisma.gaPropertyLink.deleteMany({
    where: { projectId },
  });
  return result.count;
}
