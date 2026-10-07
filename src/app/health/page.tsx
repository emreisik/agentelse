import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  HeartPulse,
  Lightbulb,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import { isIntegrationConfigured } from "@/lib/env";
import { timeAgo } from "@/lib/dates";
import {
  ERROR_CATEGORY,
  PROVIDER_HEALTH_STATUS,
  RECOVERY_STRATEGY,
  describeAuditAction,
} from "@/lib/labels";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { buildSystemHealthReport } from "@/server/observability/health-report";
import { prisma } from "@/lib/prisma";
import { AdsInsurance } from "@/server/ads/insurance";
import { isPlatformOperator } from "@/server/security/operator";
import { loadGaHealthCounters } from "@/server/website-analytics/health-counters";
import { GaHealthCard } from "@/components/website-analytics/ga-health-card";
import { loadGaMeasurementCounters } from "@/server/website-analytics/health/read";
import { GaMeasurementCountersCard } from "@/components/website-analytics/ga-measurement-counters-card";
import { loadGaFixCounters } from "@/server/website-analytics/fixes/counters";
import { GaFixesCountersCard } from "@/components/website-analytics/ga-fixes-counters-card";
import { loadSeoOperatorCounters } from "@/server/seo/health/operator-counters";
import { SeoOperatorCard } from "@/components/search-health/seo-operator-card";
import { loadGaInsightsOperatorView } from "@/server/website-analytics/analysis/read";
import { GaInsightsOperatorCard } from "@/components/website-analytics/ga-insights-operator-card";
import { loadSeoOpportunityCounters } from "@/server/seo/opportunities/operator-counters";
import { loadSeoReportCounters } from "@/server/seo/reports/counters";
import { SeoReportCountersCard } from "@/components/search-reports/seo-report-counters-card";
import { loadSeoActionCounters } from "@/server/seo/actions/operator-counters";
import { SeoActionCountersCard } from "@/components/search-actions/seo-action-counters-card";
import { loadSeoContentPlanCounters } from "@/server/seo/content-plan/counters";
import { ContentPlanCountersCard } from "@/components/search-content-plan/content-plan-counters-card";
import {
  clearProviderIncidentAction,
  dismissDeadLetterAction,
  retryDeadLetterAction,
  runHealthScanAction,
} from "@/server/actions/health-actions";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "danger" | "waiting" | "positive" | "neutral";
}) {
  const toneClass =
    value === 0
      ? "text-muted-foreground"
      : tone === "danger"
        ? "text-destructive"
        : tone === "waiting"
          ? "text-warning"
          : tone === "positive"
            ? "text-success"
            : "text-foreground";
  return (
    <div className="rounded-xl p-4 ring-1 ring-foreground/10">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-heading text-2xl font-semibold ${toneClass}`}>
        {value}
      </p>
    </div>
  );
}

export default async function HealthPage() {
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  // Platform-wide data (every tenant's dead letters and provider health):
  // the operator only (docs/meta-ads-plan.md F1).
  if (!isPlatformOperator(userId)) {
    return (
      <AppShell>
        <div className="space-y-2 p-6">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            System Health
          </h1>
          <p className="text-sm text-muted-foreground">
            System health is visible to the platform operator only. To see it,
            add your user id to OPERATOR_USER_IDS on the server:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {userId}
            </code>
          </p>
        </div>
      </AppShell>
    );
  }
  const report = await buildSystemHealthReport(workspaceId);
  // Meta Ads F7: Disconnect'te silinemeyen güvenlik kuralları ve 5 denemede
  // işlenemeyen webhook olayları (operatör elle bakar). GA-F2b: Google
  // Analytics sayaçları (yalnız sayılar, GA_SYNC kapalıyken null). SC-F2:
  // dikkat isteyen, geçmişi yüklenen ve Google kotasını bekleyen siteler.
  // GA-F3: ölçüm sağlığı sayaçları; SC-F3: arama sağlığı ve tarayıcı
  // sayaçları (bayraklar kapalıyken null). GA-F4: website içgörüleri (operatör
  // görünümü); SC-F4: SEO fırsat motoru sayaçları; SC-F5: Search rapor
  // sayaçları; SC-F6: SEO eylem sayaçları; GA-F7: GA düzeltme sayaçları;
  // SC-F7: SEO içerik planı sayaçları. Bunlar `healthy`'ye sayılmaz.
  const now = new Date();
  const [
    leftoverRules,
    deadWebhooks,
    gaCounters,
    gscAttention,
    gscBackfilling,
    gscQuotaWaiting,
    gaMeasurement,
    seoCounters,
    gaInsights,
    seoOpportunities,
    seoReports,
    seoActionCounters,
    gaFixes,
    seoContentPlan,
  ] = await Promise.all([
    AdsInsurance.undeletable().catch(() => []),
    prisma.adsWebhookEvent.count({ where: { status: "DEAD" } }).catch(() => 0),
    loadGaHealthCounters().catch(() => null),
    prisma.gscSiteLink
      .count({
        where: { isPrimary: true, health: { notIn: ["OK", "UNKNOWN"] } },
      })
      .catch(() => 0),
    prisma.gscSiteLink
      .count({ where: { isPrimary: true, backfillDoneAt: null } })
      .catch(() => 0),
    prisma.gscSiteLink
      .count({
        where: {
          isPrimary: true,
          OR: [
            { rateLimitedUntil: { gt: now } },
            { loadLimitedUntil: { gt: now } },
            { heavyLimitedUntil: { gt: now } },
          ],
        },
      })
      .catch(() => 0),
    loadGaMeasurementCounters().catch(() => null),
    loadSeoOperatorCounters(now).catch(() => null),
    loadGaInsightsOperatorView({ userId }).catch(() => null),
    loadSeoOpportunityCounters(now).catch(() => null),
    loadSeoReportCounters(now).catch(() => null),
    loadSeoActionCounters(now).catch(() => null),
    loadGaFixCounters().catch(() => null),
    loadSeoContentPlanCounters(now).catch(() => null),
  ]);

  const healthy =
    report.totals.failedJobs === 0 &&
    report.totals.openDeadLetters === 0 &&
    report.totals.stuckJobs === 0 &&
    report.totals.failedReasoningCalls === 0;

  const telegramConfigured = isIntegrationConfigured("TELEGRAM");

  return (
    <AppShell>
      <div className="space-y-6 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              System Health
            </h1>
            <p className="text-sm text-muted-foreground">
              Errors, provider status, and auto-recovery records from the last{" "}
              {report.windowHours} hours
            </p>
          </div>
          <div className="flex items-center gap-2">
            <LiveRefresh intervalMs={15_000} />
            <ActionForm
              action={runHealthScanAction}
              successMessage="Health scan started"
            >
              <SubmitButton size="sm" variant="outline">
                <RefreshCw className="size-4" />
                Scan now
              </SubmitButton>
            </ActionForm>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <StatTile
            label="Failed tasks"
            value={report.totals.failedJobs}
            tone="danger"
          />
          <StatTile
            label="Failed AI calls"
            value={report.totals.failedReasoningCalls}
            tone="danger"
          />
          <StatTile
            label="Open dead letters"
            value={report.totals.openDeadLetters}
            tone="waiting"
          />
          <StatTile
            label="Stuck jobs"
            value={report.totals.stuckJobs}
            tone="waiting"
          />
          <StatTile
            label="Auto recoveries"
            value={report.totals.autoRecoveries}
            tone="positive"
          />
        </div>

        {healthy ? (
          <Card>
            <CardContent className="flex items-center gap-3 pt-6">
              <span className="flex size-9 items-center justify-center rounded-lg bg-success/15">
                <ShieldCheck className="size-5 text-success" />
              </span>
              <div>
                <p className="font-medium">All good</p>
                <p className="text-sm text-muted-foreground">
                  No unresolved errors in the last {report.windowHours} hours.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <Send className="size-4" />
            </span>
            <CardTitle className="text-base">Notification Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-accent/40 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">Telegram</p>
                <p className="text-[11px] text-muted-foreground">
                  Sends notifications for dead letters that require human
                  intervention
                </p>
              </div>
              <StatusBadge
                meta={
                  telegramConfigured
                    ? { label: "Active", tone: "positive" }
                    : { label: "Not configured", tone: "neutral" }
                }
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <AlertTriangle className="size-4" />
            </span>
            <CardTitle className="text-base">
              Error groups ({report.groups.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {report.groups.length === 0 ? (
              <EmptyState
                icon={HeartPulse}
                title="No errors to group"
                hint="No task, AI call, or queue record errored in this window."
              />
            ) : (
              report.groups.map((group) => (
                <div
                  key={group.signature}
                  className="rounded-xl p-4 ring-1 ring-foreground/10"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      meta={ERROR_CATEGORY[group.category]}
                      fallback={group.category}
                      showIcon
                    />
                    <StatusBadge
                      meta={RECOVERY_STRATEGY[group.strategy]}
                      fallback={group.strategy}
                    />
                    <span className="text-xs text-muted-foreground">
                      {group.count} times · last {timeAgo(group.lastSeenAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">{group.summary}</p>
                  <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                    {group.sampleMessage}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Source: {group.sources.join(", ")}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
                <Activity className="size-4" />
              </span>
              <CardTitle className="text-base">Provider status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {report.providers.length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="No provider records yet"
                  hint="Providers are auto-registered on the first worker tick."
                />
              ) : (
                report.providers.map((provider) => (
                  <div
                    key={provider.key}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">
                          {provider.key}
                        </span>
                        <StatusBadge
                          meta={PROVIDER_HEALTH_STATUS[provider.status]}
                          fallback={provider.status}
                        />
                        {!provider.configured ? (
                          <span className="text-xs text-muted-foreground">
                            not configured
                          </span>
                        ) : null}
                      </div>
                      {provider.lastErrorMessage ? (
                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                          {provider.lastErrorMessage}
                        </p>
                      ) : null}
                    </div>
                    {provider.openIncidents > 0 ? (
                      <ActionForm
                        action={clearProviderIncidentAction}
                        successMessage="Provider marked healthy"
                      >
                        <input
                          type="hidden"
                          name="providerKey"
                          value={provider.key}
                        />
                        <SubmitButton size="sm" variant="outline">
                          Mark healthy
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
                <Wrench className="size-4" />
              </span>
              <CardTitle className="text-base">
                Recent auto recoveries
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {report.recentRecoveries.length === 0 ? (
                <EmptyState
                  icon={Wrench}
                  title="No auto recoveries yet"
                  hint="If a stuck job or a retryable queue record appears, the system heals it automatically and logs it here."
                />
              ) : (
                report.recentRecoveries.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-lg bg-accent/40 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{describeAuditAction(entry.action)}</span>
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(entry.createdAt)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {leftoverRules.length > 0 || deadWebhooks > 0 ? (
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
                <AlertTriangle className="size-4" />
              </span>
              <CardTitle className="text-base">Meta Ads clean-up</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {deadWebhooks > 0 ? (
                <p className="text-muted-foreground">
                  {deadWebhooks} ad webhook event
                  {deadWebhooks === 1 ? "" : "s"} failed 5 times. Polling
                  still covers them.
                </p>
              ) : null}
              {leftoverRules.map((rule) => (
                <div
                  key={rule.launchId}
                  className="rounded-lg bg-accent/40 px-3 py-2"
                >
                  <p>
                    Safety rule{" "}
                    <span className="font-mono text-xs">{rule.ruleId}</span>{" "}
                    couldn&apos;t be deleted at Disconnect (project{" "}
                    <span className="font-mono text-xs">{rule.projectId}</span>
                    ). Delete it in Ads Manager → Automated rules.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {timeAgo(new Date(rule.at))}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {gaCounters ? <GaHealthCard counters={gaCounters} /> : null}
        {gaMeasurement ? (
          <GaMeasurementCountersCard counters={gaMeasurement} />
        ) : null}
        {gaFixes ? <GaFixesCountersCard counters={gaFixes} /> : null}
        {gaInsights ? <GaInsightsOperatorCard view={gaInsights} /> : null}

        {gscAttention > 0 || gscBackfilling > 0 || gscQuotaWaiting > 0 ? (
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
                <Search className="size-4" />
              </span>
              <CardTitle className="text-base">Search Console data</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile
                label="Sites needing attention"
                value={gscAttention}
                tone="danger"
              />
              <StatTile
                label="History loading"
                value={gscBackfilling}
                tone="neutral"
              />
              <StatTile
                label="Waiting on Google quota"
                value={gscQuotaWaiting}
                tone="waiting"
              />
            </CardContent>
          </Card>
        ) : null}
        {seoCounters ? <SeoOperatorCard counters={seoCounters} /> : null}
        {seoOpportunities ? (
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
                <Lightbulb className="size-4" />
              </span>
              <CardTitle className="text-base">Search opportunities</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatTile
                  label="Findings (14 days)"
                  value={seoOpportunities.findings14d}
                  tone="neutral"
                />
                <StatTile
                  label="Reviewed"
                  value={seoOpportunities.reviewed}
                  tone="neutral"
                />
                <StatTile
                  label="Precision"
                  value={
                    seoOpportunities.precision === null
                      ? "—"
                      : `${Math.round(seoOpportunities.precision * 100)}%`
                  }
                  tone="neutral"
                />
                <StatTile
                  label="Failing sites"
                  value={seoOpportunities.failing}
                  tone="danger"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Counters only. Customer data is never shown here.{" "}
                <Link
                  href="/health/search-opportunities"
                  className="text-foreground underline-offset-2 hover:underline"
                >
                  Open
                </Link>
              </p>
            </CardContent>
          </Card>
        ) : null}
        {seoReports ? <SeoReportCountersCard counters={seoReports} /> : null}
        {seoActionCounters ? (
          <SeoActionCountersCard counters={seoActionCounters} />
        ) : null}
        {seoContentPlan ? (
          <ContentPlanCountersCard counters={seoContentPlan} />
        ) : null}

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <AlertTriangle className="size-4" />
            </span>
            <CardTitle className="text-base">
              Dead letters ({report.deadLetters.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.deadLetters.length === 0 ? (
              <EmptyState
                icon={ShieldCheck}
                title="Dead letter queue is empty"
                hint="No job is waiting past the maximum retry count."
              />
            ) : (
              report.deadLetters.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl p-3 ring-1 ring-foreground/10"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      meta={ERROR_CATEGORY[entry.category]}
                      fallback={entry.category}
                      showIcon
                    />
                    <span className="font-mono text-xs">{entry.reason}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.attempts} attempts · {timeAgo(entry.createdAt)}
                    </span>
                    {entry.autoRecoverable ? (
                      <span className="text-xs text-success">
                        auto recovery queued
                      </span>
                    ) : null}
                  </div>
                  {entry.lastError ? (
                    <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
                      {entry.lastError}
                    </p>
                  ) : null}
                  <div className="mt-2 flex gap-2">
                    <ActionForm
                      action={retryDeadLetterAction}
                      successMessage="Re-queued"
                    >
                      <input
                        type="hidden"
                        name="deadLetterId"
                        value={entry.id}
                      />
                      <SubmitButton size="sm">Retry</SubmitButton>
                    </ActionForm>
                    <ActionForm
                      action={dismissDeadLetterAction}
                      successMessage="Record dismissed"
                    >
                      <input
                        type="hidden"
                        name="deadLetterId"
                        value={entry.id}
                      />
                      <SubmitButton size="sm" variant="outline">
                        Dismiss
                      </SubmitButton>
                    </ActionForm>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
