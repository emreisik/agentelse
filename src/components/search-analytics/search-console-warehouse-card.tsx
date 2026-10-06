import Link from "next/link";

import {
  deleteSearchDataAction,
  setSearchArchiveAction,
} from "@/server/actions/search-analytics-actions";
import type { SearchLinkInfo } from "@/server/seo/report";
import { BrandTermsForm } from "@/components/search-analytics/brand-terms-form";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";

// Connectors > Google Search Console içindeki ambar kartı (GSC_SYNC, SC-F2):
// verinin hangi kesin güne kadar geldiği (PT), mülk türü, SK3 arşiv ayarı,
// "Delete stored data" (yalnız OWNER/ADMIN) ve marka terimleri. Bağlı
// değilken sayfa yalnız saklama uyarısını gösterir.

export const SEARCH_CONSOLE_RETENTION_NOTICE =
  "Agentelse keeps your Search Console history, including data older than the 16 months Google keeps. You can delete it anytime.";

const PROPERTY_TYPE_LABEL: Record<string, string> = {
  DOMAIN: "Domain property",
  URL_PREFIX: "URL-prefix property",
};

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

export function SearchConsoleWarehouseCard({
  projectId,
  info,
  searchHref,
  canManage,
}: {
  projectId: string;
  info: SearchLinkInfo | null;
  searchHref: string | null;
  canManage: boolean;
}) {
  if (!info) {
    return (
      <div className="rounded-lg bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
        Search Console data is on its way. The first numbers usually arrive
        within a few minutes.
      </div>
    );
  }
  const through = info.finalThrough ? dayLabel(info.finalThrough) : null;
  const propertyType = info.propertyType
    ? (PROPERTY_TYPE_LABEL[info.propertyType] ?? null)
    : null;
  return (
    <div className="space-y-2">
      <div className="space-y-1 rounded-lg bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
        <p className="font-medium text-foreground">
          {through
            ? `Final data through ${through}`
            : "Getting your data from Search Console…"}
          {through && !info.backfillDone ? " · older history loading" : ""}
        </p>
        <p>
          {["Search Console days (Pacific Time)", propertyType]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {searchHref ? (
          <Link
            href={searchHref}
            className="inline-block font-medium text-foreground underline underline-offset-2"
          >
            Open Search report
          </Link>
        ) : null}

        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/5 pt-2"
          data-archive={info.archive ? "on" : "off"}
        >
          <p>
            {info.archive
              ? "Keeps history older than the 16 months Google keeps."
              : "Keeps the last 16 months, like Google."}
          </p>
          {canManage && !info.archive ? (
            <ArchiveForm projectId={projectId} archive />
          ) : null}
        </div>
        {/* Arşivi kapatmak 16 aydan eski veriyi hemen ve geri dönüşsüz siler
            (Google'da artık yok): Delete stored data gibi önce açıklama. */}
        {canManage && info.archive ? (
          <details className="pt-1" data-archive-off-confirm>
            <summary className="cursor-pointer font-medium text-foreground">
              Keep only 16 months
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                Search Console data older than 16 months will be deleted now
                and can&apos;t be loaded again. Google doesn&apos;t keep it
                either.
              </p>
              <ArchiveForm projectId={projectId} archive={false} />
            </div>
          </details>
        ) : null}

        {canManage ? (
          <details className="border-t border-foreground/5 pt-2">
            <summary className="cursor-pointer font-medium text-foreground">
              Delete stored data
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                This deletes the Search Console history Agentelse stored for
                this project, including data older than Google keeps. The last
                16 months load again from Google.
              </p>
              <ActionForm
                action={deleteSearchDataAction}
                successMessage="Stored Search Console data deleted"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton variant="destructive" size="xs">
                  Delete stored data
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        ) : null}
      </div>

      <BrandTermsForm
        projectId={projectId}
        terms={info.brandTerms}
        status={info.brandSplit}
      />
    </div>
  );
}

// Arşiv ayarı: `archive` gönderilecek yeni değer.
function ArchiveForm({
  projectId,
  archive,
}: {
  projectId: string;
  archive: boolean;
}) {
  return (
    <ActionForm
      action={setSearchArchiveAction}
      successMessage={
        archive ? "Full history is kept now" : "Only the last 16 months are kept now"
      }
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="archive" value={archive ? "true" : "false"} />
      <SubmitButton variant={archive ? "outline" : "destructive"} size="xs">
        {archive ? "Keep full history" : "Delete older data"}
      </SubmitButton>
    </ActionForm>
  );
}
