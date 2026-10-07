import "server-only";

import { prisma } from "@/lib/prisma";
import { isModuleFlowCard } from "@/lib/module-flows/card";
import { parseSeoState, scrubSearchData } from "@/lib/module-flows/seo/state";
import { updateCommandCard } from "@/server/chat/card-store";

// SEO Manager kartlarındaki Search Console verisinin silinmesi (docs/search-
// actions.md "Silme"): Disconnect ve "Delete stored data" bu projelerin
// kartlarında yalnız iki alanı temizler: plan.quickWins (state "ok" → "not-
// connected") ve target.queryCount (→ 0). Kullanıcının kendi içeriği (brief,
// plan, makale, teslim) olduğu gibi kalır. Bayrağa BAĞLI DEĞİLDİR: bu bir
// silme işlemidir. Tamamlanmış Work'lerin kartları da temizlenir (kullanıcı
// düzenlemesi değil, veri silme); yazma kartın atomik yazıcısından geçer.

const PAGE = 200;
// Saklama taramasının bir koşuda temizlediği en çok proje sayısı.
const SWEEP_PROJECTS = 200;

type CardRow = { id: string; projectId: string | null };

// Ham kart verisinde yalnız iki alanı değiştirir; başka anahtar (hint gibi)
// ve geçersiz parçalar olduğu gibi kalır.
function scrubbedData(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const { state, changed } = scrubSearchData(parseSeoState(data));
  if (!changed) return null;
  const next = { ...data };
  const rawPlan = data.plan;
  if (state.plan && rawPlan && typeof rawPlan === "object") {
    next.plan = {
      ...(rawPlan as Record<string, unknown>),
      quickWins: state.plan.quickWins,
    };
  }
  const rawTarget = data.target;
  if (state.target && rawTarget && typeof rawTarget === "object") {
    next.target = {
      ...(rawTarget as Record<string, unknown>),
      queryCount: state.target.queryCount,
    };
  }
  return next;
}

async function scrubOne(row: CardRow): Promise<boolean> {
  if (!row.projectId) return false;
  const result = await updateCommandCard({
    commandId: row.id,
    projectId: row.projectId,
    expectKinds: ["module-flow"],
    update: (card) => {
      if (!isModuleFlowCard(card) || card.module !== "seo") return null;
      const data = scrubbedData(card.data);
      return data ? { ...card, data } : null;
    },
  });
  if (!result.ok) {
    // Sessiz kalmasın: kart kodu loglanır (kart içeriği değil); bir sonraki
    // saklama taraması (sweepOrphanSeoCardsSearchData) yeniden dener.
    console.warn(`[seo-cards] scrub not applied (${result.code})`);
    return false;
  }
  return result.changed;
}

// Temizlenen kart sayısı.
export async function scrubSeoCardsSearchData(
  projectIds: readonly string[],
): Promise<number> {
  if (projectIds.length === 0) return 0;
  let cleaned = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows: CardRow[] = await prisma.command.findMany({
      where: {
        projectId: { in: [...projectIds] },
        parsedIntent: { path: ["card", "module"], equals: "seo" },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, projectId: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        if (await scrubOne(row)) cleaned += 1;
      } catch (error) {
        // Bir kartın hatası diğerlerini durdurmaz; silme en iyi çabayla sürer.
        console.error(
          "[seo-cards] scrub failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1]?.id;
  }
  return cleaned;
}

// Search Console bağı hiç kalmamış projelerin SEO kartları: Disconnect'te ya da
// bağ silen saklama yollarında temizleme çakışma (CONFLICT) ya da hata ile
// yarıda kaldıysa kalanlar günlük GscRetention'da silinir. Temizleme kendi
// kendine eşdeğerdir (değişecek bir şey yoksa kart yazılmaz). Bayrağa bağlı
// değildir. Temizlenen kart sayısı.
export async function sweepOrphanSeoCardsSearchData(): Promise<number> {
  const projects = await prisma.command.groupBy({
    by: ["projectId"],
    where: {
      projectId: { not: null },
      parsedIntent: { path: ["card", "module"], equals: "seo" },
    },
    orderBy: { projectId: "asc" },
    take: SWEEP_PROJECTS * 5,
  });
  const ids = projects
    .map((row) => row.projectId)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return 0;
  const linked = new Set(
    (
      await prisma.gscSiteLink.findMany({
        where: { projectId: { in: ids } },
        select: { projectId: true },
      })
    ).map((row) => row.projectId),
  );
  const orphans = ids.filter((id) => !linked.has(id)).slice(0, SWEEP_PROJECTS);
  return scrubSeoCardsSearchData(orphans);
}
