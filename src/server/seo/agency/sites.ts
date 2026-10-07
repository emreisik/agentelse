import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { siteLabel } from "@/lib/module-flows/analytics/catalog";
import {
  MAX_SITES_PER_PROJECT,
  gscAgencyActiveFor,
  gscAgencyOn,
  gscBigQueryOn,
} from "@/lib/seo/agency/flags";
import type {
  AddSiteCode,
  BqBadge,
  ProjectSiteView,
  ViewedSite,
} from "@/lib/seo/agency/types";
import { gscRestrictedProjects } from "@/lib/seo/flags";
import { prisma } from "@/lib/prisma";
import {
  GOOGLE_PROVIDER,
  type GoogleSearchConsoleMetadata,
} from "@/server/integrations/google-client";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { propertyTypeOf } from "@/server/integrations/search-console/sites";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { deleteSearchConsoleAlertsForProjects } from "@/server/seo/health/alerts";
import { forgetSearchOpportunitiesForLinks } from "@/server/seo/opportunities/forget";

import { setViewedGscLink } from "./site-context";

// Proje başına birden çok Search Console sitesi (SC-F9, docs/search-agency.md).
// Ek siteler isPrimary=false, isSecondary=true bağlardır; isPrimary süzen her
// motor (sağlık, uyarı, fırsat, rapor...) onları görmez, yalnız senkron ve
// kota yazımı genişler. Üyelik GscSiteSetting(isExtra)'da hatırlanır:
// "Delete stored data" bağları silse de bir sonraki tick yeniden kurar.
// GscSiteLink (projectId, siteUrl) ve GscSiteSetting (projectId, siteUrl) kipten
// bağımsız tekildir: diğer kipin satırı OTHER_MODE olur ve ASLA çevrilmez.

const CONNECTION_STATUSES = ["ACTIVE", "EXPIRED"] as const;
const UNVERIFIED_LEVEL = "siteUnverifiedUser";
const RECONCILE_PROJECTS = 200;

type CredentialRow = {
  id: string;
  workspaceId: string;
  status: string;
  metadata: unknown;
};

type MutationResult = { ok: true } | { ok: false; message: string };

function logFailure(scope: string, error: unknown): void {
  console.error(
    `[gsc-sites] ${scope} failed:`,
    error instanceof Error ? error.name : "error",
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

async function loadCredential(
  projectId: string,
): Promise<CredentialRow | null> {
  return prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: {
        projectId,
        provider: GOOGLE_PROVIDER.search_console,
      },
    },
    select: { id: true, workspaceId: true, status: true, metadata: true },
  });
}

function metadataOf(credential: CredentialRow): GoogleSearchConsoleMetadata {
  return (credential.metadata ?? {}) as GoogleSearchConsoleMetadata;
}

function usable(credential: CredentialRow | null): credential is CredentialRow {
  return (
    credential !== null &&
    (CONNECTION_STATUSES as readonly string[]).includes(credential.status)
  );
}

// Denetim kaydı en iyi çabadır: başarısız olursa işlem geri alınmaz. Yalnız
// kimlikler yazılır (URL, sorgu ya da sayı asla).
async function audit(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  action: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await AuditLogRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      actorType: "USER",
      actorId: input.userId,
      action: input.action,
      entityType: "GscSiteLink",
      entityId: input.entityId,
      metadata: input.metadata ?? {},
    });
  } catch (error) {
    logFailure("audit", error);
  }
}

const BADGES: readonly BqBadge[] = [
  "DRAFT",
  "VERIFIED",
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "BUDGET",
];

function badgeOf(status: string | undefined): BqBadge {
  return (BADGES as readonly string[]).includes(status ?? "")
    ? (status as BqBadge)
    : "OFF";
}

function viewOf(link: GscSiteLink, bigQuery: BqBadge): ProjectSiteView {
  return {
    linkId: link.id,
    siteUrl: link.siteUrl,
    siteLabel: siteLabel(link.siteUrl),
    role: link.isPrimary ? "PRIMARY" : "SECONDARY",
    isMock: link.isMock,
    health: link.health,
    lastFinalDate: link.lastFinalDate,
    backfillDone: link.backfillDoneAt !== null,
    bigQuery,
    isOwner: link.permissionLevel === "siteOwner",
  };
}

