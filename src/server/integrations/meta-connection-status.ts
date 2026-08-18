import "server-only";

import { prisma } from "@/lib/prisma";
import type { MetaCredentialMetadata } from "@/server/integrations/meta-client";

// Bir projenin bağlı Meta hesabının SEÇİLİ Page'i üzerinden gerçekten
// yayınlanabilir olduğu hedefler — kreatif kartındaki "Sosyal Hesaplarda
// Paylaş" bölümünün (bkz. creative-card.tsx) listeleyeceği veri TEK kaynağı
// (metadata.pages eşleştirme mantığı meta-api-provider.ts'teki canExecute()
// ile aynı). Bugün yalnızca Instagram gerçek bir provider'a sahip
// (TikTok/LinkedIn/X için henüz yok) — dizi bilerek genel tutuldu, ileride
// başka platform eklenirse buraya yeni bir eleman türü eklenmesi yeterli.
export type PublishTarget = {
  platform: "instagram";
  pageId: string;
  pageName: string;
  igUsername?: string;
};

export async function getPublishTargets(
  projectId: string,
): Promise<PublishTarget[]> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
  if (!credential || credential.status !== "ACTIVE") return [];

  const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
  const page = metadata.pages?.find(
    (p) => p.pageId === metadata.selectedPageId,
  );
  if (!page?.instagramBusinessAccountId) return [];

  return [
    {
      platform: "instagram",
      pageId: page.pageId,
      pageName: page.pageName,
      igUsername: page.instagramUsername,
    },
  ];
}

export async function hasPublishableInstagramConnection(
  projectId: string,
): Promise<boolean> {
  return (await getPublishTargets(projectId)).length > 0;
}
