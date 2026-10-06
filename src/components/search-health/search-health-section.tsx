import {
  HealthPanelView,
  SEARCH_HEALTH_TITLE_ID,
} from "@/components/search-health/health-panel-view";
import { SeoFlags } from "@/lib/seo/health-flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadSearchHealthPanel } from "@/server/seo/health/panel";

// Search sayfasındaki "Index & technical health" bölümü (SC-F3,
// docs/search-health.md). Sayfa bunu Suspense içinde çizer; W1 raporu bu
// bölümü beklemez. SEO_HEALTH kapalıyken null döner ve veritabanına gitmez.
// Oturum ve proje erişimi sayfayla paylaşılan (React cache) okumalardır.

export async function SearchHealthSection({
  projectId,
  issueId,
}: {
  projectId: string;
  issueId?: string | null;
}): Promise<React.JSX.Element | null> {
  if (!SeoFlags.health()) return null;
  let access: { userId: string; workspaceId: string };
  try {
    const { userId } = await requireUser();
    const { workspaceId } = await requireProjectAccess(userId, projectId);
    access = { userId, workspaceId };
  } catch {
    return null;
  }
  const panel = await loadSearchHealthPanel(projectId, {
    ...access,
    issueId: issueId ?? null,
  }).catch(() => null);
  if (!panel) return null;
  return (
    <section
      id="health"
      aria-labelledby={SEARCH_HEALTH_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <HealthPanelView panel={panel} />
    </section>
  );
}
