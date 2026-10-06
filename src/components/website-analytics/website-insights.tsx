import {
  ActionForm,
  type ActionResult,
} from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { MeasurementDot } from "@/components/website-analytics/measurement-score";
import { cn } from "@/lib/utils";
import {
  findingConfidenceText,
  findingDetail,
  findingImpactText,
  findingPeriodText,
  findingStatusText,
  findingTitle,
} from "@/lib/website-analytics/analysis/describe";
import type {
  GaFindingSeverity,
  GaReviewVerdict,
} from "@/lib/website-analytics/analysis/types";
import type {
  GaFindingView,
  WebsiteInsightsView,
} from "@/lib/website-analytics/analysis/view-types";
import type { MeasurementTone } from "@/lib/website-analytics/health/view-types";
import {
  acceptGaFindingAction,
  dismissGaFindingAction,
  markGaFindingDoneAction,
  reviewGaFindingAction,
} from "@/server/actions/website-insights-actions";

// "Website" sayfasındaki "Insights" bölümü (GA-F4, docs/website-insights.md
// "Yüzeyler"): "What changed" ve "Opportunities" kartları, Accept / Dismiss /
// Mark done. ?insights=review iken operatör gölge bulguları da görür ve her
// birini Useful / Not useful işaretler. Sunucuda çizilir; yalnız
// ActionForm/SubmitButton istemci bileşeni. Tek sütun, mobil önce.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
const TITLE_ID = "insights-title";
const CHIP =
  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium";

const SEVERITY_TONE: Record<GaFindingSeverity, MeasurementTone> = {
  CRITICAL: "error",
  WARN: "warning",
  INFO: "unknown",
};

const CONFIDENCE_HINT = {
  Significant: "Passed the statistical check",
  Directional: "A likely pattern, not proven",
} as const;

const VERDICT_TEXT: Record<GaReviewVerdict, string> = {
  USEFUL: "Marked useful",
  NOT_USEFUL: "Marked not useful",
};

function HiddenIds({
  projectId,
  findingId,
}: {
  projectId: string;
  findingId: string;
}) {
  return (
    <>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="findingId" value={findingId} />
    </>
  );
}

function FindingButton({
  projectId,
  finding,
  title,
  action,
  label,
  successMessage,
  variant,
  verdict,
}: {
  projectId: string;
  finding: GaFindingView;
  title: string;
  action: (formData: FormData) => Promise<ActionResult>;
  label: string;
  successMessage: string;
  variant: "outline" | "ghost";
  verdict?: GaReviewVerdict;
}) {
  return (
    <ActionForm action={action} successMessage={successMessage}>
      <HiddenIds projectId={projectId} findingId={finding.id} />
      {verdict ? <input type="hidden" name="verdict" value={verdict} /> : null}
      <SubmitButton
        variant={variant}
        size="xs"
        aria-label={`${label}: ${title}`}
      >
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

function LiveActions({
  projectId,
  finding,
  title,
}: {
  projectId: string;
  finding: GaFindingView;
  title: string;
}) {
  if (finding.mode !== "live") return null;
  const canAccept = finding.status === "OPEN";
  const canFinish = finding.status === "ACCEPTED" && finding.evaluable;
  if (!canAccept && !canFinish) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canAccept ? (
        <FindingButton
          projectId={projectId}
          finding={finding}
          title={title}
          action={acceptGaFindingAction}
          label="Accept"
          successMessage="Accepted"
          variant="outline"
        />
      ) : (
        <FindingButton
          projectId={projectId}
          finding={finding}
          title={title}
          action={markGaFindingDoneAction}
          label="Mark done"
          successMessage="Marked done. We'll measure the results."
          variant="outline"
        />
      )}
      <FindingButton
        projectId={projectId}
        finding={finding}
        title={title}
        action={dismissGaFindingAction}
        label="Dismiss"
        successMessage="Dismissed"
        variant="ghost"
      />
    </div>
  );
}

function ReviewActions({
  projectId,
  finding,
  title,
}: {
  projectId: string;
  finding: GaFindingView;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FindingButton
        projectId={projectId}
        finding={finding}
        title={title}
        action={reviewGaFindingAction}
        label="Useful"
        successMessage="Marked useful"
        variant={finding.reviewVerdict === "USEFUL" ? "outline" : "ghost"}
        verdict="USEFUL"
      />
      <FindingButton
        projectId={projectId}
        finding={finding}
        title={title}
        action={reviewGaFindingAction}
        label="Not useful"
        successMessage="Marked not useful"
        variant={finding.reviewVerdict === "NOT_USEFUL" ? "outline" : "ghost"}
        verdict="NOT_USEFUL"
      />
      <span className="text-[11px] text-muted-foreground">
        {finding.reviewVerdict
          ? VERDICT_TEXT[finding.reviewVerdict]
          : "Not reviewed yet"}
      </span>
    </div>
  );
}

