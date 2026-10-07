import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { trackHealthFixAction } from "@/server/actions/seo-action-actions";
import type { HealthFixState } from "@/server/seo/actions/fix-this";

// Sağlık sorunu satırındaki "I fixed this" (SC-F6, docs/search-health.md):
// henüz izlenmiyorsa form, izleniyorsa eylemin durumunu gösteren çip (Actions &
// results satırına bağlanır). Yalnız props'tan çizilir.

export function TrackFixButton({
  projectId,
  alertId,
  state,
}: {
  projectId: string;
  alertId: string;
  state: HealthFixState;
}) {
  if ("trackable" in state) {
    return (
      <ActionForm
        action={trackHealthFixAction}
        successMessage="Thanks. We'll check your site."
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="alertId" value={alertId} />
        <SubmitButton variant="outline" size="xs">
          I fixed this
        </SubmitButton>
      </ActionForm>
    );
  }
  return (
    <Link
      href={`/projects/${projectId}/arama?action=${encodeURIComponent(state.actionId)}#actions`}
      data-status={state.status}
      className="inline-flex shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
    >
      {state.statusLabel}
    </Link>
  );
}
