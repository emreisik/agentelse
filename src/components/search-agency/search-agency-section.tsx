import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { EMPTY_PAGE_GROUP_RULES } from "@/lib/seo/agency/page-groups";
import { SECONDARY_NOTE } from "@/lib/seo/agency/copy";
import {
  gscAgencyActiveFor,
  gscBigQueryActiveFor,
} from "@/lib/seo/agency/flags";
import type { ProjectSiteView, ViewedSite } from "@/lib/seo/agency/types";
import { addWeeks, weekStartOf } from "@/lib/seo/dates";
import { reportShareOn } from "@/lib/report-share/flags";
import { seoReportsActiveFor } from "@/lib/seo/reports/flags";
import { makePrimarySiteAction } from "@/server/actions/gsc-sites-actions";
import { ReportBrandings } from "@/server/report-share/branding";
import { ReportShares } from "@/server/report-share/store";
import { requireProjectAccess } from "@/server/security/tenant-context";
import {
  GscPageGroups,
  type PageGroupState,
} from "@/server/seo/agency/page-groups";
import { GscSites } from "@/server/seo/agency/sites";
import {
  loadBqSourceView,
  type BqSourceView,
} from "@/server/seo/agency/bq/source";
import { GscSplitTests } from "@/server/seo/agency/split/store";
import { loadApplyReady } from "@/server/seo/apply/offers";
import { listSeoReports } from "@/server/seo/reports/store";
import { readPeriodCoverage } from "@/server/seo/store";

import { BigQueryCard } from "./bigquery-card";
import { ClientReportsCard } from "./client-reports-card";
import { HINT_CLASS } from "./form-helpers";
import { PageGroupsCard } from "./page-groups-card";
import { SitesCard } from "./sites-card";
import { SplitTestsCard } from "./split-tests-card";

// Search sayfasının "Agency tools" bölümü (SC-F9, docs/search-agency.md).
// Bayrak kapalıyken HİÇBİR okuma yapmadan null döner (sayfa işaretlemesi
// bugünküyle aynı kalır). Kartlar katlanabilir <details>; yalnız çizilecek
// veri okunur ve her okuma kendi hatasını yutar, böylece bir kart sayfayı
// düşüremez. İkincil site görünümünde motorlara bağlı bölümler (müşteri
// raporları) gizlenir; ambar okuyucularına bağlı kartlar görüntülenen siteyi
// kullanır.

const EMPTY_PAGE_GROUP_STATE: PageGroupState = {
  rules: EMPTY_PAGE_GROUP_RULES,
  version: 0,
  appliedVersion: 0,
  applying: false,
  appliedWeek: null,
};

const SECTION_TITLE_ID = "agency-title";
const TRUNCATION_LOOKBACK_WEEKS = 8;

// BigQuery kartı yalnız kaynak yokken, kullanıcı mülk sahibiyken ve son 8
// haftanın haftalık sorgu tabloları kesilmişken açık gelir.
async function bigQueryDefaultOpen(
  view: BqSourceView,
  site: ProjectSiteView,
): Promise<boolean> {
  if (view.status !== "OFF" || !view.configured || !site.isOwner) return false;
  if (!site.lastFinalDate) return false;
  const last = weekStartOf(site.lastFinalDate);
  const coverage = await readPeriodCoverage(
    site.linkId,
    "WEEK",
    "query",
    addWeeks(last, -TRUNCATION_LOOKBACK_WEEKS),
    last,
  ).catch(() => null);
  return coverage?.truncated === true;
}

