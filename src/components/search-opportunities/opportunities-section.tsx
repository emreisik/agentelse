import {
  OPPORTUNITIES_TITLE_ID,
  OpportunityListView,
} from "@/components/search-opportunities/opportunity-list";
import { ShadowReview } from "@/components/search-opportunities/shadow-review";
import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { loadFixThisStates } from "@/server/seo/actions/fix-this";
import { loadOpportunitiesPanel } from "@/server/seo/opportunities/panel";

// Search sayfasındaki "Opportunities" bölümü (SC-F4,
// docs/search-opportunities.md). Sayfa bunu yalnız SEO_INSIGHTS etkinken
// Suspense içinde çizer; W1 raporu bu bölümü beklemez. Veri yoksa (bayrak,
// izin listesi, gölge kipte operatör olmayan kullanıcı) null döner. Oturum ve
// proje erişimi sayfayla paylaşılan (React cache) okumalardır.

export async function SearchOpportunitiesSection({
  projectId,
  highlight,
}: {
  projectId: string;
  highlight?: string | null;
}): Promise<React.JSX.Element | null> {
  let userId: string;
  try {
    ({ userId } = await requireUser());
    await requireProjectAccess(userId, projectId);
  } catch {
    return null;
  }
  const panel = await loadOpportunitiesPanel(projectId, {
    userId,
    highlight: highlight ?? null,
  }).catch(() => null);
  if (!panel) return null;
  // SC-F6: "Fix this" durumları yalnız eylem döngüsü açıkken okunur; kapalıyken liste bugünküyle aynı çizilir.
  const fixThis =
    SeoActionFlags.loop() && seoActionsAllowedFor(projectId)
      ? await loadFixThisStates(
          projectId,
          [...panel.items, ...panel.accepted].map((item) => item.id),
        ).catch(() => ({}))
      : undefined;
  return (
    <section
      id="opportunities"
      aria-labelledby={OPPORTUNITIES_TITLE_ID}
      data-mode={panel.mode}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      {panel.mode === "shadow" ? (
        <ShadowReview panel={panel} />
      ) : (
        <OpportunityListView panel={panel} fixThis={fixThis} />
      )}
    </section>
  );
}
