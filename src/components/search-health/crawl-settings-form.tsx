import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { CRAWL_PAGE_LIMITS } from "@/lib/seo/audit-constants";
import { setSiteCrawlAction } from "@/server/actions/search-health-actions";

// Site denetimi ayarı (SC-F3): açık/kapalı ve haftalık sayfa sınırı. Bütün
// ekibi etkiler; yalnız OWNER/ADMIN'e çizilir (eylem de ayrıca denetler).

export function CrawlSettingsForm({
  projectId,
  enabled,
  pageLimit,
}: {
  projectId: string;
  enabled: boolean;
  pageLimit: number;
}) {
  return (
    <ActionForm
      action={setSiteCrawlAction}
      successMessage="Site audit settings saved"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          name="crawlEnabled"
          defaultChecked={enabled}
          className="size-3.5 accent-foreground"
        />
        Run the site audit
      </label>
      <label className="inline-flex items-center gap-2">
        Up to
        <select
          name="pageLimit"
          defaultValue={String(pageLimit)}
          className="rounded-md border border-input bg-background px-1.5 py-1 text-xs"
        >
          {CRAWL_PAGE_LIMITS.map((limit) => (
            <option key={limit} value={String(limit)}>
              {limit}
            </option>
          ))}
        </select>
        pages a week
      </label>
      <SubmitButton variant="outline" size="xs">
        Save
      </SubmitButton>
    </ActionForm>
  );
}
