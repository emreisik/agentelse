import Link from "next/link";

import { PlanSettingsForm } from "@/components/search-content-plan/plan-settings-form";
import { PlanStateView } from "@/components/search-content-plan/plan-states";
import { SlotRow } from "@/components/search-content-plan/slot-row";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { usageLine } from "@/lib/seo/content-plan/view";
import { refreshPlanAction } from "@/server/actions/seo-content-plan-actions";
import type {
  ContentPlanView,
  PillarView,
  SlotView,
} from "@/server/seo/content-plan/store";

// Search sayfasındaki "This month's articles" listesi (SC-F7,
// docs/search-content-plan.md) ve yol haritası kartındaki kompakt hâli.
// Yalnız props'tan çizilir (kanca yok; etkileşim alt bileşenlerde); tek duyarlı
// düzen. İç kimlikler (fikir, parça, kreatif) çizilmez.

export const CONTENT_PLAN_TITLE_ID = "search-content-plan-title";

const DAY_MS = 86_400_000;
const ARTICLES_FOR = (count: number) =>
  `${count} ${count === 1 ? "article" : "articles"}`;

// "2026-09-21" + 6 gün → "Sep 27" (verinin dayandığı haftanın sonu).
function weekEndLabel(week: string | null): string | null {
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return null;
  const start = new Date(`${week}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(start.getTime() + 6 * DAY_MS));
}

// Tarih sırası (tarihsizler sona); atlananlar ayrıca, soluk listelenir.
export function orderSlots(slots: readonly SlotView[]): {
  active: SlotView[];
  skipped: SlotView[];
} {
  const byDate = (a: SlotView, b: SlotView) => {
    if (a.date === b.date) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  };
  return {
    active: slots.filter((slot) => slot.state !== "SKIPPED").sort(byDate),
    skipped: slots.filter((slot) => slot.state === "SKIPPED").sort(byDate),
  };
}

function PillarMap({ pillars }: { pillars: readonly PillarView[] }) {
  if (pillars.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium">Topics in the plan</h3>
      <ul className="space-y-1 text-xs">
        {pillars.slice(0, 6).map((pillar) => (
          <li
            key={pillar.clusterId}
            className="flex flex-wrap items-baseline justify-between gap-x-3"
          >
            <span className="min-w-0 flex-1 basis-40 truncate font-medium">
              {pillar.name}
            </span>
            <span className="text-muted-foreground">
              {`${pillar.sharePct}% of searches · `}
              {pillar.weak || !pillar.pillarPath
                ? PLAN_COPY.noStrongMain
                : pillar.pillarPath}
              {` · ${ARTICLES_FOR(pillar.articles)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefreshControl({
  view,
  projectId,
}: {
  view: ContentPlanView;
  projectId: string;
}) {
  const reason =
    view.regenerationsLeft <= 0
      ? "You can refresh the plan up to 3 times."
      : !view.canRefresh
        ? "Every article is already in progress, so there is nothing to refresh."
        : null;
  return (
    <ActionForm
      action={refreshPlanAction}
      successMessage="The plan was refreshed."
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <SubmitButton
        size="xs"
        variant="outline"
        disabled={!view.canRefresh}
        aria-describedby={reason ? "content-plan-refresh-reason" : undefined}
      >
        {PLAN_COPY.refresh}
      </SubmitButton>
      {reason ? (
        <span
          id="content-plan-refresh-reason"
          className="text-xs text-muted-foreground"
        >
          {reason}
        </span>
      ) : null}
    </ActionForm>
  );
}

function Footer({
  view,
  projectId,
}: {
  view: ContentPlanView;
  projectId: string;
}) {
  const through = weekEndLabel(view.basedOnWeek);
  const wordingNote =
    view.wordingNote === "budget"
      ? PLAN_COPY.aiLimitNote
      : view.wording === "BASIC"
        ? PLAN_COPY.basicWording
        : null;
  return (
    <div className="space-y-3 border-t border-foreground/10 pt-3">
      <PillarMap pillars={view.pillars} />
      <div className="space-y-1 text-xs text-muted-foreground">
        {through ? <p>{`Plan built from search data through ${through}`}</p> : null}
        {wordingNote ? <p>{wordingNote}</p> : null}
        {view.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      <RefreshControl view={view} projectId={projectId} />
    </div>
  );
}

function Header({
  view,
  compact,
}: {
  view: ContentPlanView;
  compact: boolean;
}) {
  const Heading = compact ? "h3" : "h2";
  return (
    <div className="space-y-1">
      <Heading
        id={compact ? undefined : CONTENT_PLAN_TITLE_ID}
        className={
          compact
            ? "text-sm font-medium"
            : "font-heading text-base font-semibold"
        }
      >
        {PLAN_COPY.sectionTitle}
      </Heading>
      <p className="text-xs text-muted-foreground">
        {`${view.monthLabel} · ${usageLine(view.used, view.cap)}`}
      </p>
    </div>
  );
}

export function ContentPlanListView({
  view,
  compact = false,
  projectId,
  applyReady = false,
}: {
  view: ContentPlanView;
  compact?: boolean;
  projectId: string;
  // SC-F8: sunucuda bir kez hesaplanır (loadApplyReady); false iken işaretleme aynıdır.
  applyReady?: boolean;
}): React.JSX.Element {
  const ready = view.state === "ready";
  const { active, skipped } = orderSlots(view.slots);
  return (
    <div className="space-y-4" data-compact={compact ? "true" : undefined}>
      <Header view={view} compact={compact} />
      {!compact ? (
        <PlanSettingsForm
          projectId={projectId}
          monthlyCap={view.settings.monthlyCap}
          autoPlan={view.settings.autoPlan}
        />
      ) : null}
      {ready ? (
        <>
          <ul className="space-y-3">
            {active.map((slot) => (
              <SlotRow
                key={slot.id}
                slot={slot}
                projectId={projectId}
                month={view.month}
                compact={compact}
                applyReady={applyReady && !compact}
              />
            ))}
          </ul>
          {!compact && skipped.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Skipped
              </h3>
              <ul className="space-y-2">
                {skipped.map((slot) => (
                  <SlotRow
                    key={slot.id}
                    slot={slot}
                    projectId={projectId}
                    month={view.month}
                    applyReady={applyReady && !compact}
                  />
                ))}
              </ul>
            </div>
          ) : null}
          {compact ? (
            <Link
              href={`/projects/${projectId}/arama#content-plan`}
              className="inline-block text-xs font-medium underline-offset-4 hover:underline"
            >
              Open plan
            </Link>
          ) : (
            <Footer view={view} projectId={projectId} />
          )}
        </>
      ) : (
        <PlanStateView view={view} projectId={projectId} />
      )}
    </div>
  );
}
