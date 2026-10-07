import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { CrawlSettingsForm } from "@/components/search-health/crawl-settings-form";
import { IssueList, SeverityChip } from "@/components/search-health/issue-list";
import { RedirectMapCard } from "@/components/search-health/redirect-map-card";
import { VerifySiteCard } from "@/components/search-health/verify-site-card";
import { timeAgo } from "@/lib/dates";
import { formatCount } from "@/lib/module-flows/analytics/format";
import { cwvRating, type CwvMetricKey, type CwvRating } from "@/lib/seo/cwv";
import { cn } from "@/lib/utils";
import {
  deleteSiteAuditDataAction,
  recrawlSiteAction,
  requestInspectionAction,
} from "@/server/actions/search-health-actions";
import type { HealthFixState } from "@/server/seo/actions/fix-this";
import type { CwvView } from "@/server/seo/health/cwv";
import type { SearchHealthPanel } from "@/server/seo/health/panel";

// Search sayfasındaki "Index & technical health" bölümünün gövdesi (SC-F3,
// docs/search-health.md): puan, kapsam, uyarılar ve rehberleri, indeks
// kapsamı, kilit sayfalar, sitemap/robots, teknik denetim, CWV, 301 haritası
// ve Google güncellemeleri. Yalnız props'tan çizilir (sunucu bileşeni); tek
// duyarlı düzen, mobil önce.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";
const TITLE_ID = "search-health-title";

type Panel = SearchHealthPanel;
type KeyPage = Panel["keyPages"][number];

function dateLabel(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function scoreTone(value: number | null): string {
  if (value === null) return "bg-muted text-muted-foreground";
  if (value >= 80)
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  if (value >= 50) return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "bg-rose-500/10 text-rose-700 dark:text-rose-400";
}

function Header({ panel }: { panel: Panel }) {
  const { score } = panel;
  const basedOn = score.parts
    .filter((part) => part.available)
    .map((part) => part.label);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={TITLE_ID} className="font-heading text-base font-semibold">
          Index &amp; technical health
        </h2>
        <span
          data-score={score.value ?? ""}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
            scoreTone(score.value),
          )}
        >
          Search health {score.value === null ? "—" : `${score.value}/100`}
        </span>
        {panel.isMock ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Sample data
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {basedOn.length > 0 ? (
          <span>Based on: {basedOn.join(", ")}</span>
        ) : null}
        {score.cappedByCritical ? (
          <span>Capped while a critical issue is open</span>
        ) : null}
        {score.computedAt ? (
          <span>Updated {timeAgo(score.computedAt)}</span>
        ) : null}
      </div>
      {!panel.allowed ? (
        <p className="text-xs text-muted-foreground">
          Search health is not enabled for this project yet.
        </p>
      ) : null}
    </div>
  );
}

