import "server-only";

import { cache } from "react";

import type { GscSiteLink } from "@prisma/client";

import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { registerViewedGscLinkResolver } from "@/server/seo/store";

// Site değiştirici bir MUTASYON değil, istek başına bir GÖRÜNÜM geçersiz
// kılmasıdır: sayfa ?site=<linkId>'yi çözer, ikincil bağı burada saklar ve
// primaryGscLink (store.ts) önce bunu döndürür; böylece ambar okuyucuları
// hiç değişmeden o sitenin verisini gösterir. requireUser ile aynı düzenek:
// React cache() istek başına bir kez çalışır; sunucu eylemlerinde ve istek
// dışında düz bir geçiş olduğundan geçersiz kılma orada asla görünmez.
const requestStore = cache(() => ({ link: null as GscSiteLink | null }));

export function setViewedGscLink(link: GscSiteLink | null): void {
  requestStore().link = link;
}

// Eşzamanlı ve veritabanına gitmez: bu istekte atanmış, bu projeye ve geçerli
// kipe (mock/canlı) ait bağ; aksi hâlde null.
export function viewedGscLink(projectId: string): GscSiteLink | null {
  const link = requestStore().link;
  if (!link) return null;
  if (link.projectId !== projectId) return null;
  if (link.isMock !== gscMockMode()) return null;
  return link;
}

// primaryGscLink (store.ts) bu çözümleyiciyi çağırır; kayıt modül yüklenince
// yapılır ve yalnız bu dosyayı içe aktaran sayfa grafiğinde vardır.
registerViewedGscLinkResolver(viewedGscLink);
