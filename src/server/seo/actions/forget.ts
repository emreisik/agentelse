import "server-only";

import { prisma } from "@/lib/prisma";
import { scrubSeoCardsSearchData } from "@/server/modules/seo/forget-cards";

// Search Console bağı silinirken (Disconnect, "Delete stored data", W1 bağ
// temizliği, bağı kalmayan satır temizliği) SC-F6'nın Google kökenli ürünleri
// (docs/search-actions.md "Silme"): linkId dolu SeoAction satırları (değerlendirme,
// hedef sorgular, anahtar kelime, inceleme kanıtı) ve onlardan doğan SEO
// BrandLearning satırları. Öğrenmeler learningId YA DA sourceRef ile eşlenir ve
// sourceType'a bakılmaz (memory-service tipi yeniden yazmış olabilir). Linksiz
// (yalnız tarayıcıyla çalışan) eylemler kalır. Hiçbir bayrağa bağlı DEĞİLDİR.

const CHUNK = 500;
const MAX_CHUNKS = 200;

export type ForgetActionsResult = { actions: number; learnings: number };

function report(scope: string, error: unknown): void {
  console.error(
    `[seo-actions-forget] ${scope}:`,
    error instanceof Error ? error.message : error,
  );
}

export async function forgetSeoActionsForLinks(
  linkIds: readonly string[],
): Promise<ForgetActionsResult> {
  const links = [...new Set(linkIds)];
  if (links.length === 0) return { actions: 0, learnings: 0 };

  let actions = 0;
  let learnings = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    const rows = await prisma.seoAction.findMany({
      where: { linkId: { in: links } },
      select: { id: true, learningId: true },
      take: CHUNK,
    });
    if (rows.length === 0) break;
    const actionIds = rows.map((row) => row.id);
    const learningIds = rows
      .map((row) => row.learningId)
      .filter((id): id is string => id !== null);
    // Önce öğrenmeler: eylem silinince sourceRef bağı kaybolur.
    const removedLearnings = await prisma.brandLearning.deleteMany({
      where: {
        OR: [{ id: { in: learningIds } }, { sourceRef: { in: actionIds } }],
      },
    });
    learnings += removedLearnings.count;
    const removed = await prisma.seoAction.deleteMany({
      where: { id: { in: actionIds } },
    });
    actions += removed.count;
    if (rows.length < CHUNK) break;
  }
  return { actions, learnings };
}

// Kart verisindeki Google türevi alanlar da temizlenir; temizleme başarısız
// olsa silme durmaz.
async function scrubCards(projectIds: readonly string[]): Promise<number> {
  if (projectIds.length === 0) return 0;
  try {
    return await scrubSeoCardsSearchData(projectIds);
  } catch (error) {
    report("cards could not be scrubbed", error);
    return 0;
  }
}

export async function forgetSeoActionsForCredential(
  credentialId: string,
): Promise<ForgetActionsResult & { cards: number }> {
  const links = await prisma.gscSiteLink.findMany({
    where: { credentialId },
    select: { id: true, projectId: true },
  });
  const result = await forgetSeoActionsForLinks(links.map((link) => link.id));
  const cards = await scrubCards([
    ...new Set(links.map((link) => link.projectId)),
  ]);
  return { ...result, cards };
}

// Projenin tek kipinin bağları ("Delete stored data").
export async function forgetSeoActionsForProjectMode(
  projectId: string,
  isMock: boolean,
): Promise<ForgetActionsResult & { cards: number }> {
  const links = await prisma.gscSiteLink.findMany({
    where: { projectId, isMock },
    select: { id: true },
  });
  const result = await forgetSeoActionsForLinks(links.map((link) => link.id));
  const cards = await scrubCards([projectId]);
  return { ...result, cards };
}
