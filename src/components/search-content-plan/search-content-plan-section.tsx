import {
  CONTENT_PLAN_TITLE_ID,
  ContentPlanListView,
} from "@/components/search-content-plan/content-plan-list";
import { seoContentPlanActiveFor } from "@/lib/seo/content-plan/flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadContentPlanView } from "@/server/seo/content-plan/store";

// Search sayfasındaki "This month's articles" bölümü (SC-F7,
// docs/search-content-plan.md). Sayfa bunu yalnız bayrak açıkken Suspense
// içinde çizer. Bayrak ya da izin listesi kapalıyken veritabanına hiç
// dokunmadan null döner; oturum ve proje erişimi sayfayla paylaşılan (React
// cache) okumalardır.

export async function SearchContentPlanSection({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  if (!seoContentPlanActiveFor(projectId)) return null;
  try {
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
  } catch {
    return null;
  }
  const view = await loadContentPlanView(projectId).catch(() => null);
  if (!view) return null;
  return (
    <section
      id="content-plan"
      aria-labelledby={CONTENT_PLAN_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <ContentPlanListView view={view} projectId={projectId} />
    </section>
  );
}
