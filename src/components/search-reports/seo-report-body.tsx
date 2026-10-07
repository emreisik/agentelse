import { AlertTriangle, Check, HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCount, formatPosition } from "@/lib/module-flows/analytics/format";
import { FindingDecision } from "@/components/search-reports/finding-decision";
import { ThisMonthsArticlesLive } from "@/components/search-content-plan/this-months-articles-live";
import {
  SeoGoalPaceBadge,
  goalValueText,
} from "@/components/search-reports/seo-goal-pace-badge";
import { kpiChangePct } from "@/lib/seo/reports/kpis";
import {
  SEO_REPORT_COPY,
  VERDICT_LABEL,
  changeText,
  changeTextFromRatio,
  dayLabel,
  kpiValueText,
  monthLabel,
  periodLabel,
} from "@/lib/seo/reports/text";
import type {
  CwvRatingValue,
  DiagnoseVerdict,
  SearchDiagnosis,
  SearchForecast,
  SeoReportActions,
  SeoReportGoal,
  SeoReportHealth,
  SeoReportKpi,
  SeoReportOpportunity,
  SeoReportPulse,
  SeoReportSection,
  SeoReportTable,
  SeoReportUpdate,
  SeoReportView,
  SeoRoadmapItem,
} from "@/lib/seo/reports/types";

// Raporun gövdesi (SC-F5, docs/search-reports.md): saklı anlık görüntüyü
// çizer, hiçbir şey çekmez. Hook yok; sunucuda (Search sayfası) da istemcide
// (sohbet kartı) çizilir. Tek duyarlı düzen. `compact` sohbet kartı içindir:
// en çok 3 KPI, başlık ya da not ve en çok 3 ana satır. Fırsat ve yol
// haritası satırlarındaki Accept/Dismiss, okuma anındaki CANLI bulgu
// durumuna bakar (view.findingStatus); anlık görüntüdeki durum kullanılmaz.

const MUTED = { color: "var(--ws-text-2)" } as const;
const FAINT = { color: "var(--ws-text-3)" } as const;
const BORDER = { borderColor: "var(--ws-border)" } as const;
const COMPACT_KPIS = 3;
const COMPACT_LINES = 3;

const CWV_LABEL: Record<CwvRatingValue, string> = {
  good: "Good",
  "needs-improvement": "Needs improvement",
  poor: "Poor",
};

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wide" style={FAINT}>
      {children}
    </h3>
  );
}

function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn" | "bad";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "warn" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-red-500/10 text-red-700 dark:text-red-400",
      )}
    >
      {children}
    </span>
  );
}

// Sıfırdan sapma yönü: "düşük iyi" metriklerde (ortalama sıra) düşüş yeşildir.
function changeClass(pct: number | null, lowerIsBetter: boolean): string {
  if (pct === null || Math.round(pct) === 0) return "text-muted-foreground";
  const good = lowerIsBetter ? pct < 0 : pct > 0;
  return good
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-rose-700 dark:text-rose-400";
}

