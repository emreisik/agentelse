import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Plug, RefreshCw } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { GaFlags } from "@/lib/website-analytics/flags";
import { WEBSITES_OVERVIEW_HREF } from "@/lib/website-analytics/agency/routes";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
import { gaFixesEnabledFor } from "@/lib/website-analytics/fixes/flags";
import {
  DEFAULT_WEBSITE_PERIOD,
  isWebsitePeriod,
} from "@/lib/website-analytics/periods";
import { refreshWebsiteAnalyticsAction } from "@/server/actions/website-analytics-actions";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  loadSitePropertyScope,
  runInSiteScope,
} from "@/server/website-analytics/agency/site-scope";
import {
  buildWebsiteReport,
  type WebsiteLinkInfo,
} from "@/server/website-analytics/report";
import { loadMeasurementHealth } from "@/server/website-analytics/health/read";
import { loadGaFixesView } from "@/server/website-analytics/fixes/read";
import { loadWebsiteInsights } from "@/server/website-analytics/analysis/read";
import { loadWebsiteReportArchive } from "@/server/website-analytics/reports/read";
import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";
import {
  WebsitePeriodSelector,
  WebsiteReportBody,
} from "@/components/website-analytics/website-report-view";
import { FromAgentelseSection } from "@/components/website-analytics/from-agentelse-section";
import { UtmCoverageCheck } from "@/components/website-analytics/utm-coverage-check";
import { WebsiteLiveStrip } from "@/components/website-analytics/website-live-strip";
import { MeasurementHealthPanel } from "@/components/website-analytics/measurement-health-panel";
import { MeasurementScoreChip } from "@/components/website-analytics/measurement-score";
import { GaFixesPanel } from "@/components/website-analytics/ga-fixes-panel";
import { WebsiteInsights } from "@/components/website-analytics/website-insights";
import { WebsiteReportArchive } from "@/components/website-analytics/reports/website-report-archive";
import { PropertySwitcher } from "@/components/website-analytics/agency/property-switcher";
import { ClientReportSection } from "@/components/website-analytics/agency/client-report-section";
import { BigQueryCard } from "@/components/website-analytics/bigquery/bigquery-card";
import { FunnelCard } from "@/components/website-analytics/funnel/funnel-card";

// "Website" sayfası (docs/google-analytics-plan.md §3.9, GA-F2 v1): Google
// Analytics ambarından karşılaştırmalı KPI'lar, günlük trend, kanallar,
// key event'ler ve açılış sayfaları. GA_WEBSITE_PAGE kapalıyken sayfa yok.

function dataThroughLabel(day: string | null): string | null {
  if (!day) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

function Header({
  projectName,
  link,
}: {
  projectName: string;
  link: WebsiteLinkInfo | null;
}) {
  const through = dataThroughLabel(link?.dataThrough ?? null);
  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        Website
      </h1>
      <p className="text-sm text-muted-foreground">
        {link
          ? [
              link.propertyName ?? `GA4 property ${link.propertyId}`,
              through ? `Data through ${through}` : null,
              `Property time: ${link.timeZone}`,
            ]
              .filter(Boolean)
              .join(" · ")
          : `${projectName} — Google Analytics`}
      </p>
    </div>
  );
}

function HealthNotice({ link }: { link: WebsiteLinkInfo }) {
  if (link.health === "OK" || link.health === "UNKNOWN") return null;
  const message =
    link.health === "AUTH"
      ? "The Google Analytics connection needs to be reconnected. The numbers below stop at the last update."
      : link.health === "DEGRADED"
        ? "Updates from Google Analytics are failing right now. We keep retrying."
        : "Agentelse can't read this Google Analytics property right now. Check the connection in Connectors.";
  return (
    <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
      {message}
    </p>
  );
}

