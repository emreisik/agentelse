import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Plug, RefreshCw } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { GaFlags } from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
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
  buildWebsiteReport,
  type WebsiteLinkInfo,
} from "@/server/website-analytics/report";
import { loadMeasurementHealth } from "@/server/website-analytics/health/read";
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
import { WebsiteInsights } from "@/components/website-analytics/website-insights";
import { WebsiteReportArchive } from "@/components/website-analytics/reports/website-report-archive";

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
  try {
    await requireProjectAccess(userId, projectId);
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
  const result = await buildWebsiteReport(projectId, periodKey);
  // GA-F3 (GA_HEALTH): ölçüm sağlığı paneli ve başlıktaki puan.
  const measurement =
    result.state === "ready" && gaHealthEnabled()
      ? await loadMeasurementHealth(projectId).catch(() => null)
      : null;
  // GA-F4 (GA_INSIGHTS): "What changed" / "Opportunities" listeleri; bayrak kapalıyken okuyucu sorgusuz null döner.
  const insights =
    result.state === "ready"
      ? await loadWebsiteInsights(projectId, {
          userId,
          review: sp.insights === "review",
        }).catch(() => null)
      : null;
  // GA-F5 (GA_REPORTS): "Reports" arşivi; bayrak kapalıyken okuyucu sorgusuz null döner.
  const reports =
    result.state === "ready"
      ? await loadWebsiteReportArchive(projectId).catch(() => null)
      : null;
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
              <WebsitePeriodSelector base={base} value={periodKey} />
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
            </div>
          ) : null}
        </div>

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
            {GaFlags.live() && GaFlags.sync() ? (
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
            {result.report.period.days > 0 ? (
              <FromAgentelseSection
                projectId={projectId}
                range={{
                  from: result.report.period.from,
                  to: result.report.period.to,
                }}
              />
            ) : null}
            {insights ? (
              <WebsiteInsights projectId={projectId} view={insights} />
            ) : null}
            {measurement ? (
              <>
                <MeasurementHealthPanel projectId={projectId} health={measurement} />
                <UtmCoverageCheck projectId={projectId} />
              </>
            ) : null}
            {reports ? (
              <WebsiteReportArchive projectId={projectId} items={reports} />
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