function signedCount(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : "−"}${formatCount(Math.abs(value))}`;
}

function safeHref(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function percentOf(ratio: number): number {
  return Math.round(ratio * 100);
}

// ---------------------------------------------------------------- KPI'lar

function KpiTile({
  kpi,
  compareLabel,
  yearAgoLabel,
  compact,
}: {
  kpi: SeoReportKpi;
  compareLabel: string;
  yearAgoLabel: string | null;
  compact: boolean;
}) {
  const previous = kpiChangePct(kpi, "previous");
  const yearAgo = kpiChangePct(kpi, "yearAgo");
  return (
    <div
      data-kpi={kpi.key}
      className="rounded-xl border p-3"
      style={BORDER}
    >
      <p className="text-xs" style={MUTED}>
        {kpi.label}
      </p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">
        {kpiValueText(kpi)}
      </p>
      <p
        className={cn(
          "text-xs font-medium tabular-nums",
          changeClass(previous, kpi.lowerIsBetter),
        )}
      >
        {changeText(previous)}
        <span className="font-normal" style={FAINT}>
          {" "}
          {compareLabel}
        </span>
      </p>
      {!compact && kpi.yearAgo !== null ? (
        <p className="mt-0.5 text-[11px] tabular-nums" style={FAINT}>
          {yearAgoLabel ?? "Last year"}: {kpiValueText(kpi, "yearAgo")} (
          {changeText(yearAgo)})
        </p>
      ) : null}
    </div>
  );
}

function KpisSection({
  section,
  compact,
}: {
  section: Extract<SeoReportSection, { type: "kpis" }>;
  compact: boolean;
}) {
  const kpis = compact ? section.kpis.slice(0, COMPACT_KPIS) : section.kpis;
  if (kpis.length === 0) return null;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2",
        compact ? "sm:grid-cols-3" : "md:grid-cols-3",
      )}
    >
      {kpis.map((kpi) => (
        <KpiTile
          key={kpi.key}
          kpi={kpi}
          compareLabel={section.compareLabel}
          yearAgoLabel={section.yearAgoLabel}
          compact={compact}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Tablolar

function TableSection({ table }: { table: SeoReportTable }) {
  if (table.rows.length === 0) return null;
  return (
    <section data-table={table.key} className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Heading>{table.title}</Heading>
        <Chip>{table.aggregation}</Chip>
      </div>
      <ul className="divide-y text-sm" style={BORDER}>
        {table.rows.map((row, index) => {
          const href = safeHref(row.url);
          const delta = row.clicks - row.previousClicks;
          return (
            <li
              key={`${row.label}-${index}`}
              className="flex items-baseline justify-between gap-3 py-1.5"
              style={BORDER}
            >
              <span className="min-w-0 flex-1 break-words">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline-offset-2 hover:underline"
                  >
                    {row.label}
                  </a>
                ) : (
                  row.label
                )}
                {row.isBrand ? (
                  <>
                    {" "}
                    <Chip>Brand</Chip>
                  </>
                ) : null}
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums">
                {formatCount(row.clicks)} clicks
                <span
                  className={cn(
                    "ml-1.5 font-medium",
                    delta > 0
                      ? "text-emerald-700 dark:text-emerald-400"
                      : delta < 0
                        ? "text-rose-700 dark:text-rose-400"
                        : "text-muted-foreground",
                  )}
                >
                  {signedCount(delta)}
                </span>
                {row.position !== null ? (
                  <span className="ml-1.5" style={FAINT}>
                    pos. {formatPosition(row.position)}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Nabız

function metricName(metric: SeoReportPulse["metric"]): string {
  return metric === "nonBrandClicks" ? "Non-brand clicks" : "Clicks";
}

function PulseSection({ pulse }: { pulse: SeoReportPulse }) {
  return (
    <section data-section="pulse" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.pulseHeading}</Heading>
      <p className="text-sm">
        {metricName(pulse.metric)} on {dayLabel(pulse.day)}:{" "}
        <span className="font-semibold tabular-nums">
          {formatCount(pulse.value)}
        </span>
        {pulse.usual !== null ? (
          <span style={MUTED}>
            {" "}
            (usual {formatCount(pulse.usual)}, {changeTextFromRatio(pulse.changePct)})
          </span>
        ) : null}
      </p>
      {pulse.biggest ? (
        <p className="text-xs" style={MUTED}>
          Biggest shift: {pulse.biggest.dimension} {pulse.biggest.key} with{" "}
          {formatCount(pulse.biggest.value)} clicks, usually{" "}
          {formatCount(pulse.biggest.usual)}.
        </p>
      ) : null}
      {pulse.newCritical > 0 || pulse.openCritical > 0 ? (
        <p className="text-xs text-red-700 dark:text-red-400">
          {pulse.newCritical} new and {pulse.openCritical} open critical alert
          {pulse.openCritical === 1 ? "" : "s"}.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Sağlık

function HealthSection({ health }: { health: SeoReportHealth }) {
  const coverage = health.coverage;
  const cwv = health.cwv;
  return (
    <section data-section="health" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.healthHeading}</Heading>
      <p className="text-sm">
        {health.score !== null ? (
          <>
            Score{" "}
            <span className="font-semibold tabular-nums">{health.score}</span>
            /100
            {health.cappedByCritical ? (
              <span style={MUTED}> (capped by a critical issue)</span>
            ) : null}
            .{" "}
          </>
        ) : null}
        {health.critical} critical and {health.warn} warning
        {health.warn === 1 ? "" : "s"}.
      </p>
      {coverage ? (
        <p className="text-sm" style={MUTED}>
          Pages indexed: ~{percentOf(coverage.point)}% ({percentOf(coverage.low)}
          –{percentOf(coverage.high)}%)
        </p>
      ) : null}
      {cwv && (cwv.phone || cwv.desktop) ? (
        <p className="text-sm" style={MUTED}>
          Core Web Vitals:{" "}
          {[
            cwv.phone ? `phone ${CWV_LABEL[cwv.phone].toLowerCase()}` : null,
            cwv.desktop
              ? `desktop ${CWV_LABEL[cwv.desktop].toLowerCase()}`
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join(", ")}
        </p>
      ) : null}
      {health.issues.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {health.issues.map((issue, index) => (
            <li key={`${issue.title}-${index}`} className="flex items-start gap-2">
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 inline-block size-1.5 shrink-0 rounded-full",
                  issue.severity === "CRITICAL"
                    ? "bg-red-500"
                    : issue.severity === "WARN"
                      ? "bg-amber-500"
                      : "bg-muted-foreground",
                )}
              />
              <span>{issue.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Fırsatlar

function impactText(item: {
  impactPerMonth: number | null;
  reachPerMonth?: number | null;
}): string | null {
  if (item.impactPerMonth !== null) {
    return `About +${formatCount(item.impactPerMonth)} clicks a month`;
  }
  if (item.reachPerMonth != null) {
    return `About ${formatCount(item.reachPerMonth)} more impressions a month`;
  }
  return null;
}

function statusLabel(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function OpportunitiesSection({
  items,
  view,
}: {
  items: SeoReportOpportunity[];
  view: SeoReportView;
}) {
  if (items.length === 0) return null;
  return (
    <section data-section="opportunities" className="space-y-2">
      <Heading>{SEO_REPORT_COPY.opportunitiesHeading}</Heading>
      <ul className="space-y-2">
        {items.map((item) => {
          const live = view.findingStatus?.[item.id] ?? null;
          const impact = impactText(item);
          return (
            <li
              key={item.id}
              className="space-y-1.5 rounded-xl border p-3"
              style={BORDER}
            >
              <p className="text-sm font-medium">{item.title}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Chip>{item.action}</Chip>
                <Chip>{item.confidence}</Chip>
                <Chip>Effort: {item.effort}</Chip>
                {live && live !== "OPEN" ? <Chip>{statusLabel(live)}</Chip> : null}
                {impact ? <span style={MUTED}>{impact}</span> : null}
              </div>
              <FindingDecision
                projectId={view.projectId}
                findingId={item.id}
                status={live}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActionsSection({ actions }: { actions: SeoReportActions }) {
  return (
    <section data-section="actions" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.actionsHeading}</Heading>
      <p className="text-sm" style={MUTED}>
        {actions.accepted} accepted · {actions.done} done · {actions.evaluated}{" "}
        evaluated
      </p>
      {actions.items.length > 0 ? (
        <ul className="space-y-1.5 text-sm">
          {actions.items.map((item, index) => (
            <li key={`${item.title}-${index}`}>
              <span className="font-medium">{item.title}</span>{" "}
              <Chip>{statusLabel(item.status)}</Chip>
              {item.outcome ? (
                <p className="text-xs" style={MUTED}>
                  {item.outcome}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function UpdatesSection({ items }: { items: SeoReportUpdate[] }) {
  if (items.length === 0) return null;
  return (
    <section data-section="updates" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.updatesHeading}</Heading>
      <ul className="space-y-1 text-sm">
        {items.map((item, index) => {
          const href = safeHref(item.url);
          const start = dayLabel(item.startedAt.slice(0, 10));
          const end = item.endedAt ? dayLabel(item.endedAt.slice(0, 10)) : null;
          return (
            <li key={`${item.name}-${index}`}>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {item.name}
                </a>
              ) : (
                <span className="font-medium">{item.name}</span>
              )}{" "}
              <span className="text-xs" style={MUTED}>
                {end ? `${start} – ${end}` : `${start}, still rolling out`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Teşhis

const VERDICT_ICON: Record<DiagnoseVerdict, React.ReactNode> = {
  yes: (
    <AlertTriangle
      className="size-4 text-amber-600 dark:text-amber-400"
      aria-hidden
    />
  ),
  no: <Check className="size-4 text-muted-foreground" aria-hidden />,
  unknown: <HelpCircle className="size-4 text-muted-foreground/70" aria-hidden />,
};

function DiagnosisSection({ diagnosis }: { diagnosis: SearchDiagnosis }) {
  const name = metricName(diagnosis.metric);
  return (
    <section data-section="diagnosis" className="space-y-2">
      <Heading>{SEO_REPORT_COPY.diagnosisHeading}</Heading>
      <p className="text-sm font-medium">{diagnosis.summary}</p>
      <p className="text-xs tabular-nums" style={MUTED}>
        {name}: {formatCount(diagnosis.current)} ({periodLabel(
          diagnosis.window.current.from,
          diagnosis.window.current.to,
        )}) vs {formatCount(diagnosis.previous)} (
        {periodLabel(
          diagnosis.window.previous.from,
          diagnosis.window.previous.to,
        )}
        ) · {changeTextFromRatio(diagnosis.changePct)}
      </p>
      <ol className="space-y-2">
        {diagnosis.steps.map((step) => (
          <li
            key={step.key}
            data-step={step.key}
            data-verdict={step.verdict}
            className="flex items-start gap-2"
          >
            <span className="mt-0.5 shrink-0">{VERDICT_ICON[step.verdict]}</span>
            <div className="min-w-0 space-y-0.5 text-sm">
              <p>
                <span className="font-medium">{step.question}</span>{" "}
                <span
                  className={cn(
                    "text-xs",
                    step.verdict === "yes"
                      ? "font-medium text-amber-700 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                >
                  {VERDICT_LABEL[step.verdict]}
                </span>
                {diagnosis.primary === step.key ? (
                  <>
                    {" "}
                    <Chip tone="warn">Most likely cause</Chip>
                  </>
                ) : null}
              </p>
              {step.evidence.map((line, index) => (
                <p key={`${line}-${index}`} className="text-xs" style={MUTED}>
                  {line}
                </p>
              ))}
              {step.items.length > 0 ? (
                <ul className="text-xs" style={MUTED}>
                  {step.items.map((item, index) => (
                    <li key={`${item.label}-${index}`} className="break-words">
                      {item.label} · {item.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {diagnosis.askUser.length > 0 ? (
        <div
          data-box="check-in-search-console"
          className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
        >
          <p className="text-sm font-medium">
            {SEO_REPORT_COPY.checkInSearchConsole}
          </p>
          <ul className="space-y-1 text-sm">
            {diagnosis.askUser.map((ask) => (
              <li key={ask.screen}>
                <span className="font-medium">{ask.screen}:</span> {ask.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Hedefler

function GoalsSection({ goals }: { goals: SeoReportGoal[] }) {
  if (goals.length === 0) return null;
  return (
    <section data-section="goals" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.goalsHeading}</Heading>
      <ul className="space-y-2">
        {goals.map((goal) => (
          <li key={goal.goalId} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{goal.title}</span>
              <SeoGoalPaceBadge pace={goal.pace} label={goal.paceLabel} />
            </div>
            <p className="text-xs tabular-nums" style={MUTED}>
              Target {goalValueText(goal.metricKey, goal.target)} · Now{" "}
              {goalValueText(goal.metricKey, goal.current)}
              {goal.measuredThrough
                ? ` · Measured through ${dayLabel(goal.measuredThrough)}`
                : ""}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- Tahmin

function ForecastSection({ forecast }: { forecast: SearchForecast }) {
  const what =
    forecast.metric === "nonBrandClicks" ? "non-brand clicks" : "clicks";
  const content = forecast.newContent;
  return (
    <section data-section="forecast" className="space-y-1.5">
      <Heading>{SEO_REPORT_COPY.forecastHeading}</Heading>
      <p className="text-sm">
        About{" "}
        <span className="font-semibold tabular-nums">
          {formatCount(forecast.value)}
        </span>{" "}
        {what} in {monthLabel(forecast.month)} ({formatCount(forecast.low)}–
        {formatCount(forecast.high)}){" "}
        <Chip tone="warn">Directional</Chip>
      </p>
      <p className="text-xs" style={MUTED}>
        {forecast.method === "seasonal"
          ? "Based on last year's pattern and recent months."
          : "Based on the recent trend."}{" "}
        {forecast.historyMonths} months of history.
      </p>
      {content ? (
        <p className="text-xs" style={MUTED}>
          New content (pages first seen in the last 90 days): about{" "}
          {formatCount(content.clicks)} clicks from {formatCount(content.pages)}{" "}
          page{content.pages === 1 ? "" : "s"}, shown separately and{" "}
          {SEO_REPORT_COPY.directional}.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- Plan

function ContentSection({
  title,
  items,
}: {
  title: string;
  items: { title: string; date: string; status: string }[];
}) {
  if (items.length === 0) return null;
  return (
    <section data-section="content" className="space-y-1.5">
      <Heading>{title}</Heading>
      <ul className="space-y-1 text-sm">
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`}>
            <span className="font-medium">{item.title}</span>{" "}
            <span className="text-xs" style={MUTED}>
              {dayLabel(item.date)}
            </span>{" "}
            <Chip>{statusLabel(item.status)}</Chip>
          </li>
        ))}
      </ul>
    </section>
  );
}