async function list(projectId: string): Promise<ProjectSiteView[]> {
  if (!gscAgencyActiveFor(projectId)) return [];
  const mock = gscMockMode();
  const links = await prisma.gscSiteLink.findMany({
    where: {
      projectId,
      isMock: mock,
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
  });
  if (links.length === 0) return [];
  // BigQuery kapalıyken tabloya hiç gidilmez.
  const badges = new Map<string, BqBadge>();
  if (gscBigQueryOn()) {
    const sources = await prisma.gscBqSource.findMany({
      where: { projectId, isMock: mock },
      select: { siteUrl: true, status: true },
    });
    for (const source of sources) {
      badges.set(source.siteUrl, badgeOf(source.status));
    }
  }
  return links
    .map((link) => viewOf(link, badges.get(link.siteUrl) ?? "OFF"))
    .sort(
      (a, b) =>
        Number(b.role === "PRIMARY") - Number(a.role === "PRIMARY") ||
        a.siteUrl.localeCompare(b.siteUrl),
    );
}

async function candidates(
  projectId: string,
): Promise<
  { siteUrl: string; siteLabel: string; permissionLevel: string | null }[]
> {
  if (!gscAgencyActiveFor(projectId)) return [];
  const credential = await loadCredential(projectId);
  if (!usable(credential)) return [];
  const metadata = metadataOf(credential);
  const linked = await prisma.gscSiteLink.findMany({
    where: { projectId },
    select: { siteUrl: true },
  });
  const taken = new Set(linked.map((link) => link.siteUrl));
  if (metadata.selectedSearchConsoleSite) {
    taken.add(metadata.selectedSearchConsoleSite);
  }
  return (metadata.searchConsoleSites ?? [])
    .filter(
      (site) =>
        !taken.has(site.siteUrl) && site.permissionLevel !== UNVERIFIED_LEVEL,
    )
    .map((site) => ({
      siteUrl: site.siteUrl,
      siteLabel: siteLabel(site.siteUrl),
      permissionLevel: site.permissionLevel ?? null,
    }));
}

async function add(input: {
  projectId: string;
  siteUrl: string;
  userId: string;
  now?: Date;
}): Promise<{ ok: true; linkId: string } | { ok: false; code: AddSiteCode }> {
  const { projectId, siteUrl, userId } = input;
  if (!gscAgencyActiveFor(projectId)) return { ok: false, code: "NOT_ALLOWED" };
  const credential = await loadCredential(projectId);
  if (!usable(credential)) return { ok: false, code: "NOT_CONNECTED" };
  const metadata = metadataOf(credential);
  const site = metadata.searchConsoleSites?.find(
    (candidate) => candidate.siteUrl === siteUrl,
  );
  if (!site) return { ok: false, code: "NOT_IN_ACCOUNT" };
  if (site.permissionLevel === UNVERIFIED_LEVEL) {
    return { ok: false, code: "UNVERIFIED" };
  }
  if (siteUrl === metadata.selectedSearchConsoleSite) {
    return { ok: false, code: "IS_PRIMARY" };
  }

  const mock = gscMockMode();
  const [links, setting] = await Promise.all([
    prisma.gscSiteLink.findMany({
      where: { projectId },
      select: {
        id: true,
        siteUrl: true,
        isMock: true,
        isPrimary: true,
        isSecondary: true,
      },
    }),
    prisma.gscSiteSetting.findUnique({
      where: { projectId_siteUrl: { projectId, siteUrl } },
      select: { id: true, isMock: true },
    }),
  ]);
  const existing = links.find((link) => link.siteUrl === siteUrl) ?? null;
  if (existing && existing.isMock !== mock) {
    return { ok: false, code: "OTHER_MODE" };
  }
  if (setting && setting.isMock !== mock) {
    return { ok: false, code: "OTHER_MODE" };
  }
  if (existing?.isSecondary) return { ok: false, code: "ALREADY_ADDED" };
  if (existing?.isPrimary) return { ok: false, code: "IS_PRIMARY" };

  // Birincil dahil sayılır; birincil bağı henüz tembel kurulmamış olsa bile
  // seçili site varsa bir yer tutar.
  const inMode = links.filter((link) => link.isMock === mock);
  const secondaries = inMode.filter((link) => link.isSecondary).length;
  const hasPrimary =
    inMode.some((link) => link.isPrimary) ||
    Boolean(metadata.selectedSearchConsoleSite);
  if (secondaries + (hasPrimary ? 1 : 0) >= MAX_SITES_PER_PROJECT) {
    return { ok: false, code: "LIMIT" };
  }

  try {
    if (setting) {
      await prisma.gscSiteSetting.update({
        where: { id: setting.id },
        data: { isExtra: true },
      });
    } else {
      await prisma.gscSiteSetting.create({
        data: {
          workspaceId: credential.workspaceId,
          projectId,
          siteUrl,
          isMock: mock,
          isExtra: true,
        },
      });
    }
    const link = existing
      ? await prisma.gscSiteLink.update({
          where: { id: existing.id },
          data: {
            isSecondary: true,
            isPrimary: false,
            demotedAt: null,
            credentialId: credential.id,
            permissionLevel: site.permissionLevel ?? null,
          },
          select: { id: true },
        })
      : await prisma.gscSiteLink.create({
          data: {
            workspaceId: credential.workspaceId,
            projectId,
            credentialId: credential.id,
            siteUrl,
            isPrimary: false,
            isSecondary: true,
            demotedAt: null,
            isMock: mock,
            propertyType: propertyTypeOf(siteUrl),
            permissionLevel: site.permissionLevel ?? null,
          },
          select: { id: true },
        });
    await audit({
      workspaceId: credential.workspaceId,
      projectId,
      userId,
      action: "gsc_site.added",
      entityId: link.id,
    });
    return { ok: true, linkId: link.id };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, code: "ALREADY_ADDED" };
    throw error;
  }
}

