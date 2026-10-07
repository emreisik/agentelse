import { GeoPanelView, GEO_TITLE_ID } from "@/components/search-geo/geo-panel-view";
import { seoGeoEnabledFor } from "@/lib/seo/apply/flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadGeoPanel } from "@/server/seo/geo/panel";

// Search sayfasındaki "AI search visibility" bölümü (SC-F8,
// docs/ai-search-visibility.md). Sayfa bunu Suspense içinde çizer. SEO_GEO
// kapalıyken ya da proje izinli değilken null döner ve veritabanına HİÇ
// gitmez (oturum okuması bile bayrak kontrolünden sonradır).

export async function SearchGeoSection({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  if (!seoGeoEnabledFor(projectId)) return null;
  let userId: string;
  try {
    const user = await requireUser();
    await requireProjectAccess(user.userId, projectId);
    userId = user.userId;
  } catch {
    return null;
  }
  const panel = await loadGeoPanel({ projectId, userId }).catch(() => null);
  if (!panel) return null;
  return (
    <section
      id="ai-visibility"
      aria-labelledby={GEO_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <GeoPanelView panel={panel} projectId={projectId} />
    </section>
  );
}
