import {
  ACTIONS_TITLE_ID,
  ActionsListView,
} from "@/components/search-actions/actions-list";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import { seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadSeoActionsPanel } from "@/server/seo/actions/panel";
import { loadApplyOffersForActions } from "@/server/seo/apply/offers";

// Search sayfasındaki "Actions & results" bölümü (SC-F6,
// docs/search-actions.md). Sayfa bunu yalnız SEO_ACTIONS döngüsü etkinken
// Suspense içinde çizer; W1 raporu bu bölümü beklemez. Bayrak ya da açılış
// listesi kapalıyken null döner ve veritabanına gitmez. Oturum ve proje erişimi
// sayfayla paylaşılan (React cache) okumalardır.

export async function SearchActionsSection({
  projectId,
  highlight,
}: {
  projectId: string;
  highlight?: string | null;
}): Promise<React.JSX.Element | null> {
  if (!SeoActionFlags.loop()) return null;
  let userId: string;
  let workspaceId: string;
  try {
    ({ userId } = await requireUser());
    ({ workspaceId } = await requireProjectAccess(userId, projectId));
  } catch {
    return null;
  }
  const panel = await loadSeoActionsPanel(projectId, {
    highlight: highlight ?? null,
  }).catch(() => null);
  if (!panel) return null;
  // SC-F8: WordPress teklifleri yalnız SEO_APPLY açıkken okunur; kapalıyken sorgu yok.
  const apply = seoApplyEnabledFor(projectId)
    ? await loadApplyOffersForActions(
        projectId,
        [...panel.needsYou, ...panel.inProgress, ...panel.results].map(
          (item) => item.id,
        ),
      ).catch(() => ({}))
    : undefined;
  const isManager =
    apply && Object.keys(apply).length > 0
      ? await isWorkspaceManager(userId, workspaceId).catch(() => false)
      : false;
  return (
    <section
      id="actions"
      aria-labelledby={ACTIONS_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <ActionsListView panel={panel} apply={apply} isManager={isManager} />
    </section>
  );
}
