import Link from "next/link";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { AgencyOverviewFrame } from "@/components/agency-overview/frame";
import { BrandingForm } from "@/components/search-overview/branding-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BulkLinkCard } from "@/components/website-analytics/agency/bulk-link-card";
import { WebsitesOverviewList } from "@/components/website-analytics/agency/websites-overview";
import { reportShareOn } from "@/lib/report-share/flags";
import { gscAgencyOn } from "@/lib/seo/agency/flags";
import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import {
  applyWebsitesFilter,
  attentionRank,
  parseWebsitesFilter,
  summarizeOverview,
  type WebsitesFilter,
} from "@/lib/website-analytics/agency/overview";
import {
  SEARCH_OVERVIEW_HREF,
  WEBSITES_OVERVIEW_HREF,
} from "@/lib/website-analytics/agency/routes";
import { GaFlags } from "@/lib/website-analytics/flags";
import { ReportBrandings } from "@/server/report-share/branding";
import {
  isWorkspaceManager,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import {
  listLinkableProjects,
  listWorkspaceGoogleAccounts,
} from "@/server/website-analytics/agency/bulk-link";
import { loadWebsitesOverview } from "@/server/website-analytics/agency/overview";

// Workspace "Websites" görünümü (GA-F8, GA_AGENCY): müşterilerin bütün GA4
// mülkleri tek listede, toplu Google hesabı bağlama ve istemci raporu markası.
// Yalnız OWNER/ADMIN görür (Meta /ads ve Search /search ile aynı kural); sayfa
// Google'a çağrı yapmaz, yalnız kendi ambarımızı okur.

const FILTER_LABEL: Record<WebsitesFilter, string> = {
  all: "All properties",
  attention: "Needs attention",
  extras: "Extra properties",
  bigquery: "BigQuery",
};

export default async function WebsitesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!gaAgencyEnabled()) notFound();
  const params = await searchParams;
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  if (!(await isWorkspaceManager(userId, workspaceId))) notFound();

  const filter = parseWebsitesFilter(params.filter);
  const now = new Date();
  const sharing = reportShareOn();
  const [overview, accounts, projects, branding, logos] = await Promise.all([
    loadWebsitesOverview(workspaceId, now),
    listWorkspaceGoogleAccounts(workspaceId),
    listLinkableProjects(workspaceId),
    sharing ? ReportBrandings.get(workspaceId) : Promise.resolve(null),
    sharing ? ReportBrandings.logoOptions(workspaceId) : Promise.resolve([]),
  ]);

  const today = now.toISOString().slice(0, 10);
  const summary = summarizeOverview(overview.rows, today);
  const visible = applyWebsitesFilter(overview.rows, filter, today);
  const counts: Record<WebsitesFilter, number> = {
    all: overview.rows.length,
    attention: overview.rows.filter((row) => attentionRank(row, today) > 0)
      .length,
    extras: summary.extras,
    bigquery: overview.rows.filter((row) => row.bigQuery !== "off").length,
  };

  return (
    <AppShell>
      <AgencyOverviewFrame
        title="Websites"
        subtitle="Every client's Google Analytics property in one place."
        summary={[
          { label: "Properties", value: String(summary.properties) },
          { label: "Projects", value: String(summary.projects) },
          { label: "Need attention", value: String(summary.needAttention) },
          { label: "Critical", value: String(summary.critical) },
          { label: "Extra properties", value: String(summary.extras) },
        ]}
        filters={(Object.keys(FILTER_LABEL) as WebsitesFilter[]).map((key) => ({
          key,
          label: FILTER_LABEL[key],
          count: counts[key],
          href: `${WEBSITES_OVERVIEW_HREF}?filter=${key}`,
          active: filter === key,
        }))}
        actions={
          gscAgencyOn() ? (
            <Link
              href={SEARCH_OVERVIEW_HREF}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              <Search className="size-4" />
              Search overview
            </Link>
          ) : null
        }
      >
        <BulkLinkCard accounts={accounts} projects={projects} />

        {branding ? (
          <section id="branding">
            <Card size="sm">
              <CardHeader>
                <CardTitle className="text-base">
                  Client report branding
                </CardTitle>
              </CardHeader>
              <CardContent>
                {/* Sayfa zaten yalnız OWNER/ADMIN'e açık: düzenleme her zaman serbest. */}
                <BrandingForm branding={branding} logos={logos} canEdit />
              </CardContent>
            </Card>
          </section>
        ) : null}

        <WebsitesOverviewList
          rows={visible}
          truncated={overview.truncated}
          linkProjects={GaFlags.websitePage()}
        />
      </AgencyOverviewFrame>
    </AppShell>
  );
}
