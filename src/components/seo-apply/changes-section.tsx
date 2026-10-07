import { IndexNowCard } from "@/components/seo-apply/indexnow-card";
import {
  CHANGES_TITLE_ID,
  ChangesListView,
} from "@/components/seo-apply/changes-list";
import { seoApplyEnabledFor } from "@/lib/seo/apply/flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadSeoApplyView } from "@/server/seo/apply/read";

// Search sayfasındaki "Website changes" bölümü (SC-F8, docs/website-apply.md).
// Sayfa bunu yalnız SEO_APPLY açıkken Suspense içinde çizer. Bayrak ya da
// açılış listesi kapalıyken null döner ve veritabanına HİÇ gitmez; oturum ve
// proje erişimi bayrak denetiminden sonra gelir. Bölüm yalnız SeoSite'a
// bağlıdır: Search Console bağlı olmasa da görünür.

export async function SearchApplySection({
  projectId,
}: {
  projectId: string;
}): Promise<React.JSX.Element | null> {
  if (!seoApplyEnabledFor(projectId)) return null;
  let userId: string;
  try {
    ({ userId } = await requireUser());
    await requireProjectAccess(userId, projectId);
  } catch {
    return null;
  }
  const view = await loadSeoApplyView({ projectId, userId }).catch(() => null);
  if (!view) return null;
  return (
    <section
      id="website-changes"
      aria-labelledby={CHANGES_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <ChangesListView view={view} projectId={projectId} />
      {view.indexNow && view.connection.connected ? (
        <IndexNowCard
          projectId={projectId}
          view={view.indexNow}
          canManage={view.canManage}
        />
      ) : null}
    </section>
  );
}
