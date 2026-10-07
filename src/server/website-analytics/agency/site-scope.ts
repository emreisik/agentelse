import "server-only";

import type { GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import {
  addablePropertyOptions,
  canAddExtraProperty,
  pickSelectedLink,
  propertyChips,
  type GaPropertyChip,
} from "@/lib/website-analytics/agency/properties";
import { GOOGLE_PROVIDER } from "@/server/integrations/google-client";
import type { GoogleAnalyticsMetadata } from "@/server/integrations/google-client";
import { isWorkspaceManager } from "@/server/security/tenant-context";

import { withSelectedGaLink } from "./selected-link";

// GA-F8: Website sayfasının çoklu mülk için ihtiyaç duyduğu tek yer. Sayfa
// loadSitePropertyScope ile kapsamı kurar, bütün mülk okumalarını
// runInSiteScope içinde yapar. GA_AGENCY kapalıyken (ya da proje yerel izin
// listesinde değilken) hiçbir sorgu yok ve kapsam "enabled: false".

export type SitePropertyScope = {
  enabled: boolean;
  selected: GaPropertyLink | null;
  linkId: string | null;
  isSecondary: boolean;
  chips: GaPropertyChip[];
  addable: { propertyId: string; label: string }[];
  canAdd: boolean;
  canManage: boolean;
  // Çoklu mülk açıkken seçili bağın kimliği (arşiv süzgeci), değilse null.
  archiveLinkId: string | null;
};

const DISABLED: SitePropertyScope = {
  enabled: false,
  selected: null,
  linkId: null,
  isSecondary: false,
  chips: [],
  addable: [],
  canAdd: false,
  canManage: false,
  archiveLinkId: null,
};

export async function loadSitePropertyScope(input: {
  projectId: string;
  userId: string;
  workspaceId: string;
  requestedPropertyId: string | null;
  period: string | null;
}): Promise<SitePropertyScope> {
  if (!gaAgencyEnabledFor(input.projectId)) return DISABLED;

  const [links, canManage] = await Promise.all([
    prisma.gaPropertyLink.findMany({
      where: {
        projectId: input.projectId,
        OR: [{ isPrimary: true }, { isSecondary: true }],
      },
      orderBy: { createdAt: "asc" },
    }),
    isWorkspaceManager(input.userId, input.workspaceId),
  ]);
  const selected = pickSelectedLink(links, input.requestedPropertyId);
  const chips = propertyChips({
    projectId: input.projectId,
    links,
    selectedLinkId: selected?.id ?? null,
    period: input.period,
  });

  // Ekleme listesi yalnız yöneticiye gerekir; bağlantı satırı yalnız onda okunur.
  let addable: { propertyId: string; label: string }[] = [];
  const extraCount = links.filter((link) => link.isSecondary).length;
  const canAdd = canAddExtraProperty(extraCount);
  if (canManage && canAdd) {
    const credential = await prisma.integrationCredential.findFirst({
      where: {
        projectId: input.projectId,
        provider: GOOGLE_PROVIDER.analytics,
        status: "ACTIVE",
      },
      select: { metadata: true },
    });
    const metadata = (credential?.metadata ??
      null) as GoogleAnalyticsMetadata | null;
    addable = addablePropertyOptions(
      metadata?.ga4Properties ?? [],
      links.map((link) => link.propertyId),
    );
  }

  return {
    enabled: true,
    selected,
    linkId: selected?.id ?? null,
    isSecondary: selected?.isSecondary === true && !selected.isPrimary,
    chips,
    addable,
    canAdd,
    canManage,
    archiveLinkId: selected?.id ?? null,
  };
}

// Seçili mülk ek mülkse okumalar onun üzerinden; ana mülkte geçersiz kılma
// yok (okuyucular bugünkü sorguyu atar).
export function runInSiteScope<T>(
  scope: SitePropertyScope,
  run: () => Promise<T>,
): Promise<T> {
  return withSelectedGaLink(scope.isSecondary ? scope.selected : null, run);
}
