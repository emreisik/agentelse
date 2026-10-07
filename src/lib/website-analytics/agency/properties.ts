import { GA_MAX_EXTRA_PROPERTIES } from "@/lib/website-analytics/agency/scope";

// GA-F8 çoklu mülk: Website sayfasındaki mülk seçici için saf yardımcılar.
// Sunucu ve istemci kodu da içe aktarabilir.

export type GaPropertyChip = {
  linkId: string;
  propertyId: string;
  label: string;
  role: "main" | "extra";
  serviceLevel: "360" | "standard" | null;
  health: string;
  selected: boolean;
  href: string;
};

type LinkLike = {
  id: string;
  propertyId: string;
  isPrimary: boolean;
  isSecondary: boolean;
};

// İstenen mülk bağlar arasında yoksa (ya da hiç istenmediyse) ana mülk; ana
// mülk de yoksa null (ek mülk tek başına seçilmez).
export function pickSelectedLink<T extends LinkLike>(
  links: readonly T[],
  requestedPropertyId: string | null | undefined,
): T | null {
  const main = links.find((link) => link.isPrimary) ?? null;
  if (requestedPropertyId) {
    const requested = links.find(
      (link) =>
        link.propertyId === requestedPropertyId &&
        (link.isPrimary || link.isSecondary),
    );
    if (requested) return requested;
  }
  return main;
}

function serviceLevelOf(value: string | null): "360" | "standard" | null {
  if (!value) return null;
  return value === "GOOGLE_ANALYTICS_360" ? "360" : "standard";
}

export function propertyChips(input: {
  projectId: string;
  links: readonly {
    id: string;
    propertyId: string;
    propertyName: string | null;
    isPrimary: boolean;
    isSecondary: boolean;
    serviceLevel: string | null;
    health: string;
  }[];
  selectedLinkId: string | null;
  period: string | null;
}): GaPropertyChip[] {
  const shown = input.links.filter((link) => link.isPrimary || link.isSecondary);
  // Ana mülk önde; ekler adına (yoksa kimliğine) göre sıralı.
  const ordered = [...shown].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return (a.propertyName ?? a.propertyId).localeCompare(
      b.propertyName ?? b.propertyId,
    );
  });
  return ordered.map((link) => {
    const params = new URLSearchParams();
    if (!link.isPrimary) params.set("property", link.propertyId);
    if (input.period) params.set("period", input.period);
    const query = params.toString();
    return {
      linkId: link.id,
      propertyId: link.propertyId,
      label: link.propertyName?.trim() || `Property ${link.propertyId}`,
      role: link.isPrimary ? "main" : "extra",
      serviceLevel: serviceLevelOf(link.serviceLevel),
      health: link.health,
      selected: link.id === input.selectedLinkId,
      href: `/projects/${input.projectId}/site${query ? `?${query}` : ""}`,
    };
  });
}

// Eklenebilir mülkler: bağlantının erişebildiği, henüz bağlı olmayanlar.
export function addablePropertyOptions(
  accessible: readonly {
    propertyId: string;
    propertyName: string;
    accountName: string;
  }[],
  linkedPropertyIds: readonly string[],
): { propertyId: string; label: string }[] {
  const linked = new Set(linkedPropertyIds);
  return accessible
    .filter((property) => !linked.has(property.propertyId))
    .map((property) => ({
      propertyId: property.propertyId,
      label: property.accountName
        ? `${property.propertyName} (${property.accountName})`
        : property.propertyName,
    }));
}

export function canAddExtraProperty(extraCount: number): boolean {
  return extraCount < GA_MAX_EXTRA_PROPERTIES;
}
