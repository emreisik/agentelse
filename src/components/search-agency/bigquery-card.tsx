import { Badge } from "@/components/ui/badge";
import { BQ_SETUP_STEPS, BQ_SOURCE_ERROR_TEXT } from "@/lib/seo/agency/bq/copy";
import { formatBytes } from "@/lib/seo/agency/bq/cost";
import {
  DEFAULT_MAX_BYTES_PER_QUERY,
  DEFAULT_MONTHLY_BYTES,
  MAX_BYTES_CHOICES_GB,
  MONTHLY_CHOICES_GB,
} from "@/lib/seo/agency/bq/limits";
import { BQ_BADGE_LABEL } from "@/lib/seo/agency/copy";
import type { BqBadge } from "@/lib/seo/agency/types";
import type { BqSourceView } from "@/server/seo/agency/bq/source";

import {
  BigQueryControls,
  BigQuerySetupForm,
  CopyButton,
  type BigQueryFormDefaults,
} from "./bigquery-setup-form";
import {
  ADMIN_HINT,
  BODY_CLASS,
  DETAILS_CLASS,
  HINT_CLASS,
  SUMMARY_CLASS,
  choiceForBytes,
  formatDay,
  usagePercent,
} from "./form-helpers";

// Search sayfasındaki "BigQuery export" kartı (SC-F9). Durumlar: sunucuda
// anahtar yok, kullanıcı mülk sahibi değil (form yok), kaynak yok (kurulum
// adımları + servis hesabı + form), kaynak var (durum, pencere, kullanım,
// mutabakat, kontroller). Yalnız sabit metinler çizilir; Google/BigQuery'nin
// ham iletisi görünmez.

const BADGE_VARIANT: Record<
  BqBadge,
  "default" | "secondary" | "destructive" | "outline"
> = {
  OFF: "outline",
  DRAFT: "outline",
  VERIFIED: "secondary",
  ACTIVE: "default",
  PAUSED: "outline",
  ERROR: "destructive",
  BUDGET: "destructive",
};

function formDefaults(view: BqSourceView): BigQueryFormDefaults {
  const maxBytes =
    view.maxBytesPerQuery > 0
      ? view.maxBytesPerQuery
      : DEFAULT_MAX_BYTES_PER_QUERY;
  const monthly =
    view.monthlyBudgetBytes > 0
      ? view.monthlyBudgetBytes
      : DEFAULT_MONTHLY_BYTES;
  return {
    bqProjectId: view.bqProjectId ?? "",
    dataset: view.dataset ?? "searchconsole",
    maxGb: choiceForBytes(maxBytes, MAX_BYTES_CHOICES_GB),
    monthlyGb: choiceForBytes(monthly, MONTHLY_CHOICES_GB),
    importAll: view.importAll,
  };
}

function reconcileLine(view: BqSourceView): string | null {
  const reconcile = view.reconcile;
  if (!reconcile) return null;
  const parts: string[] = [];
  if (reconcile.clicksDiffPct !== null) {
    parts.push(`clicks ${Math.abs(reconcile.clicksDiffPct).toFixed(1)}%`);
  }
  if (reconcile.impressionsDiffPct !== null) {
    parts.push(
      `impressions ${Math.abs(reconcile.impressionsDiffPct).toFixed(1)}%`,
    );
  }
  const days = `${reconcile.days} ${reconcile.days === 1 ? "day" : "days"}`;
  return parts.length > 0
    ? `Compared with the Search Console API over ${days}: ${parts.join(", ")} difference (checked ${formatDay(reconcile.checkedAt)}).`
    : `Compared with the Search Console API over ${days} (checked ${formatDay(reconcile.checkedAt)}).`;
}

function UsageBar({ view }: { view: BqSourceView }) {
  const percent = usagePercent(view.usedBytesMonth, view.monthlyBudgetBytes);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Used this month</span>
        <span className="tabular-nums">
          {formatBytes(view.usedBytesMonth)} of{" "}
          {formatBytes(view.monthlyBudgetBytes)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="BigQuery usage this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${percent >= 100 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className={HINT_CLASS}>
        {view.queriesMonth} {view.queriesMonth === 1 ? "query" : "queries"} this
        month. Single import limit {formatBytes(view.maxBytesPerQuery)}.
      </p>
    </div>
  );
}

function Shell({
  status,
  open,
  children,
}: {
  status: BqBadge | null;
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <details data-card="agency-bigquery" className={DETAILS_CLASS} open={open}>
      <summary className={SUMMARY_CLASS}>
        <span>BigQuery export</span>
        {status ? (
          <Badge variant={BADGE_VARIANT[status]}>
            {BQ_BADGE_LABEL[status]}
          </Badge>
        ) : null}
      </summary>
      <div className={BODY_CLASS}>{children}</div>
    </details>
  );
}