export async function SearchAgencySection({
  projectId,
  viewed,
  isManager,
  userId,
}: {
  projectId: string;
  viewed: ViewedSite;
  isManager: boolean;
  userId: string;
}): Promise<React.JSX.Element | null> {
  // Bayrak kapalıyken await ve veritabanı okuması yok.
  if (!gscAgencyActiveFor(projectId)) return null;

  const site = viewed.viewed;
  const bigQueryOn = gscBigQueryActiveFor(projectId);
  const reportsOn =
    viewed.isPrimaryView && seoReportsActiveFor(projectId) && reportShareOn();

  const [candidates, pageGroups, bigQuery, splits, clientReports] =
    await Promise.all([
      isManager
        ? GscSites.candidates(projectId).catch(() => [])
        : Promise.resolve([]),
      site
        ? Promise.all([
            GscPageGroups.read(projectId, site.siteUrl).catch(
              () => EMPTY_PAGE_GROUP_STATE,
            ),
            GscPageGroups.listGroups(site.linkId).catch(() => []),
          ])
        : Promise.resolve(null),
      site && bigQueryOn
        ? loadBqSourceView(projectId, site.linkId)
            .then(async (view) =>
              view
                ? { view, open: await bigQueryDefaultOpen(view, site) }
                : null,
            )
            .catch(() => null)
        : Promise.resolve(null),
      site
        ? GscSplitTests.list(projectId, site.linkId)
            .then(async (tests) => ({
              tests,
              applyReady:
                isManager &&
                tests.some(
                  (test) => test.status === "DRAFT" && test.canApplyViaCms,
                )
                  ? await loadApplyReady(projectId).catch(() => false)
                  : false,
            }))
            .catch(() => ({ tests: [], applyReady: false }))
        : Promise.resolve(null),
      reportsOn
        ? (async () => {
            const [access, reports] = await Promise.all([
              requireProjectAccess(userId, projectId),
              listSeoReports(projectId, {
                kinds: ["WEEKLY", "MONTHLY"],
                limit: 10,
              }),
            ]);
            const [shares, branding] = await Promise.all([
              isManager
                ? ReportShares.listForProject(
                    projectId,
                    "SEARCH",
                    reports.map((report) => report.id),
                  )
                : Promise.resolve({}),
              ReportBrandings.get(access.workspaceId),
            ]);
            return { reports, shares, branding };
          })().catch(() => null)
        : Promise.resolve(null),
    ]);

  return (
    <section
      id="agency"
      aria-labelledby={SECTION_TITLE_ID}
      className="scroll-mt-20 space-y-4 border-t border-foreground/10 pt-6"
    >
      <div className="space-y-1">
        <h2 id={SECTION_TITLE_ID} className="text-base font-semibold">
          Agency tools
        </h2>
        <p className="text-sm text-muted-foreground">
          Track several sites, group pages your way, test changes and share
          branded reports.
        </p>
      </div>

      {site && !viewed.isPrimaryView ? (
        <div
          data-note="secondary-view"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted p-3"
        >
          <p className="min-w-0 flex-1 text-sm">{SECONDARY_NOTE}</p>
          {isManager ? (
            <ActionForm
              action={makePrimarySiteAction}
              successMessage="Primary site changed"
              className="space-y-1"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="linkId" value={site.linkId} />
              <SubmitButton size="sm" variant="outline">
                Make primary
              </SubmitButton>
              <p className={HINT_CLASS}>
                Health checks, opportunities, reports and alerts move to the new
                primary.
              </p>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <SitesCard
          projectId={projectId}
          sites={viewed.sites}
          candidates={candidates}
          isManager={isManager}
        />
        {site && bigQuery ? (
          <BigQueryCard
            projectId={projectId}
            linkId={site.linkId}
            view={bigQuery.view}
            isManager={isManager}
            defaultOpen={bigQuery.open}
          />
        ) : null}
        {site && pageGroups ? (
          <PageGroupsCard
            projectId={projectId}
            linkId={site.linkId}
            state={pageGroups[0]}
            groups={pageGroups[1]}
            isManager={isManager}
          />
        ) : null}
        {site && splits ? (
          <SplitTestsCard
            projectId={projectId}
            linkId={site.linkId}
            tests={splits.tests}
            groups={pageGroups?.[1] ?? []}
            applyReady={splits.applyReady}
          />
        ) : null}
        {clientReports ? (
          <ClientReportsCard
            projectId={projectId}
            reports={clientReports.reports}
            shares={clientReports.shares}
            branding={clientReports.branding}
            isManager={isManager}
          />
        ) : null}
      </div>
    </section>
  );
}