async function remove(input: {
  projectId: string;
  linkId: string;
  userId: string;
}): Promise<MutationResult> {
  const { projectId, linkId, userId } = input;
  const link = await prisma.gscSiteLink.findFirst({
    where: { id: linkId, projectId, isMock: gscMockMode() },
    select: {
      id: true,
      workspaceId: true,
      siteUrl: true,
      isPrimary: true,
      isSecondary: true,
      isMock: true,
    },
  });
  if (!link || (!link.isSecondary && !link.isPrimary)) {
    return { ok: false, message: "Site not found" };
  }
  if (link.isPrimary) {
    return { ok: false, message: "The main site can't be removed." };
  }
  // Bağ silinince ambar ve bölünmüş testler cascade ile gider; ayar satırı ve
  // BigQuery kaynağı bağsız olduğu için ayrıca temizlenir.
  await prisma.$transaction([
    prisma.gscSiteSetting.updateMany({
      where: { projectId, siteUrl: link.siteUrl, isMock: link.isMock },
      data: { isExtra: false },
    }),
    prisma.gscBqSource.deleteMany({
      where: { projectId, siteUrl: link.siteUrl, isMock: link.isMock },
    }),
    prisma.gscSiteLink.delete({ where: { id: link.id } }),
  ]);
  await audit({
    workspaceId: link.workspaceId,
    projectId,
    userId,
    action: "gsc_site.removed",
    entityId: link.id,
  });
  return { ok: true };
}

