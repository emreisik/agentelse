import "server-only";

import { prisma } from "@/lib/prisma";
import { textSimilarity } from "@/lib/seo/actions/verify-checks";

// SEO Manager makalesinin yayına girdiğini tarayıcının kendi kaydından bulur
// (docs/search-actions.md "Keşif"): eylemden önce görülmemiş (firstSeenAt ya da
// sitemap'e ilk girişi eylemin oluşturulmasından en çok 1 gün öncesinden yeni),
// 200 yanıtlı, indekslenebilir sayfalar arasında başlığı ya da H1'i makalenin
// başlığına en çok benzeyen; benzerlik 0,6'nın altındaysa bulunamadı sayılır.

const MATCH_MIN = 0.6;
const CANDIDATES = 200;
const DAY_MS = 86_400_000;

export async function findPublishedPage(input: {
  siteId: string;
  title: string;
  primaryKeyword: string | null;
  // eylemin oluşturulma anı
  since: Date;
}): Promise<{ url: string; firstSeenAt: Date } | null> {
  // Başlık yoksa (konu daha yazılmamış) anahtar kelime karşılaştırılır.
  const reference = input.title.trim() || input.primaryKeyword?.trim() || "";
  if (!reference) return null;
  const floor = new Date(input.since.getTime() - DAY_MS);
  const rows = await prisma.seoPage.findMany({
    where: {
      siteId: input.siteId,
      goneAt: null,
      status: 200,
      indexable: true,
      OR: [
        { firstSeenAt: { gte: floor } },
        { sitemapFirstSeenAt: { gte: floor } },
      ],
    },
    orderBy: { firstSeenAt: "desc" },
    take: CANDIDATES,
    select: { url: true, title: true, h1: true, firstSeenAt: true },
  });

  let best: { url: string; firstSeenAt: Date; score: number } | null = null;
  for (const row of rows) {
    const score = Math.max(
      textSimilarity(row.title, reference),
      textSimilarity(row.h1, reference),
    );
    if (score >= MATCH_MIN && (!best || score > best.score)) {
      best = { url: row.url, firstSeenAt: row.firstSeenAt, score };
    }
  }
  return best ? { url: best.url, firstSeenAt: best.firstSeenAt } : null;
}