function roadmapMeta(item: SeoRoadmapItem): string | null {
  const parts: string[] = [];
  const impact = impactText({ impactPerMonth: item.impactPerMonth });
  if (impact) parts.push(impact);
  if (item.effort) parts.push(`Effort: ${item.effort}`);
  if (item.count !== null) parts.push(`${formatCount(item.count)} affected`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function RoadmapSection({
  actions,
  techDebt,
  view,
}: {
  actions: SeoRoadmapItem[];
  techDebt: SeoRoadmapItem[];
  view: SeoReportView;
}) {
  return (
    <>
      {actions.length > 0 ? (
        <section data-section="roadmap" className="space-y-1.5">
          <Heading>{SEO_REPORT_COPY.roadmapActionsHeading}</Heading>
          <ol className="list-decimal space-y-2 pl-5 text-sm marker:text-muted-foreground">
            {actions.map((item, index) => {
              const meta = roadmapMeta(item);
              return (
                <li key={`${item.title}-${index}`} className="space-y-1">
                  <p>
                    <span className="font-medium">{item.title}</span>{" "}
                    <Chip tone={item.severity === "CRITICAL" ? "bad" : "neutral"}>
                      {item.action}
                    </Chip>
                  </p>
                  {meta ? (
                    <p className="text-xs" style={MUTED}>
                      {meta}
                    </p>
                  ) : null}
                  {item.source === "opportunity" && item.findingId ? (
                    <FindingDecision
                      projectId={view.projectId}
                      findingId={item.findingId}
                      status={view.findingStatus?.[item.findingId] ?? null}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {techDebt.length > 0 ? (
        <section data-section="tech-debt" className="space-y-1.5">
          <Heading>{SEO_REPORT_COPY.roadmapDebtHeading}</Heading>
          <ul className="space-y-1 text-sm">
            {techDebt.map((item, index) => {
              const meta = roadmapMeta(item);
              return (
                <li key={`${item.title}-${index}`}>
                  <span className="font-medium">{item.title}</span>{" "}
                  <Chip tone={item.severity === "WARN" ? "warn" : "neutral"}>
                    {item.action}
                  </Chip>
                  {meta ? (
                    <span className="text-xs" style={MUTED}>
                      {" "}
                      {meta}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Anlatı

function Narrative({ view, compact }: { view: SeoReportView; compact: boolean }) {
  const narrative = view.narrative;
  if (!narrative) {
    if (!view.narrativeNote) return null;
    return (
      <p className="text-xs" style={FAINT}>
        {view.narrativeNote}
      </p>
    );
  }
  const highlights = compact
    ? narrative.highlights.slice(0, COMPACT_LINES)
    : narrative.highlights;
  return (
    <div
      data-section="narrative"
      className="space-y-2 rounded-xl border px-3 py-2.5"
      style={BORDER}
    >
      {narrative.headline ? (
        <p className="text-sm font-medium">{narrative.headline}</p>
      ) : null}
      {highlights.length > 0 ? (
        <div className="space-y-1">
          {compact ? null : <Heading>{SEO_REPORT_COPY.highlights}</Heading>}
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {highlights.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact && narrative.watchouts.length > 0 ? (
        <div className="space-y-1">
          <Heading>{SEO_REPORT_COPY.watchouts}</Heading>
          <ul className="list-disc space-y-1 pl-4 text-sm" style={MUTED}>
            {narrative.watchouts.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!compact && narrative.nextSteps.length > 0 ? (
        <div className="space-y-1">
          <Heading>{SEO_REPORT_COPY.nextSteps}</Heading>
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {narrative.nextSteps.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- Gövde

function SectionView({
  section,
  view,
  compact,
}: {
  section: SeoReportSection;
  view: SeoReportView;
  compact: boolean;
}) {
  switch (section.type) {
    case "kpis":
      return <KpisSection section={section} compact={compact} />;
    case "table":
      return <TableSection table={section.table} />;
    case "pulse":
      return <PulseSection pulse={section.pulse} />;
    case "health":
      return <HealthSection health={section.health} />;
    case "opportunities":
      return <OpportunitiesSection items={section.items} view={view} />;
    case "actions":
      return <ActionsSection actions={section.actions} />;
    case "updates":
      return <UpdatesSection items={section.items} />;
    case "diagnosis":
      return <DiagnosisSection diagnosis={section.diagnosis} />;
    case "goals":
      return <GoalsSection goals={section.goals} />;
    case "forecast":
      return <ForecastSection forecast={section.forecast} />;
    case "content": {
      const snapshotSection = (
        <ContentSection title={section.title} items={section.items} />
      );
      // SC-F7: yalnız yol haritasında canlı plan; geçmiş ayın raporu değişmez anlık görüntü (fallback) kalır, canlı bileşen ay uyuşmazlığında, yüklenirken, 404'te ve hatada fallback'i çizer.
      if (view.snapshot.kind !== "ROADMAP" || !view.contentPlanLive) {
        return snapshotSection;
      }
      return (
        <ThisMonthsArticlesLive
          projectId={view.projectId}
          month={view.snapshot.period.from.slice(0, 7)}
          fallback={snapshotSection}
        />
      );
    }
    case "roadmap":
      return (
        <RoadmapSection
          actions={section.actions}
          techDebt={section.techDebt}
          view={view}
        />
      );
  }
}

// Kompakt kartta, anlatı yokken ana satırlar yol haritasının ilk adımlarıdır.
function compactLines(view: SeoReportView): string[] {
  if (view.narrative) return [];
  const roadmap = view.snapshot.sections.find(
    (section) => section.type === "roadmap",
  );
  if (!roadmap || roadmap.type !== "roadmap") return [];
  return roadmap.actions.slice(0, COMPACT_LINES).map((item) => item.title);
}

export function SeoReportBody({
  view,
  compact = false,
}: {
  view: SeoReportView;
  compact?: boolean;
}) {
  const { snapshot } = view;
  if (compact) {
    // Sohbet kartı: KPI'lar ya da nabız, başlık/not ve en çok 3 ana satır.
    const lead = snapshot.sections.filter(
      (section) => section.type === "kpis" || section.type === "pulse",
    );
    const lines = compactLines(view);
    return (
      <div className="space-y-3" data-compact="true">
        {lead.map((section, index) => (
          <SectionView
            key={`${section.type}-${index}`}
            section={section}
            view={view}
            compact
          />
        ))}
        <Narrative view={view} compact />
        {lines.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {lines.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Narrative view={view} compact={false} />
      {snapshot.sections.map((section, index) => (
        <SectionView
          key={`${section.type}-${index}`}
          section={section}
          view={view}
          compact={false}
        />
      ))}
      {snapshot.notes.length > 0 ? (
        <ul
          className="space-y-0.5 border-t pt-2 text-[11px]"
          style={{ ...BORDER, ...FAINT }}
        >
          {snapshot.notes.map((note, index) => (
            <li key={`${note}-${index}`}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
