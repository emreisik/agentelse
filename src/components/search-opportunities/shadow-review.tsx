import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import {
  OPPORTUNITIES_TITLE_ID,
  OpportunityChips,
  OpportunityEvidence,
  weekLabel,
} from "@/components/search-opportunities/opportunity-list";
import { SEO_RULE_LABEL } from "@/lib/seo/rules/copy";
import type { SeoShadowVerdict } from "@/lib/seo/opportunity-types";
import { cn } from "@/lib/utils";
import { reviewShadowFindingAction } from "@/server/actions/search-opportunity-actions";
import type { OpportunitiesPanel } from "@/server/seo/opportunities/panel";

// Gölge inceleme (SC-F4, SEO_INSIGHTS=shadow): yalnız platform operatörü,
// erişebildiği projenin Search sayfasında gölge bulguları "Useful / Not
// useful" diye işaretler. /health/search-opportunities kesinliği buradan
// hesaplar; kullanıcıya hiçbir şey gösterilmez.

const VERDICT_LABEL: Readonly<Record<SeoShadowVerdict, string>> = {
  USEFUL: "Useful",
  NOT_USEFUL: "Not useful",
};

const VERDICTS: readonly SeoShadowVerdict[] = ["USEFUL", "NOT_USEFUL"];

export function ShadowReview({
  panel,
}: {
  panel: OpportunitiesPanel;
}): React.JSX.Element {
  const items = panel.shadowReview ?? [];
  const week = weekLabel(panel.week);
  return (
    <div className="space-y-4" data-shadow-review="true">
      <div className="space-y-1">
        <h2
          id={OPPORTUNITIES_TITLE_ID}
          className="font-heading text-base font-semibold"
        >
          Shadow review — only platform operators see this
        </h2>
        <p className="text-xs text-muted-foreground">
          {week
            ? `Opportunities the engine found · week of ${week}. Mark each one so we can measure precision before turning them on.`
            : "Mark each opportunity so we can measure precision before turning them on."}
        </p>
        {panel.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No shadow findings this week.
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              id={`opportunity-${item.id}`}
              data-rule={item.ruleKey}
              className={cn(
                "scroll-mt-20 space-y-2 rounded-xl p-4 ring-1 ring-foreground/10",
                item.highlighted && "ring-2 ring-primary",
              )}
            >
              <div className="space-y-1">
                <p className="text-[11px] text-muted-foreground">
                  {SEO_RULE_LABEL[item.ruleKey] ?? item.ruleKey}
                </p>
                <p className="text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.summary}</p>
              </div>
              <OpportunityChips item={item} />
              <OpportunityEvidence item={item} />
              <div className="flex flex-wrap items-center gap-2">
                {VERDICTS.map((verdict) => (
                  <ActionForm
                    key={verdict}
                    action={reviewShadowFindingAction}
                    successMessage="Thanks for the review"
                  >
                    <input
                      type="hidden"
                      name="projectId"
                      value={panel.projectId}
                    />
                    <input type="hidden" name="findingId" value={item.id} />
                    <input type="hidden" name="verdict" value={verdict} />
                    <SubmitButton
                      size="xs"
                      variant={item.review === verdict ? "default" : "outline"}
                      aria-pressed={item.review === verdict}
                    >
                      {VERDICT_LABEL[verdict]}
                    </SubmitButton>
                  </ActionForm>
                ))}
                <span className="text-xs text-muted-foreground">
                  {item.review
                    ? `Your review: ${VERDICT_LABEL[item.review]}`
                    : "Not reviewed yet"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
