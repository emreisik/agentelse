import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";
import type { GaFixOffer } from "@/lib/website-analytics/fixes/view-types";
import { proposeGaFixAction } from "@/server/actions/ga-fix-actions";

// "Fix it for me (needs approval)" (GA-F7, docs/website-fixes.md): kontrol
// kartlarındaki rehberin altında tek öneri. Düğme yalnız 'available' durumunda
// vardır; onay ayrıca istenir. Sunucuda çizilir; ActionForm/SubmitButton istemci.

export const FIX_IT_SUCCESS_MESSAGE =
  "Sent for approval. A workspace owner or admin can approve it here or in the chat.";

export function FixItButton({
  projectId,
  offer,
  canManage = true,
}: {
  projectId: string;
  offer: GaFixOffer;
  // Düzenleme iznini yalnız OWNER/ADMIN verir; başkasına bağlantı gösterilmez.
  canManage?: boolean;
}) {
  if (offer.state === "done") {
    return <p className="text-xs text-muted-foreground">Done</p>;
  }
  if (offer.state === "pending") {
    return (
      <p className="text-xs text-muted-foreground">Waiting for approval</p>
    );
  }
  if (offer.state === "needs_access") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Agentelse can only read your Google Analytics right now.</span>
        {canManage ? (
          <a
            href={gaEditStartHref(projectId)}
            className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
          >
            Allow editing
          </a>
        ) : (
          <span>Ask a workspace owner or admin to allow editing.</span>
        )}
      </div>
    );
  }

  return (
    <ActionForm
      action={proposeGaFixAction}
      successMessage={FIX_IT_SUCCESS_MESSAGE}
      className="space-y-1.5"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="kind" value={offer.kind} />
      <input type="hidden" name="source" value="GUIDE" />
      <div className="flex flex-wrap items-center gap-2">
        {offer.field ? (
          <select
            name={offer.field.name}
            aria-label={offer.field.label}
            defaultValue={offer.field.options[0]?.value}
            className="h-6 rounded-lg border border-input bg-background px-2 text-xs"
          >
            {offer.field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        <SubmitButton variant="outline" size="xs">
          {offer.buttonLabel}
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">{offer.description}</p>
    </ActionForm>
  );
}
