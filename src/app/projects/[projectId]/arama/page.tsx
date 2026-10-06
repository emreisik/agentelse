import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Plug, RefreshCw, Search } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { GscFlags } from "@/lib/seo/flags";
import { SeoInsightFlags } from "@/lib/seo/insight-flags";
import { DEFAULT_SEARCH_PERIOD, isSearchPeriod } from "@/lib/seo/periods";
import { refreshSearchAnalyticsAction } from "@/server/actions/search-analytics-actions";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  buildSearchReport,
  isSearchQueryFilter,
  type SearchLinkInfo,
} from "@/server/seo/report";
import { AppShell } from "@/components/layout/app-shell";
import { BrandTermsForm } from "@/components/search-analytics/brand-terms-form";
import { SearchHealthSection } from "@/components/search-health/search-health-section";
import { BrandTermSuggestions } from "@/components/search-opportunities/brand-term-suggestions";
import { SearchOpportunitiesSection } from "@/components/search-opportunities/opportunities-section";
import {
  SearchPeriodSelector,
  SearchReportBody,
} from "@/components/search-analytics/search-report-view";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { buttonVariants } from "@/components/ui/button";

// "Search" sayfası (docs/google-search-console-plan.md SC-F2,
// docs/search-analytics.md): Search Console ambarından karşılaştırmalı
// KPI'lar (marka ayrımı hazırsa marka dışı tıklamalar), günlük trend, en çok
// aranan sorgular ve sayfalar. Günler PT; GSC_SEARCH_PAGE kapalıyken sayfa yok.

function dayLabel(day: string | null): string | null {
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
  link: SearchLinkInfo | null;
}) {
  const through = dayLabel(link?.finalThrough ?? null);
  return (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Search
        </h1>
        {link?.isMock ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Sample data
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {link
          ? [
              link.siteLabel,
              through ? `Final data through ${through}` : null,
              "Search Console days (Pacific Time)",
            ]
              .filter(Boolean)
              .join(" · ")
          : `${projectName} — Google Search Console`}
      </p>
    </div>
  );
}

const HEALTH_MESSAGES: Record<string, string> = {
  AUTH: "The Search Console connection needs to be reconnected. The numbers below stop at the last update.",
  NEEDS_PERMISSION:
    "Agentelse needs permission to read Search Console. Reconnect and tick the box.",
  ACCESS_LOST:
    "Your Google account no longer has access to this Search Console property.",
  GONE: "This Search Console property no longer exists.",
  DEGRADED:
    "Updates from Search Console are failing right now. We keep retrying.",
};

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
      {children}
    </p>
  );
}

function HealthNotice({ link }: { link: SearchLinkInfo }) {
  if (link.health === "OK" || link.health === "UNKNOWN") return null;
  return (
    <Notice>
      {HEALTH_MESSAGES[link.health] ??
        "Agentelse can't read this Search Console property right now. Check the connection in Connectors."}
    </Notice>
  );
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!GscFlags.searchPage()) notFound();
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

  const periodKey = isSearchPeriod(sp.period)
    ? sp.period
    : DEFAULT_SEARCH_PERIOD;
  const queryFilter = isSearchQueryFilter(sp.queries) ? sp.queries : "all";
  const issue = typeof sp.issue === "string" ? sp.issue : null;
  // SC-F4 (SEO_INSIGHTS): öncelikli fırsat listesi ve marka terimi önerileri; bayrak kapalıyken sarmalayıcılar hiç çizilmez (HTML bugünküyle aynı), veritabanına gidilmez.
  const opportunity =
    typeof sp.opportunity === "string" ? sp.opportunity : null;
  const insights = SeoInsightFlags.active();
  const base = `/projects/${projectId}/arama`;
  const result = await buildSearchReport(projectId, periodKey, { queryFilter });
  const connectorsHref = `/projects/${projectId}/integrations?integration=google_search_console`;
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
              <SearchPeriodSelector
                base={base}
                value={periodKey}
                queryFilter={queryFilter}
              />
              <ActionForm
                action={refreshSearchAnalyticsAction}
                successMessage="Updated from Search Console"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton
                  variant="ghost"
                  size="icon-xs"
                  title="Fetch the latest days again"
                  aria-label="Fetch the latest days again"
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
            title="Search Console isn't connected"
            hint="Connect Google Search Console and choose your site to see the searches that bring people to your website."
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
              icon={Search}
              title="Getting your data from Search Console"
              hint="The first numbers usually arrive within a few minutes. Up to 16 months of history keeps loading in the background."
              className="py-16"
            />
          </>
        ) : (
          <>
            <HealthNotice link={result.report.link} />
            {result.report.link.domainMatch === false ? (
              <Notice>
                This site doesn&apos;t cover the project&apos;s website. Reports
                describe a different site.
              </Notice>
            ) : null}
            <SearchReportBody report={result.report} base={base} />
            {insights ? (
              <Suspense fallback={null}>
                <SearchOpportunitiesSection
                  projectId={projectId}
                  highlight={opportunity}
                />
              </Suspense>
            ) : null}
            <BrandTermsForm
              projectId={projectId}
              terms={result.report.link.brandTerms}
              status={result.report.link.brandSplit}
              defaultOpen={
                result.report.link.brandSplit === "none" ||
                result.report.link.brandSplit === "error"
              }
              suggestions={
                SeoInsightFlags.userFacing() ? (
                  <Suspense fallback={null}>
                    <BrandTermSuggestions projectId={projectId} />
                  </Suspense>
                ) : undefined
              }
            />
          </>
        )}

        {/* SC-F3 (SEO_HEALTH): indeks ve teknik sağlık bölümü; bayrak kapalıyken bileşen null döner. */}
        <Suspense fallback={null}>
          <SearchHealthSection projectId={projectId} issueId={issue} />
        </Suspense>
      </div>
    </AppShell>
  );
}
