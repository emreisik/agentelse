import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { SubmitButton } from "@/components/shared/submit-button";
import { cn } from "@/lib/utils";
import {
  SEO_DISMISS_REASONS,
  type SeoDismissReason,
} from "@/lib/seo/opportunity-types";
import {
  acceptOpportunityAction,
  dismissOpportunityAction,
  markOpportunityDoneAction,
} from "@/server/actions/search-opportunity-actions";
import type {
  OpportunitiesPanel,
  OpportunityItem,
} from "@/server/seo/opportunities/panel";

// Search sayfasındaki "Opportunities" listesi (SC-F4,
// docs/search-opportunities.md): her satırda başlık, özet, etki / güven /
// emek / eylem çipleri, varsa "Why this matters" açıklaması, ilk 3 sorgu ve
// sayfa ile Accept / Dismiss / Mark done. ?opportunity= ile gelinen satır
// halkayla vurgulanır. Yalnız props'tan çizilir (sunucu bileşeni); tek
// duyarlı düzen, mobil önce.

export const OPPORTUNITIES_TITLE_ID = "search-opportunities-title";

const DISMISS_LABEL: Readonly<Record<SeoDismissReason, string>> = {
  not_relevant: "Not relevant",
  already_done: "Already done",
  wrong_data: "Data looks wrong",
  not_now: "Not now",
};

const EVIDENCE_ROWS = 3;

const selectClass =
  "h-6 rounded-md border border-input bg-background px-1.5 text-xs";

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const POSITION = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// "2026-09-21" (Pazartesi, PT) → "Sep 21".
export function weekLabel(week: string | null): string | null {
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${week}T00:00:00.000Z`));
}

function Chip({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "positive";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        tone === "positive"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function OpportunityChips({ item }: { item: OpportunityItem }) {
  return (
    <div className="flex flex-wrap gap-1">
      {item.impactLabel ? (
        <Chip tone="positive">{item.impactLabel}</Chip>
      ) : null}
      <Chip>{item.confidenceLabel}</Chip>
      <Chip>{item.effortLabel}</Chip>
      <Chip>{item.actionLabel}</Chip>
    </div>
  );
}

type EvidenceRow = {
  key: string;
  label: string;
  impressions: number;
  position: number | null;
};

function evidenceRows(item: OpportunityItem): EvidenceRow[] {
  const queries = (item.evidence.queries ?? [])
    .slice(0, EVIDENCE_ROWS)
    .map((query) => ({
      key: `q:${query.queryId}`,
      label: query.text,
      impressions: query.impressions,
      position: query.position,
    }));
  const pages = (item.evidence.pages ?? [])
    .slice(0, EVIDENCE_ROWS)
    .map((page, index) => ({
      key: `p:${page.pageId ?? index}:${page.path}`,
      label: page.path,
      impressions: page.impressions,
      position: page.position,
    }));
  return [...queries, ...pages];
}

export function OpportunityEvidence({ item }: { item: OpportunityItem }) {
  const rows = evidenceRows(item);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Search or page</th>
            <th className="py-1 pr-3 text-right font-medium">Impressions</th>
            <th className="py-1 text-right font-medium">Position</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-foreground/10">
              <td className="max-w-[240px] truncate py-1 pr-3">{row.label}</td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {COUNT.format(row.impressions)}
              </td>
              <td className="py-1 text-right tabular-nums">
                {row.position === null ? "—" : POSITION.format(row.position)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hidden({
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

function DismissForm({
  projectId,
  item,
}: {
  projectId: string;
  item: OpportunityItem;
}) {
  return (
    <ActionForm
      action={dismissOpportunityAction}
      successMessage="Dismissed"
      className="flex items-center gap-1"
    >
      <Hidden projectId={projectId} findingId={item.id} />
      <select
        name="reason"
        defaultValue="not_relevant"
        aria-label="Why dismiss this opportunity"
        className={selectClass}
      >
        {SEO_DISMISS_REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {DISMISS_LABEL[reason]}
          </option>
        ))}
      </select>
      <SubmitButton size="xs" variant="ghost">
        Dismiss
      </SubmitButton>
    </ActionForm>
  );
}

function OpportunityRow({
  projectId,
  item,
}: {
  projectId: string;
  item: OpportunityItem;
}) {
  const accepted = item.status === "ACCEPTED";
  return (
    <li
      id={`opportunity-${item.id}`}
      data-rule={item.ruleKey}
      data-highlighted={item.highlighted ? "true" : undefined}
      className={cn(
        "scroll-mt-20 space-y-2 rounded-xl p-4 ring-1 ring-foreground/10",
        item.highlighted && "ring-2 ring-primary",
      )}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{item.title}</p>
        <p className="text-xs text-muted-foreground">{item.summary}</p>
      </div>
      <OpportunityChips item={item} />
      {item.explanation ? (
        <details className="text-xs" open={item.highlighted}>
          <summary className="cursor-pointer font-medium select-none">
            Why this matters
          </summary>
          <p className="mt-1.5 whitespace-pre-line text-muted-foreground">
            {item.explanation}
          </p>
        </details>
      ) : null}
      <OpportunityEvidence item={item} />
      <div className="flex flex-wrap items-center gap-2">
        {accepted ? (
          <ActionForm
            action={markOpportunityDoneAction}
            successMessage="Marked as done"
          >
            <Hidden projectId={projectId} findingId={item.id} />
            <SubmitButton size="xs">Mark done</SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm
            action={acceptOpportunityAction}
            successMessage="Accepted"
          >
            <Hidden projectId={projectId} findingId={item.id} />
            <SubmitButton size="xs">Accept</SubmitButton>
          </ActionForm>
        )}
        <DismissForm projectId={projectId} item={item} />
      </div>
    </li>
  );
}

export function OpportunityListView({
  panel,
}: {
  panel: OpportunitiesPanel;
}): React.JSX.Element {
  const week = weekLabel(panel.week);
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2
          id={OPPORTUNITIES_TITLE_ID}
          className="font-heading text-base font-semibold"
        >
          Opportunities
        </h2>
        <p className="text-xs text-muted-foreground">
          {week
            ? `From your Search Console data · week of ${week}`
            : "From your Search Console data"}
        </p>
        {panel.notes.map((note) => (
          <p key={note} className="text-xs text-muted-foreground">
            {note}
          </p>
        ))}
      </div>
      {panel.items.length === 0 ? (
        <EmptyState title="No opportunities this week." className="py-8" />
      ) : (
        <ul className="space-y-3">
          {panel.items.map((item) => (
            <OpportunityRow
              key={item.id}
              projectId={panel.projectId}
              item={item}
            />
          ))}
        </ul>
      )}
      {panel.accepted.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Accepted</h3>
          <ul className="space-y-3">
            {panel.accepted.map((item) => (
              <OpportunityRow
                key={item.id}
                projectId={panel.projectId}
                item={item}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