async function makePrimary(input: {
  projectId: string;
  linkId: string;
  userId: string;
}): Promise<MutationResult> {
  const { projectId, linkId, userId } = input;
  const mock = gscMockMode();
  const chosen = await prisma.gscSiteLink.findFirst({
    where: { id: linkId, projectId },
  });
  if (!chosen || chosen.isMock !== mock || !chosen.isSecondary) {
    return { ok: false, message: "Site not found" };
  }
  if (chosen.isPrimary) {
    return { ok: false, message: "This is already the main site." };
  }
  const credential = await loadCredential(projectId);
  if (!usable(credential)) {
    return {
      ok: false,
      message: "Connect Search Console for this project first.",
    };
  }
  const metadata = metadataOf(credential);
  if (
    !metadata.searchConsoleSites?.some(
      (site) => site.siteUrl === chosen.siteUrl,
    )
  ) {
    return {
      ok: false,
      message: "That site isn't in the connected Search Console account.",
    };
  }
  const old = await prisma.gscSiteLink.findFirst({
    where: { projectId, isPrimary: true, isMock: mock },
    select: { id: true, siteUrl: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      const nextMetadata: GoogleSearchConsoleMetadata = {
        ...metadata,
        selectedSearchConsoleSite: chosen.siteUrl,
      };
      const swapped = await tx.integrationCredential.updateMany({
        where: { id: credential.id, status: { not: "REVOKED" } },
        data: { metadata: nextMetadata as unknown as Prisma.InputJsonValue },
      });
      if (swapped.count === 0) throw new Error("CREDENTIAL_REVOKED");
      if (old) {
        await tx.gscSiteLink.update({
          where: { id: old.id },
          data: {
            isPrimary: false,
            isSecondary: true,
            demotedAt: null,
            syncLeaseUntil: null,
            syncLeaseOwner: null,
          },
        });
      }
      await tx.gscSiteLink.update({
        where: { id: chosen.id },
        data: { isPrimary: true, isSecondary: false, demotedAt: null },
      });
      // Ayar satırları yalnız bu kipte çevrilir; yoksa eski birincil için
      // oluşturulur ki "Delete stored data" sonrası ek site olarak dönsün.
      if (old) {
        const flipped = await tx.gscSiteSetting.updateMany({
          where: { projectId, siteUrl: old.siteUrl, isMock: mock },
          data: { isExtra: true },
        });
        if (flipped.count === 0) {
          await tx.gscSiteSetting.createMany({
            data: [
              {
                workspaceId: credential.workspaceId,
                projectId,
                siteUrl: old.siteUrl,
                isMock: mock,
                isExtra: true,
              },
            ],
            skipDuplicates: true,
          });
        }
      }
      await tx.gscSiteSetting.updateMany({
        where: { projectId, siteUrl: chosen.siteUrl, isMock: mock },
        data: { isExtra: false },
      });
    });
  } catch (error) {
    logFailure("makePrimary", error);
    return { ok: false, message: "The main site couldn't be changed." };
  }

  await audit({
    workspaceId: credential.workspaceId,
    projectId,
    userId,
    action: "gsc_site.primary_changed",
    entityId: chosen.id,
  });

  // Eski birincilin motor durumu (bulgular, uyarılar, sağlık parçaları) yeni
  // birincile ait değildir; mevcut unutma yardımcılarıyla temizlenir. Ambar
  // satırları ve SeoReport anlık görüntüleri geçmiş olarak kalır. Her adım en
  // iyi çabadır: biri başarısız olursa takas geri alınmaz.
  if (old) {
    try {
      await forgetSearchOpportunitiesForLinks([old.id]);
    } catch (error) {
      logFailure("forget opportunities", error);
    }
    try {
      await deleteSearchConsoleAlertsForProjects([projectId]);
    } catch (error) {
      logFailure("delete alerts", error);
    }
    try {
      await prisma.seoSite.updateMany({
        where: { projectId, isMock: mock },
        data: { healthParts: Prisma.DbNull, healthComputedAt: null },
      });
    } catch (error) {
      logFailure("reset health", error);
    }
  }
  return { ok: true };
}

