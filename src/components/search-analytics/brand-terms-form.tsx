import { saveBrandTermsAction } from "@/server/actions/search-analytics-actions";
import type { BrandSplitStatus } from "@/server/seo/brand-terms";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Textarea } from "@/components/ui/textarea";

// Marka terimleri (SC-F2, SK8 v1): bu kelimeleri içeren aramalar marka
// sayılır. Search sayfasında ve Connectors kartında (kapalı) aynı form;
// terim yoksa ya da Google terimleri reddettiyse açık gelir.

const STATUS_NOTE: Record<BrandSplitStatus, string | null> = {
  ready: null,
  pending:
    "Brand and non-brand clicks are being recalculated with these terms.",
  none: "Add your brand name to see brand and non-brand searches apart.",
  error: "Google couldn't use these terms. Try shorter, simpler words.",
};

export function BrandTermsForm({
  projectId,
  terms,
  status,
  defaultOpen = false,
}: {
  projectId: string;
  terms: string[];
  status: BrandSplitStatus;
  defaultOpen?: boolean;
}) {
  const open = defaultOpen || status === "none" || status === "error";
  const note = STATUS_NOTE[status];
  return (
    <details
      open={open}
      className="group rounded-xl p-4 ring-1 ring-foreground/10"
      data-brand-terms={status}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Brand terms
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          Searches that contain these words count as brand searches. One per
          line or separated by commas.
        </p>
        {note ? (
          <p
            className={
              status === "error"
                ? "text-xs text-amber-700 dark:text-amber-400"
                : "text-xs text-muted-foreground"
            }
          >
            {note}
          </p>
        ) : null}
        <ActionForm
          action={saveBrandTermsAction}
          successMessage="Brand terms saved. Brand and non-brand clicks update with the next sync."
          className="space-y-2"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <Textarea
            name="terms"
            rows={3}
            defaultValue={terms.join("\n")}
            aria-label="Brand terms"
            className="text-xs md:text-xs"
          />
          <div className="flex justify-end">
            <SubmitButton size="xs">Save brand terms</SubmitButton>
          </div>
        </ActionForm>
      </div>
    </details>
  );
}
