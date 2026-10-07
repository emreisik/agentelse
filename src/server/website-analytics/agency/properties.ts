import "server-only";

import { Prisma, type GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { GA_MAX_EXTRA_PROPERTIES } from "@/lib/website-analytics/agency/scope";
import { websiteWorkId } from "@/lib/website-analytics/reports/ids";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import {
  GOOGLE_PROVIDER,
  type GoogleAnalyticsMetadata,
} from "@/server/integrations/google-client";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { forgetWebsiteSharesForReports } from "@/server/website-analytics/agency/share-forget";

// GA-F8 çoklu mülk: bir projeye ana mülke ek en çok 4 mülk bağlanır. Her
// işlev bayrak kapalıyken (ya da proje yerel izin listesinde değilken)
// sorgusuz döner. Yazmalar OWNER/ADMIN kapısını çağıran eylemde (website-
// property-actions.ts) alır; burası yetki kontrolü yapmaz.

export type GaProjectProperties = {
  primary: GaPropertyLink | null;
  extras: GaPropertyLink[];
  accessible: { propertyId: string; propertyName: string; accountName: string }[];
  credentialStatus: string | null;
};

export type PropertyChangeResult =
  | "ok"
  | "off"
  | "not_connected"
  | "not_accessible"
  | "already_linked"
  | "limit"
  | "not_found"
  | "is_main";

const EMPTY: GaProjectProperties = {
  primary: null,
  extras: [],
  accessible: [],
  credentialStatus: null,
};

function activeCredential(projectId: string) {
  return prisma.integrationCredential.findFirst({
    where: {
      projectId,
      provider: GOOGLE_PROVIDER.analytics,
      status: "ACTIVE",
      NOT: { encryptedSecret: "" },
    },
    select: { id: true, workspaceId: true, metadata: true, status: true },
  });
}

export async function loadGaProjectProperties(
  projectId: string,
): Promise<GaProjectProperties> {
  if (!gaAgencyEnabledFor(projectId)) return EMPTY;
  const [links, credential] = await Promise.all([
    prisma.gaPropertyLink.findMany({
      where: {
        projectId,
        OR: [{ isPrimary: true }, { isSecondary: true }],
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.integrationCredential.findFirst({
      where: { projectId, provider: GOOGLE_PROVIDER.analytics },
      select: { status: true, metadata: true },
    }),
  ]);
  const metadata = (credential?.metadata ??
    null) as GoogleAnalyticsMetadata | null;
  return {
    primary: links.find((link) => link.isPrimary) ?? null,
    extras: links.filter((link) => link.isSecondary && !link.isPrimary),
    accessible: metadata?.ga4Properties ?? [],
    credentialStatus: credential?.status ?? null,
  };
}

async function audit(input: {
  workspaceId: string;
  projectId: string;
  action: string;
  linkId: string;
  propertyId: string;
  actorUserId?: string;
}): Promise<void> {
  // Yalnız kimlikler; mülk adı ve Google verisi denetim kaydına girmez.
  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorType: input.actorUserId ? "USER" : "SYSTEM",
    ...(input.actorUserId ? { actorId: input.actorUserId } : {}),
    action: input.action,
    entityType: "GaPropertyLink",
    entityId: input.linkId,
    metadata: { propertyId: input.propertyId },
  });
}

export async function addExtraGaProperty(input: {
  projectId: string;
  propertyId: string;
  actorUserId?: string;
}): Promise<PropertyChangeResult> {
  const { projectId, propertyId } = input;
  if (!gaAgencyEnabledFor(projectId)) return "off";
  const credential = await activeCredential(projectId);
  const metadata = (credential?.metadata ??
    null) as GoogleAnalyticsMetadata | null;
  if (!credential || !metadata?.selectedGa4PropertyId) return "not_connected";
  const property = metadata.ga4Properties?.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  if (!property) return "not_accessible";
  if (metadata.selectedGa4PropertyId === propertyId) return "is_main";

  const live = await prisma.gaPropertyLink.findMany({
    where: { projectId, OR: [{ isPrimary: true }, { isSecondary: true }] },
    select: { propertyId: true, isSecondary: true },
  });
  if (live.some((link) => link.propertyId === propertyId)) {
    return "already_linked";
  }
  if (live.filter((link) => link.isSecondary).length >= GA_MAX_EXTRA_PROPERTIES) {
    return "limit";
  }

  // Emekli (isPrimary=false, isSecondary=false) bir satır varsa canlanır:
  // kilit ve hata sayaçları sıfırlanır ki saklama süpürmesi ve eski backoff
  // yeni ek mülke bulaşmasın.
  const link = await prisma.gaPropertyLink.upsert({
    where: { projectId_propertyId: { projectId, propertyId } },
    create: {
      workspaceId: credential.workspaceId,
      projectId,
      credentialId: credential.id,
      propertyId,
      isPrimary: false,
      isSecondary: true,
      isMock: gaMockMode(),
      propertyName: property.propertyName,
      accountName: property.accountName || null,
    },
    update: {
      isSecondary: true,
      isPrimary: false,
      credentialId: credential.id,
      syncLeaseUntil: null,
      syncLeaseOwner: null,
      consecutiveFailures: 0,
      lastSyncError: null,
      rateLimitedUntil: null,
      serverErrorsHour: Prisma.DbNull,
      health: "UNKNOWN",
      healthReason: null,
    },
  });
  await audit({
    workspaceId: credential.workspaceId,
    projectId,
    action: "ga_property.added",
    linkId: link.id,
    propertyId,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
  });
  return "ok";
}

export async function removeExtraGaProperty(input: {
  projectId: string;
  propertyId: string;
  actorUserId?: string;
}): Promise<PropertyChangeResult> {
  const { projectId, propertyId } = input;
  if (!gaAgencyEnabledFor(projectId)) return "off";
  const link = await prisma.gaPropertyLink.findUnique({
    where: { projectId_propertyId: { projectId, propertyId } },
  });
  if (!link) return "not_found";
  if (link.isPrimary) return "is_main";
  if (!link.isSecondary) return "not_found";

  // Mülkün rapor kartları (Command.parsedIntent.card.linkId) ve bu kartlara
  // bağlı müşteri paylaşım bağlantıları kartlarla birlikte gider.
  const cards = await prisma.command.findMany({
    where: {
      projectId,
      workId: websiteWorkId(projectId),
      id: { startsWith: "garep_" },
      parsedIntent: { path: ["card", "linkId"], equals: link.id },
    },
    select: { id: true },
  });
  const cardIds = cards.map((card) => card.id);
  if (cardIds.length > 0) {
    await prisma.command.deleteMany({ where: { id: { in: cardIds } } });
    await forgetWebsiteSharesForReports(cardIds);
  }
  await prisma.adsAlert.deleteMany({
    where: {
      projectId,
      source: "GA4",
      dedupeKey: { startsWith: `ga4:${link.id}:` },
    },
  });
  await prisma.gaPropertyLink.delete({ where: { id: link.id } });
  await audit({
    workspaceId: link.workspaceId,
    projectId,
    action: "ga_property.removed",
    linkId: link.id,
    propertyId,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
  });
  return "ok";
}

export async function makeGaPropertyMain(input: {
  projectId: string;
  propertyId: string;
  actorUserId?: string;
}): Promise<PropertyChangeResult> {
  const { projectId, propertyId } = input;
  if (!gaAgencyEnabledFor(projectId)) return "off";
  const credential = await activeCredential(projectId);
  if (!credential) return "not_connected";
  const metadata = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;

  const links = await prisma.gaPropertyLink.findMany({
    where: { projectId, OR: [{ isPrimary: true }, { isSecondary: true }] },
  });
  const target = links.find((link) => link.propertyId === propertyId);
  if (!target) return "not_found";
  if (target.isPrimary) return "is_main";
  const previousMain = links.find((link) => link.isPrimary) ?? null;
  const property = metadata.ga4Properties?.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  // Hedef çıkınca ekler bir azalır; eski ana mülk o boşluğa girer. Sınır
  // yine de sınanır: sığmazsa eski ana mülk emekli olur (ga-retention siler).
  const extrasAfterTarget = links.filter(
    (link) => link.isSecondary && link.id !== target.id,
  ).length;
  const keepOldAsExtra =
    previousMain !== null && extrasAfterTarget < GA_MAX_EXTRA_PROPERTIES;

  await prisma.$transaction(async (tx) => {
    const nextMetadata: GoogleAnalyticsMetadata = {
      ...metadata,
      selectedGa4PropertyId: propertyId,
      selectedGa4PropertyName:
        property?.propertyName ??
        target.propertyName ??
        metadata.selectedGa4PropertyName,
    };
    await tx.integrationCredential.updateMany({
      where: { id: credential.id, status: { not: "REVOKED" } },
      data: { metadata: nextMetadata as unknown as Prisma.InputJsonValue },
    });
    if (previousMain) {
      await tx.gaPropertyLink.update({
        where: { id: previousMain.id },
        data: keepOldAsExtra
          ? { isPrimary: false, isSecondary: true }
          : {
              isPrimary: false,
              isSecondary: false,
              syncLeaseUntil: null,
              syncLeaseOwner: null,
            },
      });
    }
    await tx.gaPropertyLink.update({
      where: { id: target.id },
      data: { isPrimary: true, isSecondary: false, credentialId: credential.id },
    });
  });
  await audit({
    workspaceId: credential.workspaceId,
    projectId,
    action: "ga_property.made_main",
    linkId: target.id,
    propertyId,
    ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
  });
  return "ok";
}
