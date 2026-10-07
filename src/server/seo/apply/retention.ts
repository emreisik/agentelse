import "server-only";

import { prisma } from "@/lib/prisma";
import {
  seoApplyEnabled,
  seoApplyGlobalWorkAllowedHere,
} from "@/lib/seo/apply/flags";
import {
  SEO_CHANGE_RETENTION_MS,
  SEO_CONTENT_RAW_KEEP_MS,
  SEO_MARKDOWN_KEEP_MS,
} from "@/lib/seo/apply/lifecycle";
import { claimPeriodic } from "@/server/observability/periodic";

// SC-F8 saklama temizliği (docs/website-apply.md "Saklama"): günde bir, tick
// sırasında (reconcile). Yalnız SEO_APPLY açıkken ve bu süreç global iş
// yapabilirken koşar (dev süreci canlı veritabanını paylaşırken periyodik
// anahtar almaz); bayrak kapalıyken sorgu yoktur. Kapalıyken satırlar
// bekler, açılınca süre dolanlar temizlenir.
//  - terminal satırlar 24 ay sonra silinir;
//  - before.contentRaw (INTERNAL_LINKS'in ham sayfa içeriği) 90 gün sonra
//    null olur (geri alma penceresi 90 gün);
//  - params.markdown (makale metni, Creative'de zaten durur) terminal
//    durumdan 30 gün sonra boşaltılır.

const EVERY_MS = 24 * 3_600_000;
const TERMINAL_STATUSES = [
  "VERIFIED",
  "FAILED",
  "UNDONE",
  "REJECTED",
  "EXPIRED",
] as const;

export const SeoApplyRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!seoApplyEnabled() || !seoApplyGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("seo.apply-retention", EVERY_MS, now))) return 0;

    const rawCutoff = new Date(now.getTime() - SEO_CONTENT_RAW_KEEP_MS);
    const markdownCutoff = new Date(now.getTime() - SEO_MARKDOWN_KEEP_MS);
    const deleteCutoff = new Date(now.getTime() - SEO_CHANGE_RETENTION_MS);

    // Önce içerik boşaltılır (silinecek satırlara boşuna yazılmaz).
    const deleted = await prisma.seoChange.deleteMany({
      where: {
        status: { in: [...TERMINAL_STATUSES] },
        createdAt: { lt: deleteCutoff },
      },
    });

    // Yazma sürerken (APPLYING/APPLIED/UNDOING) ham içeriğe dokunulmaz.
    const rawNulled =
      await prisma.$executeRaw`UPDATE "SeoChange" SET "before" = jsonb_set("before", '{contentRaw}', 'null'::jsonb) WHERE "before" IS NOT NULL AND "before" ->> 'contentRaw' IS NOT NULL AND "status" NOT IN ('APPLYING', 'APPLIED', 'UNDOING') AND COALESCE("appliedAt", "createdAt") < ${rawCutoff}`;

    const markdownBlanked =
      await prisma.$executeRaw`UPDATE "SeoChange" SET "params" = jsonb_set("params", '{markdown}', '""'::jsonb) WHERE "kind" = 'PUBLISH_ARTICLE' AND "status" IN ('VERIFIED', 'FAILED', 'UNDONE', 'REJECTED', 'EXPIRED') AND COALESCE("params" ->> 'markdown', '') <> '' AND "updatedAt" < ${markdownCutoff}`;

    return deleted.count + Number(rawNulled) + Number(markdownBlanked);
  },
};
