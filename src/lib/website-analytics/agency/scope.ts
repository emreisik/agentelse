import type { Prisma } from "@prisma/client";

import {
  gaAgencyEnabled,
  type GaAgencyEnv,
} from "@/lib/website-analytics/agency/flags";

// GA-F8 motor kapsamı: sağlık, analiz ve rapor koşucularının hangi bağlara
// baktığı tek yerde. GA_AGENCY kapalıyken kapsam birebir bugünkü
// `{ isPrimary: true }`; açıkken ek (isSecondary) mülkler de motora girer.

// Proje başına ana mülke ek en çok 4 mülk.
export const GA_MAX_EXTRA_PROPERTIES = 4;

export function gaEngineLinkWhere(
  env?: GaAgencyEnv,
): Prisma.GaPropertyLinkWhereInput {
  return gaAgencyEnabled(env)
    ? { OR: [{ isPrimary: true }, { isSecondary: true }] }
    : { isPrimary: true };
}

export function isGaEngineLink(
  link: { isPrimary: boolean; isSecondary: boolean },
  env?: GaAgencyEnv,
): boolean {
  return link.isPrimary || (link.isSecondary && gaAgencyEnabled(env));
}