function FindingItem({
  projectId,
  finding,
  view,
}: {
  projectId: string;
  finding: GaFindingView;
  view: WebsiteInsightsView;
}) {
  const title = findingTitle(finding);
  const confidence = findingConfidenceText(finding.confidence);
  const period = findingPeriodText(finding.period);
  const detail = findingDetail(finding, { currency: view.currency });
  const impact = findingImpactText(finding.impact, {
    currency: view.currency,
    finding,
  });
  const status = findingStatusText(finding, { timeZone: view.timeZone });

  return (
    <article
      id={`finding-${finding.id}`}
      className="scroll-mt-20 space-y-2 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <MeasurementDot tone={SEVERITY_TONE[finding.severity] ?? "unknown"} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h4 className="text-sm font-medium break-words">{title}</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                CHIP,
                finding.confidence === "SIGNIFICANT"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
              title={CONFIDENCE_HINT[confidence]}
            >
              {confidence}
            </span>
            {finding.preliminary ? (
              <span
                className={cn(
                  CHIP,
                  "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                )}
                title="Google Analytics may still update these days"
              >
                Preliminary
              </span>
            ) : null}
            {view.review && finding.mode === "shadow" ? (
              <span className={cn(CHIP, "bg-accent text-accent-foreground")}>
                Shadow
              </span>
            ) : null}
            {period ? (
              <span className="text-[11px] text-muted-foreground">
                {period}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="space-y-1.5 pl-3.5 text-xs">
        {detail ? <p className="text-muted-foreground">{detail}</p> : null}
        {finding.explanation ? (
          <div className="rounded-lg bg-muted/50 px-2.5 py-2">
            <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Summary
            </p>
            <p className="mt-0.5 text-foreground">{finding.explanation}</p>
          </div>
        ) : null}
        {impact ? (
          <p className="font-medium text-foreground">{impact}</p>
        ) : null}
        {status ? <p className="text-muted-foreground">{status}</p> : null}
      </div>
      <div className="space-y-2 pl-3.5">
        <LiveActions projectId={projectId} finding={finding} title={title} />
        {view.review ? (
          <ReviewActions
            projectId={projectId}
            finding={finding}
            title={title}
          />
        ) : null}
      </div>
    </article>
  );
}

function FindingList({
  projectId,
  findings,
  view,
}: {
  projectId: string;
  findings: GaFindingView[];
  view: WebsiteInsightsView;
}) {
  return (
    <div className="divide-y divide-foreground/10">
      {findings.map((finding) => (
        <FindingItem
          key={finding.id}
          projectId={projectId}
          finding={finding}
          view={view}
        />
      ))}
    </div>
  );
}

export function WebsiteInsights({
  projectId,
  view,
}: {
  projectId: string;
  view: WebsiteInsightsView;
}) {
  return (
    <section
      id="insights"
      aria-labelledby={TITLE_ID}
      className="scroll-mt-20 space-y-3"
    >
      <div className="space-y-1">
        <h2 id={TITLE_ID} className="font-heading text-base font-semibold">
          Insights
        </h2>
        {view.review ? (
          <p className="text-xs text-muted-foreground">
            Review mode: shadow findings are visible only to you. Mark each one
            useful or not.
          </p>
        ) : null}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className={cn(CARD, "space-y-3")}>
          <h3 className="text-sm font-semibold">What changed</h3>
          {view.changed.length > 0 ? (
            <FindingList
              projectId={projectId}
              findings={view.changed}
              view={view}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing unusual lately. We check every day and every Monday.
            </p>
          )}
        </div>
        <div className={cn(CARD, "space-y-3")}>
          <h3 className="text-sm font-semibold">Opportunities</h3>
          {view.opportunities.length > 0 ? (
            <FindingList
              projectId={projectId}
              findings={view.opportunities}
              view={view}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No opportunities right now. We look again every Monday.
            </p>
          )}
          {view.inProgress.length > 0 ? (
            <div className="space-y-2 border-t border-foreground/10 pt-3">
              <h4 className="text-xs font-medium text-muted-foreground">
                In progress
              </h4>
              <FindingList
                projectId={projectId}
                findings={view.inProgress}
                view={view}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
