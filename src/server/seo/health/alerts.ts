import "server-only";

import { prisma } from "@/lib/prisma";
import type {
  SearchAlertKind,
  SearchAlertSource,
  SeoAlertDraft,
} from "@/lib/seo/health/alert-kinds";
import { SiteAlerts } from "@/server/monitoring/site-alerts";

// Arama sağlığı uyarılarının tek SiteAlerts bağdaştırıcısı (docs/search-health.md
// "Uyarılar"): bu iz (SC-F3) içinde @/server/monitoring/site-alerts'ı yalnız
// bu dosya içe aktarır. Uyarılar ortak AdsAlert tablosunda source "GSC" |
// "SEO" ile yaşar; dedupe anahtarı tür başına tektir. Her turda kaynak başına
// değerlendirilen türler için resolveMissing çağrılır. GSC uyarılarının
// silinmesi (Disconnect, "Delete stored data", yetim bağ temizliği) bayraktan
// bağımsızdır.

const SEARCH_SOURCES: readonly SearchAlertSource[] = ["GSC", "SEO"];

export type SearchAlertRow = {
  id: string;
  source: SearchAlertSource;
  kind: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  title: string;
  detail: string | null;
  lastSeenAt: Date;
  dedupeKey: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function raiseSeoAlerts(input: {
  workspaceId: string;
  projectId: string;
  drafts: readonly SeoAlertDraft[];
  evaluated: Readonly<Record<SearchAlertSource, readonly SearchAlertKind[]>>;
  now: Date;
}): Promise<{ raised: number; resolved: number }> {
  let raised = 0;
  for (const draft of input.drafts) {
    try {
      await SiteAlerts.raise(
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          source: draft.source,
          kind: draft.kind,
          severity: draft.severity,
          dedupeKey: draft.dedupeKey,
          title: draft.title,
          detail: draft.detail,
          ...(draft.data ? { data: draft.data } : {}),
        },
        input.now,
      );
      raised += 1;
    } catch (error) {
      // Tür adı yeterli; başlık ya da ayrıntı loglanmaz.
      console.error(
        `[seo-health] ${draft.kind} could not be raised:`,
        messageOf(error),
      );
    }
  }

  let resolved = 0;
  for (const source of SEARCH_SOURCES) {
    const kinds = [...input.evaluated[source]];
    if (kinds.length === 0) continue;
    const stillOpen = new Set(
      input.drafts
        .filter((draft) => draft.source === source)
        .map((draft) => draft.dedupeKey),
    );
    resolved += await SiteAlerts.resolveMissing(
      { projectId: input.projectId, source, kinds, stillOpen },
      input.now,
    );
  }
  return { raised, resolved };
}

export async function listSearchAlerts(
  projectId: string,
  limit = 20,
): Promise<SearchAlertRow[]> {
  const rows = await SiteAlerts.listOpen(projectId, ["GSC", "SEO"], limit);
  return rows.flatMap((row) =>
    row.source === "GSC" || row.source === "SEO"
      ? [
          {
            id: row.id,
            source: row.source,
            kind: row.kind,
            severity: row.severity,
            title: row.title,
            detail: row.detail,
            lastSeenAt: row.lastSeenAt,
            dedupeKey: row.dedupeKey,
          },
        ]
      : [],
  );
}

// Yalnız bu projenin GSC/SEO uyarısı susturulur (Meta ya da GA4 satırı değil).
export async function muteSearchAlert(
  alertId: string,
  projectId: string,
  days = 7,
): Promise<boolean> {
  const alert = await prisma.adsAlert.findFirst({
    where: { id: alertId, projectId, source: { in: [...SEARCH_SOURCES] } },
    select: { id: true },
  });
  if (!alert) return false;
  await SiteAlerts.mute(alert.id, projectId, days);
  return true;
}

// Disconnect: o bağlantının GscSiteLink satırlarının projelerindeki bütün
// GSC uyarıları hemen silinir (bağ silinmeden önce çağrılır). Bayraktan
// bağımsız.
export async function deleteSearchConsoleAlerts(
  credentialId: string,
): Promise<{ deleted: number; projectIds: string[] }> {
  const links = await prisma.gscSiteLink.findMany({
    where: { credentialId },
    select: { projectId: true },
  });
  const projectIds = [...new Set(links.map((link) => link.projectId))];
  if (projectIds.length === 0) return { deleted: 0, projectIds };
  const result = await prisma.adsAlert.deleteMany({
    where: { projectId: { in: projectIds }, source: "GSC" },
  });
  return { deleted: result.count, projectIds };
}

// "Delete stored data" ve yetim bağ temizliği. Bayraktan bağımsız; boş
// listede sorgu yok.
export async function deleteSearchConsoleAlertsForProjects(
  projectIds: readonly string[],
): Promise<number> {
  if (projectIds.length === 0) return 0;
  const result = await prisma.adsAlert.deleteMany({
    where: { projectId: { in: [...projectIds] }, source: "GSC" },
  });
  return result.count;
}

// Saklama: 180 günden eski çözülmüş GSC ve SEO uyarıları (Ads saklaması
// yalnız source: null satırlarına dokunur; her kaynak kendi süresini yönetir).
export async function purgeResolvedSearchAlerts(
  now: Date = new Date(),
  olderThanDays = 180,
): Promise<number> {
  let deleted = 0;
  for (const source of SEARCH_SOURCES) {
    deleted += await SiteAlerts.purgeResolved(source, olderThanDays, now);
  }
  return deleted;
}