export function BigQueryCard({
  projectId,
  linkId,
  view,
  isManager,
  defaultOpen = false,
}: {
  projectId: string;
  linkId: string;
  view: BqSourceView;
  isManager: boolean;
  // Kaynak yokken, mülk sahibiyken ve haftalık tablolar kesilmişken açık gelir.
  defaultOpen?: boolean;
}) {
  if (!view.configured) {
    return (
      <Shell status={null} open={false}>
        <p
          data-state="not-configured"
          className="text-sm text-muted-foreground"
        >
          BigQuery export isn&apos;t available on this server yet.
        </p>
      </Shell>
    );
  }
  if (!view.isOwner) {
    return (
      <Shell status={null} open={false}>
        <p data-state="not-owner" className="text-sm text-muted-foreground">
          {BQ_SOURCE_ERROR_TEXT.NOT_OWNER}
        </p>
      </Shell>
    );
  }

  const hasSource = view.status !== "OFF";
  const errorText =
    view.errorText ??
    (view.lastError ? BQ_SOURCE_ERROR_TEXT[view.lastError] : null);

  if (!hasSource) {
    return (
      <Shell status="OFF" open={defaultOpen}>
        <p className="text-sm text-muted-foreground">
          Search Console&apos;s bulk export keeps every query and page, beyond the
          row limits of the API. Agentelse uses it to fill in weeks the API cut
          short or never returned.</p>
        <ol
          className="list-decimal space-y-1 pl-5 text-sm"
          data-card="bq-steps"
        >
          {BQ_SETUP_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {view.serviceAccountEmail ? (
          <div className="space-y-1">
            <p className={HINT_CLASS}>Service account to grant access</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-lg bg-muted px-2 py-1 text-xs">
                {view.serviceAccountEmail}
              </code>
              <CopyButton value={view.serviceAccountEmail} />
            </div>
          </div>
        ) : null}
        {isManager ? (
          <BigQuerySetupForm
            projectId={projectId}
            linkId={linkId}
            defaults={formDefaults(view)}
            submitLabel="Save"
          />
        ) : (
          <p className={HINT_CLASS}>{ADMIN_HINT}</p>
        )}
      </Shell>
    );
  }

  const reconcile = reconcileLine(view);
  return (
    <Shell status={view.status} open={defaultOpen}>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className={HINT_CLASS}>Dataset</dt>
          <dd className="break-all">
            {view.bqProjectId}.{view.dataset}
          </dd>
        </div>
        <div>
          <dt className={HINT_CLASS}>Export window</dt>
          <dd>
            {view.exportStart && view.exportedThrough
              ? `${formatDay(view.exportStart)} to ${formatDay(view.exportedThrough)}`
              : "Not checked yet"}
          </dd>
        </div>
        <div>
          <dt className={HINT_CLASS}>Imported</dt>
          <dd>
            {view.imported.weeks} {view.imported.weeks === 1 ? "week" : "weeks"}
            {", "}
            {view.imported.months}{" "}
            {view.imported.months === 1 ? "month" : "months"}
          </dd>
        </div>
        <div>
          <dt className={HINT_CLASS}>Complete data</dt>
          <dd>
            Complete data for {view.completeWeeks}{" "}
            {view.completeWeeks === 1 ? "week" : "weeks"}
          </dd>
        </div>
      </dl>
      <UsageBar view={view} />
      {reconcile ? <p className={HINT_CLASS}>{reconcile}</p> : null}
      {view.lastSyncAt ? (
        <p className={HINT_CLASS}>Last import {formatDay(view.lastSyncAt)}.</p>
      ) : null}
      {errorText ? (
        <p data-state="error" className="text-sm text-destructive">
          {errorText}
        </p>
      ) : null}
      {isManager ? (
        <>
          <BigQueryControls
            projectId={projectId}
            linkId={linkId}
            status={view.status}
          />
          <details className="rounded-xl ring-1 ring-foreground/10">
            <summary className="cursor-pointer list-none p-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              Settings
            </summary>
            <div className="space-y-3 border-t border-foreground/10 p-3">
              {view.serviceAccountEmail ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Service account</span>
                  <code className="break-all rounded-lg bg-muted px-2 py-1">
                    {view.serviceAccountEmail}
                  </code>
                  <CopyButton value={view.serviceAccountEmail} />
                </div>
              ) : null}
              <BigQuerySetupForm
                projectId={projectId}
                linkId={linkId}
                defaults={formDefaults(view)}
                submitLabel="Save settings"
              />
            </div>
          </details>
        </>
      ) : (
        <p className={HINT_CLASS}>{ADMIN_HINT}</p>
      )}
    </Shell>
  );
}
