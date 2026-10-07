import "server-only";

import { prisma } from "@/lib/prisma";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import { weeklySeoNoteText } from "@/lib/seo/content-plan/weekly-note";

// Haftalık taslağın (weekly-plan-draft.ts) cevabına eklenen SEO notu: bu hafta
// aylık plandan dokunulmamış makale slotu çıkıyorsa tek cümle. Slotlar plan
// kartının kalemi değildir (Save çift parça yaratırdı); yalnız not. Plan o proje
// için etkin değilse "" döner ve hiç sorgu atılmaz.

export async function weeklySeoNote(
  projectId: string,
  from: Date,
  to: Date,
): Promise<string> {
  if (!seoContentPlanActiveFor(projectId)) return "";
  const count = await prisma.creative.count({
    where: {
      projectId,
      formatKey: "seo.article",
      status: "DRAFT",
      planId: null,
      scheduledFor: { gte: from, lt: to },
    },
  });
  return weeklySeoNoteText(count);
}
