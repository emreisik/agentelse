import Link from "next/link";
import { notFound } from "next/navigation";
import { LayoutGrid } from "lucide-react";

import { gscAgencyOn } from "@/lib/seo/agency/flags";
import {
  applyAgencyFilter,
  parseAgencyFilter,
  type AgencyFilter,
  type SearchAgencyRow,
} from "@/lib/seo/agency/overview";
import { reportShareOn } from "@/lib/report-share/flags";
import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import {
  SEARCH_OVERVIEW_HREF,
  WEBSITES_OVERVIEW_HREF,
} from "@/lib/website-analytics/agency/routes";
import { ReportBrandings } from "@/server/report-share/branding";
import { loadSearchAgencyOverview } from "@/server/seo/agency/overview";
import {
  isWorkspaceManager,
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";
import { AgencyOverviewFrame } from "@/components/agency-overview/frame";
import { AppShell } from "@/components/layout/app-shell";
import { SearchOverviewTable } from "@/components/search-overview/overview-table";
import { BrandingForm } from "@/components/search-overview/branding-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Çalışma alanı "Search" genel bakışı (docs/search-agency.md, GSC_AGENCY):
// bütün müşteri siteleri tek listede. Yalnız workspace OWNER/ADMIN görür;
// üye ve bayrak kapalıyken sayfa yok (404).

const FILTER_LABEL: Record<AgencyFilter, string> = {
  all: "All sites",
  attention: "Needs attention",
  secondary: "Secondary sites",
  bigquery: "BigQuery",
};

const FILTER_ORDER: AgencyFilter[] = [
  "all",
  "attention",
  "secondary",
  "bigquery",
];

const NUMBER = new Intl.NumberFormat("en-US");

// Önceki dönemi bilinen sitelerin toplam değişimi (eksik verili satır
// karşılaştırmayı bozmasın).
function totalChange(rows: readonly SearchAgencyRow[]): string | undefined {
  let clicks = 0;
  let previous = 0;
  for (const row of rows) {
    if (row.clicks === null || row.previousClicks === null) continue;
    clicks += row.clicks;
    previous += row.previousClicks;
  }
  if (previous <= 0) return undefined;
  const pct = ((clicks - previous) / previous) * 100;
  if (Math.abs(pct) < 0.05) return "No change vs previous 28 days";
  return `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}% vs previous 28 days`;
}

export default async function SearchOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!gscAgencyOn()) notFound();
  const params = await searchParams;
  const { userId } = await requireUser();
  const { workspaceId } = await requireWorkspaceMembership(userId);
  if (!(await isWorkspaceManager(userId, workspaceId))) notFound();

  const filter = parseAgencyFilter(
    Array.isArray(params.filter) ? params.filter[0] : params.filter,
  );
  const shareOn = reportShareOn();
  const [overview, branding, logos] = await Promise.all([
    loadSearchAgencyOverview(workspaceId),
    shareOn ? ReportBrandings.get(workspaceId) : null,
    shareOn ? ReportBrandings.logoOptions(workspaceId) : [],
  ]);
  const visible = applyAgencyFilter(overview.rows, filter);
  const { totals } = overview;

  return (
    <AppShell>
      <AgencyOverviewFrame
        title="Search"
        subtitle="Every client site from Google Search Console in one place."
        summary={[
          {
            label: "Sites",
            value: NUMBER.format(totals.sites),
            hint: `${NUMBER.format(totals.projects)} ${totals.projects === 1 ? "project" : "projects"}`,
          },
          {
            label: "Clicks, last 28 days",
            value: NUMBER.format(totals.clicks),
            hint: totalChange(overview.rows),
          },
          {
            label: "Need attention",
            value: NUMBER.format(totals.needAttention),
          },
          {
            label: "Critical issues",
            value: NUMBER.format(totals.critical),
          },
        ]}
        actions={
          gaAgencyEnabled() ? (
            <Link
              href={WEBSITES_OVERVIEW_HREF}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              <LayoutGrid className="size-4" />
              Websites
            </Link>
          ) : null
        }
        filters={FILTER_ORDER.map((key) => ({
          key,
          label: FILTER_LABEL[key],
          count: applyAgencyFilter(overview.rows, key).length,
          href:
            key === "all"
              ? SEARCH_OVERVIEW_HREF
              : `${SEARCH_OVERVIEW_HREF}?filter=${key}`,
          active: key === filter,
        }))}
      >
        <SearchOverviewTable rows={visible} />
        {overview.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {overview.rows.length} sites.
          </p>
        ) : null}

        {branding ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-base">Client reports branding</CardTitle>
              <p className="text-sm text-muted-foreground">
                Used on client report views and share links for every project in
                this workspace.
              </p>
            </CardHeader>
            <CardContent>
              <BrandingForm branding={branding} logos={logos} canEdit />
            </CardContent>
          </Card>
        ) : null}
      </AgencyOverviewFrame>
    </AppShell>
  );
}
