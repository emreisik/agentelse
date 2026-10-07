import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { ACCENT_HEX, type BrandingSnapshot } from "@/lib/report-share/types";
import type { SeoReportListItem } from "@/lib/seo/reports/types";
import { revokeReportShareAction } from "@/server/actions/report-share-actions";
import type { ReportShareView } from "@/server/report-share/store";

import {
  ADMIN_HINT,
  BODY_CLASS,
  DETAILS_CLASS,
  HINT_CLASS,
  SUMMARY_CLASS,
  formatDay,
} from "./form-helpers";
import { ShareCreateControls } from "./share-controls";

// Search sayfasındaki "Client reports" kartı (SC-F9): haftalık/aylık raporun
// markalı müşteri görünümü ve süreli paylaşım bağlantıları. Bağlantı
// oluşturma, iptal ve müşteri görünümü bağlantısı yalnız yöneticiye açıktır
// (yazdırma sayfası yöneticiye kapalı olmayan üyeye 404 verirdi). Bağlantı adresi yalnız oluşturulduğu an gösterilir.

const STATUS_TEXT: Record<ReportShareView["status"], string> = {
  ACTIVE: "Active",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

function ShareRow({
  projectId,
  share,
}: {
  projectId: string;
  share: ReportShareView;
}) {
  return (
    <li
      data-share={share.id}
      data-status={share.status}
      className="flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant={share.status === "ACTIVE" ? "secondary" : "outline"}>
            {STATUS_TEXT[share.status]}
          </Badge>
          <span className="tabular-nums">
            {share.viewCount} {share.viewCount === 1 ? "view" : "views"}
          </span>
        </p>
        <p className={HINT_CLASS}>
          Created {formatDay(share.createdAt)}
          {share.status === "REVOKED" && share.revokedAt
            ? ` · revoked ${formatDay(share.revokedAt)}`
            : share.status === "EXPIRED"
              ? ` · expired ${formatDay(share.expiresAt)}`
              : ` · expires ${formatDay(share.expiresAt)}`}
          {share.lastViewedAt
            ? ` · last viewed ${formatDay(share.lastViewedAt)}`
            : ""}
        </p>
      </div>
      {share.status === "ACTIVE" ? (
        <ActionForm
          action={revokeReportShareAction}
          successMessage="Share link revoked"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="shareId" value={share.id} />
          <SubmitButton size="xs" variant="ghost">
            Revoke
          </SubmitButton>
        </ActionForm>
      ) : null}
    </li>
  );
}

function ReportRow({
  projectId,
  report,
  shares,
  isManager,
}: {
  projectId: string;
  report: SeoReportListItem;
  shares: ReportShareView[];
  isManager: boolean;
}) {
  return (
    <li
      data-report={report.id}
      className="space-y-3 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-medium">{report.title}</p>
          <p className={HINT_CLASS}>
            {report.kind === "MONTHLY" ? "Monthly" : "Weekly"} ·{" "}
            {report.periodLabel}
          </p>
        </div>
        {isManager ? (
          <Link
            href={`/projects/${projectId}/arama/client/${report.id}`}
            className="text-sm underline underline-offset-2"
          >
            Open client view
          </Link>
        ) : null}
      </div>
      {isManager ? (
        <details className="rounded-xl ring-1 ring-foreground/10">
          <summary className="cursor-pointer list-none p-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            Share link
            {shares.length > 0 ? (
              <span className={`${HINT_CLASS} ml-2 font-normal`}>
                {shares.filter((share) => share.status === "ACTIVE").length}{" "}
                active
              </span>
            ) : null}
          </summary>
          <div className="space-y-3 border-t border-foreground/10 p-3">
            {shares.length > 0 ? (
              <ul className="space-y-2" aria-label="Share links">
                {shares.map((share) => (
                  <ShareRow key={share.id} projectId={projectId} share={share} />
                ))}
              </ul>
            ) : null}
            <ShareCreateControls projectId={projectId} reportId={report.id} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function ClientReportsCard({
  projectId,
  reports,
  shares,
  branding,
  isManager,
}: {
  projectId: string;
  reports: SeoReportListItem[];
  shares: Record<string, ReportShareView[]>;
  branding: BrandingSnapshot;
  isManager: boolean;
}) {
  return (
    <details data-card="agency-client-reports" className={DETAILS_CLASS}>
      <summary className={SUMMARY_CLASS}>
        <span>Client reports</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {reports.length} {reports.length === 1 ? "report" : "reports"}
        </span>
      </summary>
      <div className={BODY_CLASS}>
        <div
          data-card="branding-summary"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <p className="flex min-w-0 items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              className="inline-block size-3 shrink-0 rounded-full"
              style={{ backgroundColor: ACCENT_HEX[branding.accent] }}
            />
            <span className="truncate">
              Reports are branded as{" "}
              <span className="font-medium">{branding.displayName}</span>
            </span>
          </p>
          {isManager ? (
            <Link href="/search" className="text-sm underline underline-offset-2">
              Edit branding
            </Link>
          ) : null}
        </div>
        {reports.length > 0 ? (
          <ul className="space-y-3">
            {reports.map((report) => (
              <ReportRow
                key={report.id}
                projectId={projectId}
                report={report}
                shares={shares[report.id] ?? []}
                isManager={isManager}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No weekly or monthly reports yet. They appear here as soon as the
            first one is written.
          </p>
        )}
        {!isManager ? <p className={HINT_CLASS}>{ADMIN_HINT}</p> : null}
      </div>
    </details>
  );
}
