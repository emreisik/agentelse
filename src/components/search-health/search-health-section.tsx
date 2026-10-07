import {
  HealthPanelView,
  SEARCH_HEALTH_TITLE_ID,
} from "@/components/search-health/health-panel-view";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import { SeoFlags } from "@/lib/seo/health-flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadHealthFixStates } from "@/server/seo/actions/fix-this";
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
  // SC-F6: "I fixed this" durumları yalnız eylem döngüsü açıkken okunur; kapalıyken liste bugünküyle aynı çizilir.
  const tracked =
    SeoActionFlags.loop() && seoActionsAllowedFor(projectId)
      ? await loadHealthFixStates(
          projectId,
          panel.issues.map((issue) => ({ id: issue.id, kind: issue.kind })),
        ).catch(() => undefined)
      : undefined;
  return (
    <section
      id="health"
      aria-labelledby={SEARCH_HEALTH_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <HealthPanelView panel={panel} tracked={tracked} />
    </section>
  );
}