export default async function WebsitePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!GaFlags.websitePage()) notFound();
  const { projectId } = await params;
  const sp = await searchParams;

  const { userId } = await requireUser();
  let workspaceId: string;
  try {
    workspaceId = (await requireProjectAccess(userId, projectId)).workspaceId;
  } catch {
    notFound();
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) notFound();

  const periodKey = isWebsitePeriod(sp.period)
    ? sp.period
    : DEFAULT_WEBSITE_PERIOD;
  const base = `/projects/${projectId}/site`;
  // GA-F8 (GA_AGENCY): ?property= ile seçilen mülk. Bayrak kapalıyken sorgu yok
  // ve kapsam "enabled: false" döner; sayfa bugünkü gibi çalışır.
  const agency = await loadSitePropertyScope({
    projectId,
    userId,
    workspaceId,
    requestedPropertyId: typeof sp.property === "string" ? sp.property : null,
    period: isWebsitePeriod(sp.period) ? sp.period : null,
  });
  // Mülke bağlı bütün okumalar tek kapsamda: ek mülkte seçili bağ üzerinden,
  // ana mülkte bugünkü sorgularla. Hedef, nabız, uyarı, plan, fikir ya da
  // React cache() okuyucuları burada ÇAĞRILMAZ.
  const { result, measurement, fixes, insights, reports } = await runInSiteScope(
    agency,
    async () => {
      const report = await buildWebsiteReport(projectId, periodKey);
      // GA-F3 (GA_HEALTH): ölçüm sağlığı paneli ve başlıktaki puan.
      const health =
        report.state === "ready" && gaHealthEnabled()
          ? await loadMeasurementHealth(projectId).catch(() => null)
          : null;
      // GA-F7 (GA_FIXES): "Fix it for me" teklifleri ve "Changes Agentelse made" bölümü; bayrak kapalıyken sorgu yok. Ek mülkte düzeltme yok.
      const fixView =
        report.state === "ready" &&
        !agency.isSecondary &&
        gaFixesEnabledFor(projectId)
          ? await loadGaFixesView({
              projectId,
              userId,
              checks:
                health?.checks.map((c) => ({
                  key: c.key,
                  status: c.status,
                  evidence: c.evidence,
                })) ?? [],
            }).catch(() => null)
          : null;
      // GA-F4 (GA_INSIGHTS): "What changed" / "Opportunities" listeleri; bayrak kapalıyken okuyucu sorgusuz null döner.
      const insightView =
        report.state === "ready"
          ? await loadWebsiteInsights(projectId, {
              userId,
              review: sp.insights === "review",
            }).catch(() => null)
          : null;
      // GA-F5 (GA_REPORTS): "Reports" arşivi; bayrak kapalıyken okuyucu sorgusuz null döner.
      const archive =
        report.state === "ready"
          ? await loadWebsiteReportArchive(projectId, undefined, {
              linkId: agency.archiveLinkId,
            }).catch(() => null)
          : null;
      return {
        result: report,
        measurement: health,
        fixes: fixView,
        insights: insightView,
        reports: archive,
      };
    },
  );
  const connectorsHref = `/projects/${projectId}/integrations?integration=google_analytics`;
  const headerLink =
    result.state === "waiting"
      ? result.link
      : result.state === "ready"
        ? result.report.link
        : null;

  return (
    <AppShell projectId={projectId}>
      <div className="space-y-6 p-6 pb-16">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Header projectName={project.name} link={headerLink} />
          {result.state === "ready" ? (
            <div className="flex items-center gap-2">
              {measurement ? (
                <MeasurementScoreChip
                  summary={measurement.summary}
                  href="#measurement-health"
                />
              ) : null}
              <WebsitePeriodSelector
                base={base}
                value={periodKey}
                query={
                  agency.selected && !agency.selected.isPrimary
                    ? { property: agency.selected.propertyId }
                    : undefined
                }
              />
              {agency.isSecondary ? null : (
                <ActionForm
                  action={refreshWebsiteAnalyticsAction}
                  successMessage="Updated from Google Analytics"
                >
                  <input type="hidden" name="projectId" value={projectId} />
                  <SubmitButton
                    variant="ghost"
                    size="icon-xs"
                    title="Fetch the last 7 days again"
                  >
                    <RefreshCw className="size-3.5" />
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          ) : null}
        </div>

        {agency.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <PropertySwitcher
              projectId={projectId}
              chips={agency.chips}
              canManage={agency.canManage}
              addable={agency.addable}
              canAdd={agency.canAdd}
            />
            {agency.canManage ? (
              <Link
                href={WEBSITES_OVERVIEW_HREF}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                All websites
              </Link>
            ) : null}
          </div>
        ) : null}

        {result.state === "not_connected" ? (
          <EmptyState
            icon={Plug}
            title="Google Analytics isn't connected"
            hint="Connect Google Analytics and choose a property to see your website's visits, channels and key events here."
            className="py-16"
          >
            <Link
              href={connectorsHref}
              className={cn(buttonVariants({ size: "xs" }))}
            >
              Open Connectors
            </Link>
          </EmptyState>
        ) : result.state === "waiting" ? (
          <>
            <HealthNotice link={result.link} />
            <EmptyState
              icon={Globe}
              title="Getting your data from Google Analytics"
              hint="The first numbers usually arrive within a few minutes. Older history keeps loading in the background."
              className="py-16"
            />
          </>
        ) : (
          <>
            <HealthNotice link={result.report.link} />
            {!agency.isSecondary && GaFlags.live() && GaFlags.sync() ? (
              <WebsiteLiveStrip projectId={projectId} />
            ) : null}
            {result.report.period.days === 0 ? (
              <EmptyState
                icon={Globe}
                title="No full days yet this month"
                hint="Today is still running. Pick another period to compare."
                className="py-16"
              />
            ) : (
              <WebsiteReportBody report={result.report} />
            )}
            {!agency.isSecondary && result.report.period.days > 0 ? (
              <FromAgentelseSection
                projectId={projectId}
                range={{
                  from: result.report.period.from,
                  to: result.report.period.to,
                }}
              />
            ) : null}
            {insights ? (
              <WebsiteInsights
                projectId={projectId}
                view={insights}
                readOnly={agency.isSecondary}
              />
            ) : null}
            {measurement ? (
              <>
                <MeasurementHealthPanel
                  projectId={projectId}
                  health={measurement}
                  fixOffers={fixes?.offers ?? []}
                  canManageFixes={fixes?.canManage ?? false}
                  readOnly={agency.isSecondary}
                />
                {agency.isSecondary ? null : (
                  <UtmCoverageCheck projectId={projectId} />
                )}
              </>
            ) : null}
            {fixes ? <GaFixesPanel projectId={projectId} view={fixes} /> : null}
            {reports ? (
              <WebsiteReportArchive projectId={projectId} items={reports} />
            ) : null}
            {agency.enabled && agency.linkId ? (
              <>
                {reports ? (
                  <ClientReportSection
                    projectId={projectId}
                    linkId={agency.linkId}
                    items={reports}
                    canManage={agency.canManage}
                  />
                ) : null}
                <BigQueryCard
                  projectId={projectId}
                  linkId={agency.linkId}
                  canManage={agency.canManage}
                  readOnly={false}
                />
                <FunnelCard
                  projectId={projectId}
                  linkId={agency.linkId}
                  readOnly={false}
                />
              </>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
