import "server-only";

import type { Prisma } from "@prisma/client";

import { parseBrandTermsConfig } from "@/lib/seo/brand-terms";
import { gscRestrictedProjects, gscSyncAllowedFor } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import {
  GOOGLE_PROVIDER,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { propertyTypeOf } from "@/server/integrations/search-console/sites";
import { deleteSearchConsoleAlertsForProjects } from "@/server/seo/health/alerts";
import { forgetSearchOpportunitiesForLinks } from "@/server/seo/opportunities/forget";
import { SeoSites } from "@/server/seo/site/sites";

// Proje ↔ Search Console sitesi bağları (docs/google-search-console-plan.md
// §4, "tembel bağ"): bağ, seçili sitesi olan ACTIVE
// `google_search_console` bağlantısından oluşur. Seçim değişince yeni sitenin
// bağı birincil olur; eskisi birincilliğini kaybeder, demotedAt yazılır
// (senkron durur, 30 gün sonra seo-retention'da silinir). Yeniden seçilirse
// demotedAt temizlenir. Diğer kipin (mock/canlı) bağlarına dokunulmaz.

type CredentialRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  metadata: unknown;
};

const CREDENTIAL_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  metadata: true,
} as const;

async function reconcileProject(
  credential: CredentialRow | null,
  projectId: string,
  now: Date,
): Promise<boolean> {
  // Bağlantı yoksa (ya da ACTIVE/EXPIRED değilse) seçim bilinmiyor demektir:
  // hiçbir bağ düşürülmez. Bağlantısı silinen bağları Disconnect ve
  // seo-retention temizler.
  if (!credential) return false;
  const metadata = (credential.metadata ??
    null) as GoogleSearchConsoleMetadata | null;
  const siteUrl = metadata?.selectedSearchConsoleSite;
  const mock = gscMockMode();
  const links = await prisma.gscSiteLink.findMany({
    where: { projectId },
    select: {
      id: true,
      siteUrl: true,
      isPrimary: true,
      isMock: true,
      credentialId: true,
    },
  });

  // Seçili site dışındaki birincil bağlar (aynı kipte) düşer.
  const stale = links
    .filter(
      (link) =>
        link.isPrimary && link.isMock === mock && link.siteUrl !== siteUrl,
    )
    .map((link) => link.id);
  if (stale.length > 0) {
    await prisma.gscSiteLink.updateMany({
      where: { id: { in: stale } },
      data: {
        isPrimary: false,
        demotedAt: now,
        syncLeaseUntil: null,
        syncLeaseOwner: null,
      },
    });
  }
  if (!siteUrl) return false;

  const existing = links.find((link) => link.siteUrl === siteUrl);
  if (existing) {
    if (existing.isMock !== mock) return false;
    if (!existing.isPrimary || existing.credentialId !== credential.id) {
      await prisma.gscSiteLink.update({
        where: { id: existing.id },
        data: {
          isPrimary: true,
          demotedAt: null,
          credentialId: credential.id,
        },
      });
    }
    return false;
  }
  const site = metadata?.searchConsoleSites?.find(
    (candidate) => candidate.siteUrl === siteUrl,
  );
  await prisma.gscSiteLink.upsert({
    where: { projectId_siteUrl: { projectId, siteUrl } },
    create: {
      workspaceId: credential.workspaceId,
      projectId,
      credentialId: credential.id,
      siteUrl,
      isPrimary: true,
      isMock: mock,
      propertyType: propertyTypeOf(siteUrl),
      permissionLevel: site?.permissionLevel ?? null,
    },
    update: {},
  });
  return true;
}

// Bütün ACTIVE Search Console bağlantıları için (tick adımı, birkaç dakikada
// bir). Kısıtlı listede (geliştirme / kademeli açılış) yalnız o projeler.
export async function ensureGscLinks(): Promise<number> {
  const restricted = gscRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      provider: GOOGLE_PROVIDER.search_console,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
      ...(restricted ? { projectId: { in: restricted } } : {}),
    },
    select: CREDENTIAL_SELECT,
  });
  const now = new Date();
  let created = 0;
  for (const credential of credentials) {
    if (!gscSyncAllowedFor(credential.projectId)) continue;
    if (await reconcileProject(credential, credential.projectId, now)) {
      created += 1;
    }
  }
  return created;
}

// Tek proje (site seçimi, geliştirme listesi): veri bir sonraki tick'te gelir.
// Süresi dolmuş (EXPIRED) bağlantının seçimi de geçerlidir: bağ düşürülmez,
// "Delete stored data" sonrası yeniden kurulur; senkron yeniden bağlanınca
// başlar (runner yalnız ACTIVE bağlantıyla çalışır).
export async function ensureGscLinkForProject(
  projectId: string,
): Promise<void> {
  if (!gscSyncAllowedFor(projectId)) return;
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      projectId,
      provider: GOOGLE_PROVIDER.search_console,
      status: { in: ["ACTIVE", "EXPIRED"] },
      NOT: { encryptedSecret: "" },
    },
    orderBy: { updatedAt: "desc" },
    select: { ...CREDENTIAL_SELECT, status: true },
  });
  const credential =
    credentials.find((row) => row.status === "ACTIVE") ??
    credentials[0] ??
    null;
  await reconcileProject(credential, projectId, new Date());
}

// "Delete stored data" (SK3): projenin bu kipteki bütün bağları ve ambar
// verisi cascade ile silinir; birincil bağ yeniden kurulur, arşiv ayarı ve
// kullanıcının marka terimleri korunur. Son 16 ay Google'dan yeniden yüklenir.
// Diğer kipin bağlarına dokunulmaz: canlı veritabanını paylaşan mock süreç
// canlı bağı ve Google'ın artık vermediği arşivi silemez.
export async function deleteGscDataForProject(
  projectId: string,
  now: Date = new Date(),
): Promise<{ deletedLinks: number }> {
  const mode = { projectId, isMock: gscMockMode() };
  const previous = await prisma.gscSiteLink.findFirst({
    where: mode,
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
    select: { archive: true, brandTerms: true },
  });
  // SC-F4: 'Delete stored data' fırsat motorunun sinyallerini ve havuzdaki kanıtlı fikirlerini de siler (bayraktan bağımsız, yalnız bu kipin bağları); bulgular bağla cascade ile gider.
  const forgetIds = (
    await prisma.gscSiteLink.findMany({ where: mode, select: { id: true } })
  ).map((row) => row.id);
  await forgetSearchOpportunitiesForLinks(forgetIds).catch(() => undefined);
  const result = await prisma.gscSiteLink.deleteMany({ where: mode });
  // SC-F3: Search Console'dan türeyen uyarılar ve denetimdeki GSC kökenli
  // durum da silinir (bayraktan bağımsız); tarama verisi sitenin kendisinden
  // geldiği için kalır.
  await deleteSearchConsoleAlertsForProjects([projectId]);
  await SeoSites.forgetSearchConsoleData([projectId], { resetScope: false });
  await ensureGscLinkForProject(projectId);
  if (previous) {
    const terms = parseBrandTermsConfig(previous.brandTerms);
    const brandTerms = {
      v: 1,
      auto: [],
      user: terms.user,
      removed: terms.removed,
      updatedAt: now.toISOString(),
    };
    await prisma.gscSiteLink.updateMany({
      where: { projectId, isPrimary: true, isMock: gscMockMode() },
      data: {
        archive: previous.archive,
        brandTerms: brandTerms as Prisma.InputJsonValue,
      },
    });
  }
  return { deletedLinks: result.count };
}
