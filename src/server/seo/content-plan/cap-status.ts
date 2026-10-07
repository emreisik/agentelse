import "server-only";

import { prisma } from "@/lib/prisma";
import { parseSettings } from "@/lib/seo/content-plan/cap";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { monthOf } from "@/lib/seo/content-plan/schedule";
import { dayKeyInTimezone } from "@/lib/timezone";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { primaryGscLink } from "@/server/seo/store";

import { countSeoPiecesInMonth } from "./pieces";

// Aylık SEO makale sınırının durumu (SC-F7): AI yazım öncesi ön kontrol ve
// takvime koymadan önceki ön kontrol (seo-flow-actions.ts) bunu okur.
// Sınır yalnız plan etkinken ve projenin birincil Search Console bağı varken
// vardır (kontrolü o sayfada durur); bayrak kapalıyken hiç sorgu atılmaz.

export type SeoMonthCapStatus =
  | { active: false }
  | {
      active: true;
      cap: number;
      used: number;
      month: string;
      full: boolean;
      // Fikrin takvimde dokunulmamış bir plan slotu var (kendi ayında
      // tüketilirken sınıra takılmaz).
      hasSlot: boolean;
    };

const DEFAULT_TIMEZONE = "Europe/Istanbul";

// Bilinmeyen bir saat dilimi (Publishing saat dilimi serbest metindi) bir
// projenin sınır kontrolünü bozmasın.
export function safeTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export async function seoMonthCapStatus(
  projectId: string,
  options: { month?: string; ideaId?: string | null; now?: Date } = {},
): Promise<SeoMonthCapStatus> {
  if (!seoContentPlanActiveFor(projectId)) return { active: false };
  const link = await primaryGscLink(projectId);
  if (!link) return { active: false };

  const timezone = safeTimezone(await getProjectTimezone(projectId));
  const month =
    options.month ??
    monthOf(dayKeyInTimezone(options.now ?? new Date(), timezone));
  const [setting, used, slot] = await Promise.all([
    prisma.seoContentSetting.findUnique({ where: { projectId } }),
    countSeoPiecesInMonth(prisma, { projectId, month, timezone }),
    options.ideaId
      ? prisma.creative.findFirst({
          where: {
            projectId,
            formatKey: "seo.article",
            status: "DRAFT",
            planId: null,
            excludedAt: null,
            versions: { none: {} },
            post: { ideaId: options.ideaId },
          },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const { monthlyCap } = parseSettings(setting);
  return {
    active: true,
    cap: monthlyCap,
    used,
    month,
    full: used >= monthlyCap,
    hasSlot: slot !== null,
  };
}