// Bir projenin ek site bağlarını ayarlarla hizalar (idempotent): eksik bağı
// kurar ya da canlandırır; ayarı olmayan ya da artık hesapta bulunmayan siteyi
// düşürür. MAX'ı aşan ek siteler (createdAt sırasıyla) yok sayılır, silinmez.
async function reconcile(projectId: string, now?: Date): Promise<number> {
  void now;
  if (!gscAgencyActiveFor(projectId)) return 0;
  const mock = gscMockMode();
  const [settings, links, credential] = await Promise.all([
    prisma.gscSiteSetting.findMany({
      where: { projectId, isMock: mock },
      orderBy: { createdAt: "asc" },
      select: { id: true, siteUrl: true, isExtra: true, workspaceId: true },
    }),
    prisma.gscSiteLink.findMany({ where: { projectId } }),
    loadCredential(projectId),
  ]);
  const extras = settings.filter((setting) => setting.isExtra);
  if (
    extras.length === 0 &&
    !links.some((l) => l.isMock === mock && l.isSecondary)
  ) {
    return 0;
  }

  let changes = 0;
  const keep = new Set<string>();
  const metadata = usable(credential) ? metadataOf(credential) : null;
  const accountSites = new Set(
    (metadata?.searchConsoleSites ?? []).map((site) => site.siteUrl),
  );
  const levelOf = new Map(
    (metadata?.searchConsoleSites ?? []).map((site) => [
      site.siteUrl,
      site.permissionLevel ?? null,
    ]),
  );
  const selected = metadata?.selectedSearchConsoleSite;
  const room = MAX_SITES_PER_PROJECT - (selected ? 1 : 0);
  let taken = 0;

  for (const setting of extras) {
    const link = links.find(
      (candidate) => candidate.siteUrl === setting.siteUrl,
    );
    if (!credential || !usable(credential) || !metadata) {
      // Bağlantı yok ya da koparılmış: üyelik düşer (kurallar kalır).
      await prisma.gscSiteSetting.update({
        where: { id: setting.id },
        data: { isExtra: false },
      });
      changes += 1;
      continue;
    }
    if (setting.siteUrl === selected || !accountSites.has(setting.siteUrl)) {
      await prisma.gscSiteSetting.update({
        where: { id: setting.id },
        data: { isExtra: false },
      });
      changes += 1;
      continue;
    }
    if (link && link.isMock !== mock) continue;
    if (link?.isPrimary) continue;
    if (taken >= room) {
      // Sınırı aşan üyelik yok sayılır; mevcut bağı varsa dokunulmaz.
      if (link?.isSecondary) keep.add(link.id);
      continue;
    }
    taken += 1;
    if (link) {
      keep.add(link.id);
      if (!link.isSecondary || link.demotedAt !== null) {
        await prisma.gscSiteLink.update({
          where: { id: link.id },
          data: {
            isSecondary: true,
            isPrimary: false,
            demotedAt: null,
            credentialId: credential.id,
          },
        });
        changes += 1;
      }
      continue;
    }
    try {
      await prisma.gscSiteLink.create({
        data: {
          workspaceId: setting.workspaceId,
          projectId,
          credentialId: credential.id,
          siteUrl: setting.siteUrl,
          isPrimary: false,
          isSecondary: true,
          demotedAt: null,
          isMock: mock,
          propertyType: propertyTypeOf(setting.siteUrl),
          permissionLevel: levelOf.get(setting.siteUrl) ?? null,
        },
      });
      changes += 1;
    } catch (error) {
      // Yarış: başka süreç aynı bağı kurdu.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // Üyeliği kalmayan ikincil bağlar silinir (ambar ve bölünmüş testler
  // cascade ile gider); hesap listesinde olmayanlar da bu yolla düşer.
  const orphans = links
    .filter(
      (link) =>
        link.isMock === mock &&
        link.isSecondary &&
        !link.isPrimary &&
        !keep.has(link.id),
    )
    .map((link) => link.id);
  if (orphans.length > 0) {
    const removed = await prisma.gscSiteLink.deleteMany({
      where: { id: { in: orphans }, projectId, isSecondary: true },
    });
    changes += removed.count;
  }
  return changes;
}

// Global tick yolu: ek sitesi olan projeler. Kısıtlı listede (geliştirme /
// kademeli açılış) yalnız o projeler; null = hepsi, [] = hiçbiri.
async function reconcileAll(now?: Date): Promise<number> {
  if (!gscAgencyOn()) return 0;
  const restricted = gscRestrictedProjects();
  if (restricted && restricted.length === 0) return 0;
  const mock = gscMockMode();
  const scope = restricted ? { projectId: { in: restricted } } : {};
  const [fromSettings, fromLinks] = await Promise.all([
    prisma.gscSiteSetting.findMany({
      where: { isMock: mock, isExtra: true, ...scope },
      select: { projectId: true },
      distinct: ["projectId"],
      take: RECONCILE_PROJECTS,
    }),
    prisma.gscSiteLink.findMany({
      where: { isMock: mock, isSecondary: true, ...scope },
      select: { projectId: true },
      distinct: ["projectId"],
      take: RECONCILE_PROJECTS,
    }),
  ]);
  const projectIds = [
    ...new Set([...fromSettings, ...fromLinks].map((row) => row.projectId)),
  ];
  let changes = 0;
  for (const projectId of projectIds) {
    try {
      changes += await reconcile(projectId, now);
    } catch (error) {
      logFailure("reconcile", error);
    }
  }
  return changes;
}

export const GscSites = {
  list,
  candidates,
  add,
  remove,
  makePrimary,
  reconcile,
  reconcileAll,
};

// Sayfa isteği: ?site=<linkId> yalnız bu projenin izlenen sitelerinden biri
// olabilir. Görünüm yalnız ikincil site için geçersiz kılınır; birincil görünüm
// hiçbir şeyi değiştirmez (primaryGscLink zaten onu döndürür).
export async function resolveViewedSite(
  projectId: string,
  siteParam: string | null | undefined,
): Promise<ViewedSite> {
  if (!gscAgencyActiveFor(projectId)) {
    return { agency: false, sites: [], viewed: null, isPrimaryView: true };
  }
  const sites = await list(projectId);
  const requested = siteParam
    ? sites.find((site) => site.linkId === siteParam)
    : undefined;
  const viewed =
    requested ?? sites.find((site) => site.role === "PRIMARY") ?? null;
  if (viewed && viewed.role === "SECONDARY") {
    const row = await prisma.gscSiteLink.findFirst({
      where: { id: viewed.linkId, projectId, isMock: gscMockMode() },
    });
    if (row) setViewedGscLink(row);
  }
  return {
    agency: true,
    sites,
    viewed,
    isPrimaryView: viewed ? viewed.role === "PRIMARY" : true,
  };
}
