import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { MAX_SITES_PER_PROJECT } from "@/lib/seo/agency/flags";
import { ADD_SITE_MESSAGE } from "@/lib/seo/agency/copy";
import type { ProjectSiteView } from "@/lib/seo/agency/types";
import {
  addSecondarySiteAction,
  makePrimarySiteAction,
  removeSecondarySiteAction,
} from "@/server/actions/gsc-sites-actions";

import {
  ADMIN_HINT,
  BODY_CLASS,
  DETAILS_CLASS,
  HINT_CLASS,
  SELECT_CLASS,
  SUMMARY_CLASS,
  formatDay,
  healthLabel,
} from "./form-helpers";
import { HealthDot } from "./site-switcher";

// Search sayfasındaki "Sites" kartı (SC-F9): projeye bağlı Search Console
// siteleri, ikincil site ekleme/kaldırma ve "Make primary". Yönetmeyen
// kullanıcılar yalnız listeyi görür. Kaldırma onayı JS gerektirmeyen bir
// <details> ile alınır.

export type SiteCandidate = {
  siteUrl: string;
  siteLabel: string;
  permissionLevel: string | null;
};

function SiteRow({
  projectId,
  site,
  isManager,
}: {
  projectId: string;
  site: ProjectSiteView;
  isManager: boolean;
}) {
  const secondary = site.role === "SECONDARY";
  return (
    <li
      data-site={site.linkId}
      className="flex flex-wrap items-start justify-between gap-3 rounded-xl p-3 ring-1 ring-foreground/10"
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <HealthDot health={site.health} />
          <p className="truncate text-sm font-medium">{site.siteLabel}</p>
          <Badge variant={secondary ? "outline" : "secondary"}>
            {secondary ? "Secondary" : "Primary"}
          </Badge>
          {site.isMock ? <Badge variant="outline">Sample data</Badge> : null}
        </div>
        <p className={HINT_CLASS}>
          {healthLabel(site.health)}
          {" · "}
          {site.lastFinalDate
            ? `Data through ${formatDay(site.lastFinalDate)}`
            : site.backfillDone
              ? "No data yet"
              : "Loading history"}
        </p>
      </div>
      {secondary && isManager ? (
        <div className="flex flex-wrap items-center gap-2">
          <ActionForm
            action={makePrimarySiteAction}
            successMessage="Primary site changed"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="linkId" value={site.linkId} />
            <SubmitButton size="xs" variant="outline">
              Make primary
            </SubmitButton>
          </ActionForm>
          <details className="relative">
            <summary className="inline-flex h-6 cursor-pointer list-none items-center rounded-lg px-2 text-xs font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
              Remove
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-64 space-y-2 rounded-xl bg-popover p-3 text-xs shadow-md ring-1 ring-foreground/10">
              <p className="text-muted-foreground">
                This stops syncing the site and deletes the numbers stored for
                it. You can add it again later.
              </p>
              <ActionForm
                action={removeSecondarySiteAction}
                successMessage="Site removed"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="linkId" value={site.linkId} />
                <SubmitButton size="xs" variant="destructive">
                  Remove site
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        </div>
      ) : null}
    </li>
  );
}

export function SitesCard({
  projectId,
  sites,
  candidates,
  isManager,
}: {
  projectId: string;
  sites: ProjectSiteView[];
  candidates: SiteCandidate[];
  isManager: boolean;
}) {
  const atLimit = sites.length >= MAX_SITES_PER_PROJECT;
  const hasSecondary = sites.some((site) => site.role === "SECONDARY");
  return (
    <details data-card="agency-sites" className={DETAILS_CLASS}>
      <summary className={SUMMARY_CLASS}>
        <span>Sites</span>
        <span className="text-xs font-normal tabular-nums text-muted-foreground">
          {sites.length} of {MAX_SITES_PER_PROJECT} sites
        </span>
      </summary>
      <div className={BODY_CLASS}>
        {sites.length > 0 ? (
          <ul className="space-y-2">
            {sites.map((site) => (
              <SiteRow
                key={site.linkId}
                projectId={projectId}
                site={site}
                isManager={isManager}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No Search Console site is connected yet.
          </p>
        )}
        {isManager && hasSecondary ? (
          <p className={HINT_CLASS}>
            Making a site primary moves health checks, opportunities, reports
            and alerts to it.
          </p>
        ) : null}
        {isManager ? (
          atLimit ? (
            <p data-state="limit" className="text-sm text-muted-foreground">
              {ADD_SITE_MESSAGE.LIMIT}
            </p>
          ) : candidates.length > 0 ? (
            <ActionForm
              action={addSecondarySiteAction}
              successMessage="Site added"
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="block">Add a site</span>
                <select
                  name="siteUrl"
                  required
                  defaultValue=""
                  className={`${SELECT_CLASS} max-w-full`}
                >
                  <option value="" disabled>
                    Choose a site
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.siteUrl} value={candidate.siteUrl}>
                      {candidate.siteLabel}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton size="sm" variant="outline">
                Add site
              </SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">
              No other verified sites in the connected Google account.
            </p>
          )
        ) : (
          <p className={HINT_CLASS}>{ADMIN_HINT}</p>
        )}
      </div>
    </details>
  );
}