function ScopeCard({ panel }: { panel: Panel }) {
  const { scope } = panel;
  if (scope.state === "needs_verification") {
    return (
      <div className={CARD}>
        <VerifySiteCard projectId={panel.projectId} verify={scope.verify} />
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {scope.state === "no_domain"
        ? "Add your website address to this project to run the technical audit."
        : scope.state === "gsc"
          ? `Audit scope: ${scope.label ?? "—"} (from Search Console)`
          : `Audit scope: ${scope.label ?? "—"} (verified)`}
    </p>
  );
}

function CoverageCard({ panel }: { panel: Panel }) {
  const { coverage, inspections } = panel;
  if (!coverage && !inspections) return null;
  return (
    <div className={CARD} data-card="coverage">
      <p className="text-sm font-medium">Indexing</p>
      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
        {coverage?.state === "ready" ? (
          <>
            <p className="text-sm text-foreground">
              {coverage.text} of your sitemap pages are indexed
            </p>
            <p>
              Based on {formatCount(coverage.sampled)} pages checked with
              Google&rsquo;s URL Inspection
            </p>
          </>
        ) : coverage?.state === "collecting" ? (
          <p>
            Checking a sample of your sitemap pages (
            {formatCount(coverage.sampled)} so far).
          </p>
        ) : coverage?.state === "needs_crawl" ? (
          <p>Turn on the site audit to estimate coverage.</p>
        ) : null}
        {inspections ? (
          <>
            <p>
              URL inspections today: {formatCount(inspections.used)} of{" "}
              {formatCount(inspections.budget)}
            </p>
            {inspections.used >= inspections.budget ? (
              <p>Daily URL inspection limit reached. More checks tomorrow.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// Kilit sayfanın durumu: robots engeli ve getirme hatası koddan önce gelir.
export function keyPageStatus(page: KeyPage): string {
  if (page.robotsBlocked || page.fetchError === "ROBOTS_HOP") {
    return "Blocked by robots.txt";
  }
  switch (page.fetchError) {
    case "TIMEOUT":
    case "NETWORK":
      return "Didn't respond";
    case "LOOP":
    case "TOO_MANY_REDIRECTS":
      return "Redirect loop";
    case "LEFT_SCOPE":
      return "Redirects to another site";
    case "UNSAFE":
      return "Couldn't check";
    default:
      break;
  }
  if (page.status === null) return "Not checked yet";
  return String(page.status);
}

function indexableLabel(page: KeyPage): string {
  if (page.indexable === null) return "—";
  if (page.indexable) return "Yes";
  return page.noindex ? "No (noindex)" : "No";
}

function KeyPagesCard({ panel }: { panel: Panel }) {
  if (panel.keyPages.length === 0) return null;
  const inspect = panel.keyPages.some((page) => page.canInspect);
  return (
    <div className={CARD} data-card="key-pages">
      <p className="text-sm font-medium">Key pages</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Page</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 pr-3 font-medium">Indexable</th>
              <th className="py-1.5 pr-3 font-medium">Google</th>
              <th className="py-1.5 pr-3 font-medium">
                Last crawled by Google
              </th>
              {inspect ? (
                <th className="py-1.5 font-medium">
                  <span className="sr-only">Inspect</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-foreground/10">
            {panel.keyPages.map((page) => (
              <tr key={page.url} data-path={page.path}>
                <td className="max-w-[16rem] py-1.5 pr-3 break-all">
                  {page.isHomepage ? "Homepage" : page.path}
                </td>
                <td className="py-1.5 pr-3">{keyPageStatus(page)}</td>
                <td className="py-1.5 pr-3">{indexableLabel(page)}</td>
                <td className="py-1.5 pr-3">{page.googleLabel}</td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {page.googleLastCrawl ? timeAgo(page.googleLastCrawl) : "—"}
                </td>
                {inspect ? (
                  <td className="py-1.5">
                    {page.canInspect ? (
                      <ActionForm
                        action={requestInspectionAction}
                        successMessage="Queued. Google checks it in a few minutes."
                      >
                        <input
                          type="hidden"
                          name="projectId"
                          value={panel.projectId}
                        />
                        <input type="hidden" name="url" value={page.url} />
                        <SubmitButton variant="ghost" size="xs">
                          Inspect
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SITEMAP_SOURCE: Record<string, string> = {
  ROBOTS: "From robots.txt",
  GSC: "From Search Console",
  DEFAULT: "Default address",
  INDEX: "From a sitemap index",
};

function robotsLine(verdict: string | null): string | null {
  if (verdict === "OK") return "robots.txt found";
  if (verdict === "MISSING") return "No robots.txt (everything is allowed)";
  if (verdict === "SERVER_ERROR" || verdict === "UNREACHABLE") {
    return "robots.txt is failing";
  }
  return null;
}

function sitemapPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function SitemapsRobotsCard({ panel }: { panel: Panel }) {
  const { sitemaps, robots } = panel;
  if (sitemaps.length === 0 && !robots) return null;
  const line = robots ? robotsLine(robots.verdict) : null;
  return (
    <div className={cn(CARD, "space-y-3")} data-card="sitemaps-robots">
      <p className="text-sm font-medium">Sitemaps &amp; robots.txt</p>
      {sitemaps.length > 0 ? (
        <ul className="space-y-1.5 text-xs">
          {sitemaps.map((sitemap) => (
            <li key={sitemap.url} className="space-y-0.5">
              <p className="font-medium break-all">
                {sitemapPath(sitemap.url)}
              </p>
              <p className="text-muted-foreground">
                {[
                  SITEMAP_SOURCE[sitemap.source] ?? sitemap.source,
                  sitemap.status !== null ? `Status ${sitemap.status}` : null,
                  sitemap.urls !== null
                    ? `${formatCount(sitemap.urls)} pages`
                    : null,
                  sitemap.googleErrors !== null
                    ? `Google: ${sitemap.googleErrors} errors, ${sitemap.googleWarnings ?? 0} warnings`
                    : null,
                  sitemap.googleLastDownloaded
                    ? `Read by Google ${timeAgo(sitemap.googleLastDownloaded)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No sitemaps found yet.</p>
      )}
      {robots ? (
        <div className="space-y-2 border-t border-foreground/10 pt-3 text-xs">
          <p>
            {line ?? "robots.txt not checked yet"}
            {robots.changedAt ? (
              <span className="text-muted-foreground">
                {" "}
                · Changed {dateLabel(robots.changedAt)}
              </span>
            ) : null}
          </p>
          {robots.changedAt && robots.diff ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground select-none">
                See changes
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-2.5 text-[11px] leading-relaxed">
                {[
                  ...robots.diff.added.map((entry) => `+ ${entry}`),
                  ...robots.diff.removed.map((entry) => `- ${entry}`),
                ].join("\n") || "No rule changes"}
              </pre>
            </details>
          ) : null}
          {robots.aiAccess.length > 0 ? (
            <div className="space-y-1.5">
              <div className="overflow-x-auto">
                <table
                  className="w-full min-w-[420px] text-left text-xs"
                  data-table="ai-crawlers"
                >
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">AI crawler</th>
                      <th className="py-1 pr-3 font-medium">Company</th>
                      <th className="py-1 pr-3 font-medium">Used for</th>
                      <th className="py-1 font-medium">Access</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-foreground/10">
                    {robots.aiAccess.map((crawler) => (
                      <tr key={crawler.token}>
                        <td className="py-1 pr-3">{crawler.token}</td>
                        <td className="py-1 pr-3">{crawler.owner}</td>
                        <td className="py-1 pr-3">
                          {crawler.purpose === "search"
                            ? "Answers and search"
                            : "AI training"}
                        </td>
                        <td className="py-1">
                          {crawler.allowed ? "Allowed" : "Blocked"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted-foreground">
                Your choice: blocking AI crawlers keeps your pages out of their
                answers.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AuditCard({ panel }: { panel: Panel }) {
  const { crawl } = panel;
  if (!crawl) return null;
  const verifiedScope =
    panel.scope.state === "gsc" || panel.scope.state === "verified";
  return (
    <div className={cn(CARD, "space-y-3")} data-card="audit">
      <div className="space-y-1">
        <p className="text-sm font-medium">Technical audit</p>
        <p className="text-xs text-muted-foreground">
          {!crawl.enabled || (!crawl.available && verifiedScope)
            ? "The site audit is off."
            : !crawl.available
              ? "The site audit starts once your website is verified."
              : crawl.lastFullAt
                ? `Last full check ${dateLabel(crawl.lastFullAt)} · ${formatCount(crawl.pages)} pages`
                : "The first full check hasn't finished yet."}
          {crawl.running ? " · Running…" : ""}
        </p>
      </div>
      {crawl.blocked ? (
        <p className="rounded-lg bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          Our site audit is being blocked by your server or firewall. Allow
          AgentelseSiteAudit (see agentelse.com/bot), then check again.
        </p>
      ) : null}
      {crawl.groups.length > 0 ? (
        <ul className="divide-y divide-foreground/10 text-xs">
          {crawl.groups.map((group) => (
            <li
              key={group.code}
              className="space-y-1 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex items-start gap-2">
                <SeverityChip severity={group.severity} />
                <p className="font-medium">{group.title}</p>
                <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                  {formatCount(group.count)}{" "}
                  {group.count === 1 ? "page" : "pages"}
                </span>
              </div>
              {group.samples.length > 0 ? (
                <p className="break-all text-muted-foreground">
                  {group.samples.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : crawl.lastFullAt ? (
        <p className="text-xs">No technical issues in the last check.</p>
      ) : null}
      {panel.allowed && (panel.canManage || crawl.canRecrawl) ? (
        <div className="space-y-3 border-t border-foreground/10 pt-3">
          {panel.canManage ? (
            <CrawlSettingsForm
              projectId={panel.projectId}
              enabled={crawl.enabled}
              pageLimit={crawl.pageLimit}
            />
          ) : null}
          <div className="flex flex-wrap items-start gap-2">
            {crawl.canRecrawl ? (
              <ActionForm
                action={recrawlSiteAction}
                successMessage="The audit starts in a minute"
              >
                <input type="hidden" name="projectId" value={panel.projectId} />
                <SubmitButton variant="outline" size="xs">
                  Check again now
                </SubmitButton>
              </ActionForm>
            ) : null}
            {panel.canManage ? (
              <details className="text-xs">
                <summary className="cursor-pointer py-1 text-muted-foreground select-none">
                  Delete audit data
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-muted-foreground">
                    Your verification stays; crawled pages and checks are
                    deleted.
                  </p>
                  <ActionForm
                    action={deleteSiteAuditDataAction}
                    successMessage="Audit data deleted"
                  >
                    <input
                      type="hidden"
                      name="projectId"
                      value={panel.projectId}
                    />
                    <SubmitButton variant="destructive" size="xs">
                      Delete audit data
                    </SubmitButton>
                  </ActionForm>
                </div>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const RATING_LABEL: Record<CwvRating, string> = {
  good: "Good",
  "needs-improvement": "Needs improvement",
  poor: "Poor",
};

function metricText(metric: CwvMetricKey, value: number | null): string {
  if (value === null) return "—";
  const number =
    metric === "lcp"
      ? `${(value / 1000).toFixed(1)} s`
      : metric === "inp"
        ? `${Math.round(value)} ms`
        : value.toFixed(2);
  const rating = cwvRating(metric, value);
  return rating ? `${number} (${RATING_LABEL[rating]})` : number;
}

const CWV_METRICS: { key: CwvMetricKey; label: string }[] = [
  { key: "lcp", label: "LCP" },
  { key: "inp", label: "INP" },
  { key: "cls", label: "CLS" },
];

function CwvRow({ label, view }: { label: string; view: CwvView | null }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium">
        {label}
        {view?.overall ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {RATING_LABEL[view.overall]}
          </span>
        ) : null}
      </p>
      {view ? (
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {CWV_METRICS.map((metric) => (
            <span key={metric.key} data-metric={metric.key}>
              {metric.label} {metricText(metric.key, view.p75[metric.key])}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Not enough Chrome users for field data yet.
        </p>
      )}
    </div>
  );
}

function CwvCard({ panel }: { panel: Panel }) {
  const { cwv } = panel;
  if (!cwv) return null;
  const period = cwv.phone?.collectionPeriod ?? cwv.desktop?.collectionPeriod;
  return (
    <div className={cn(CARD, "space-y-2")} data-card="cwv">
      <p className="text-sm font-medium">Core Web Vitals</p>
      <CwvRow label="Phone" view={cwv.phone} />
      <CwvRow label="Desktop" view={cwv.desktop} />
      <p className="text-[11px] text-muted-foreground">
        {period
          ? `Field data from real Chrome users, last 28 days (${period}).`
          : "Not enough Chrome users for field data yet."}
      </p>
    </div>
  );
}

function UpdatesCard({ panel }: { panel: Panel }) {
  if (panel.updates.length === 0) return null;
  return (
    <div className={CARD} data-card="updates">
      <p className="text-sm font-medium">Google updates</p>
      <ul className="mt-2 space-y-1 text-xs">
        {panel.updates.map((update) => (
          <li key={`${update.name}-${update.startedAt.toISOString()}`}>
            {update.url ? (
              <a
                href={update.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline-offset-2 hover:underline"
              >
                {update.name}
              </a>
            ) : (
              <span className="font-medium">{update.name}</span>
            )}
            <span className="text-muted-foreground">
              {" "}
              · {dateLabel(update.startedAt)}
              {update.endedAt
                ? ` – ${dateLabel(update.endedAt)}`
                : " · rolling out"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HealthPanelView({
  panel,
  tracked,
}: {
  panel: SearchHealthPanel;
  // SC-F6: "I fixed this" durumları; yoksa düğme çizilmez.
  tracked?: Record<string, HealthFixState>;
}) {
  return (
    <div className="space-y-4">
      <Header panel={panel} />
      <ScopeCard panel={panel} />
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Issues
        </h3>
        <IssueList
          projectId={panel.projectId}
          issues={panel.issues}
          canMute={panel.allowed}
          tracked={tracked}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <CoverageCard panel={panel} />
        <CwvCard panel={panel} />
      </div>
      <KeyPagesCard panel={panel} />
      <SitemapsRobotsCard panel={panel} />
      <AuditCard panel={panel} />
      {panel.lostUrls ? <RedirectMapCard report={panel.lostUrls} /> : null}
      <UpdatesCard panel={panel} />
    </div>
  );
}

export const SEARCH_HEALTH_TITLE_ID = TITLE_ID;
