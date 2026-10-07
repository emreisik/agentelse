"use client";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { EMPTY_COPY, PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { planThisMonthAction } from "@/server/actions/seo-content-plan-actions";
import type { ContentPlanView } from "@/server/seo/content-plan/store";

// Plan yokken görünen durumlar (SC-F7): veri bekleniyor, plan hazırlanıyor ya
// da boş (neden sabit metinle söylenir). "Plan this month" yalnız elle plan
// mümkünken çıkar.

const WAITING_TEXT =
  "This month's plan is being prepared. It appears here after the weekly search analysis.";

export function PlanStateView({
  view,
  projectId,
}: {
  view: ContentPlanView;
  projectId: string;
}) {
  const text =
    view.state === "needs_data"
      ? view.emptyText || EMPTY_COPY.NO_DATA
      : view.state === "empty"
        ? view.emptyText ||
          (view.emptyReason ? EMPTY_COPY[view.emptyReason] : WAITING_TEXT)
        : WAITING_TEXT;
  return (
    <div
      data-state={view.state}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-4 ring-1 ring-foreground/10"
    >
      <p className="max-w-prose text-sm text-muted-foreground">{text}</p>
      {view.canPlanNow ? (
        <ActionForm
          action={planThisMonthAction}
          successMessage="This month's plan is ready."
        >
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton size="sm">{PLAN_COPY.planNow}</SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}
