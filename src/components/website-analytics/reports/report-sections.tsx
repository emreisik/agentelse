import Link from "next/link";

import { cn } from "@/lib/utils";
import { WebsiteTableCard } from "@/components/website-analytics/website-report-view";
import { PacePill } from "@/components/website-analytics/reports/goal-pace-chip";
import { FindingDecisionButtons } from "@/components/website-analytics/reports/finding-decision-buttons";
import { PlanTargetsForm } from "@/components/website-analytics/reports/plan-targets-form";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import { WEBSITE_REPORT_COPY } from "@/lib/website-analytics/reports/copy";
import { paceTone } from "@/lib/website-analytics/reports/pace";
import type {
  AlertBody,
  MonthlyBody,
  PeriodReportSections,
  PlanBody,
  PulseBody,
  ReportFindingSnap,
  ReportForecastSnap,
  ReportGoalSnap,
  ReportKpi,
  ReportMeasurement,
  ReportMover,
  ReportTable,
  ReportValueFormat,
  WeeklyBody,
} from "@/lib/website-analytics/reports/types";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { muteMeasurementAlertAction } from "@/server/actions/measurement-health-actions";

// Rapor kartının gövde parçaları (GA-F5). Hepsi saklı kartın verisinden çizilir:
// hiçbir şey çekilmez ve hesaplanmaz. Google kaynaklı metinler (sayfa, olay,
// arama terimi) düz metin olarak basılır; dangerouslySetInnerHTML kullanılmaz.
// Hook yok: durum (açılır bölüm) kartın kendisinde; Accept / Dismiss'in canlı
// durum denetimi istemci bileşeni FindingDecisionButtons'tadır.

const MUTED = { color: "var(--ws-text-2)" } as const;
const FAINT = { color: "var(--ws-text-3)" } as const;
const BORDER = { borderColor: "var(--ws-border)" } as const;
const NOTHING = "Nothing to show.";

function money(
  format: ReportValueFormat | "count" | "money",
  value: number | null,
  currency: string | null,
): string {
  if (value === null) return "—";
  return formatMetric(format, value, currency, { compact: true });
}

// "+17.7%": değişim yüzdesi zaten 1 ondalıkla yuvarlanmış gelir.
export function signedPercent(value: number): string {
  const text = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}%`;
}

function signedCount(value: number): string {
  const text = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.abs(value));
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${text}`;
}

function deltaClass(value: number | null, neutral = false): string {
  if (value === null || value === 0 || neutral) return "text-muted-foreground";
  return value > 0
    ? "text-emerald-700 dark:text-emerald-400"
    : "text-red-700 dark:text-red-400";
}

export function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "warn" | "good";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        tone === "warn"
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : tone === "good"
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium" style={MUTED}>
      {children}
    </p>
  );
}

export function NotesList({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-[11px]" style={FAINT}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

// --- KPI'lar ---------------------------------------------------------------

export function KpiGrid({
  kpis,
  currency,
}: {
  kpis: readonly ReportKpi[];
  currency: string | null;
}) {
  return (
    <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {kpis.map((kpi) => (
        <div
          key={kpi.key}
          className="rounded-xl border px-2.5 py-2"
          style={BORDER}
        >
          <dt className="text-[11px]" style={MUTED}>
            {kpi.label}
          </dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums">
            {money(kpi.format, kpi.value, currency)}
          </dd>
          {kpi.changePct !== null ? (
            <dd
              className={cn(
                "text-[11px] tabular-nums",
                deltaClass(kpi.changePct, kpi.key === "engagementTime"),
              )}
            >
              {signedPercent(kpi.changePct)} vs previous
            </dd>
          ) : null}
          {kpi.lastYear !== null ? (
            <dd className="text-[11px] tabular-nums" style={FAINT}>
              Last year {money(kpi.format, kpi.lastYear, currency)}
              {kpi.lastYearChangePct !== null
                ? ` · ${signedPercent(kpi.lastYearChangePct)}`
                : ""}
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

// --- Tablolar ve sayfa hareketleri -------------------------------------------

export function ReportTableBlock({
  title,
  firstColumn,
  table,
  currency,
}: {
  title: string;
  firstColumn: string;
  table: ReportTable | null;
  currency: string | null;
}) {
  if (!table) return null;
  return (
    <WebsiteTableCard
      title={title}
      firstColumn={firstColumn}
      table={table}
      currency={currency}
      empty={NOTHING}
    />
  );
}

function MoverList({
  title,
  movers,
}: {
  title: string;
  movers: readonly ReportMover[];
}) {
  if (movers.length === 0) return null;
  return (
    <div className="space-y-1">
      <SectionTitle>{title}</SectionTitle>
      <ul className="space-y-1 text-xs">
        {movers.map((mover) => (
          <li key={mover.page} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate" title={mover.page}>
              {mover.page}
            </span>
            <span className="shrink-0 tabular-nums" style={MUTED}>
              {mover.sessions.toLocaleString("en-US")} sessions
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                deltaClass(mover.change),
              )}
            >
              {signedCount(mover.change)}
              {mover.changePct !== null
                ? ` (${signedPercent(mover.changePct)})`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MoversBlock({
  winners,
  losers,
}: {
  winners: readonly ReportMover[];
  losers: readonly ReportMover[];
}) {
  if (winners.length === 0 && losers.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <MoverList title="Landing pages gaining" movers={winners} />
      <MoverList title="Landing pages dropping" movers={losers} />
    </div>
  );
}

const TONE_DOT: Record<ReportMeasurement["tone"], string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

export function MeasurementLine({
  measurement,
}: {
  measurement: ReportMeasurement | null;
}) {
  if (!measurement) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", TONE_DOT[measurement.tone])}
      />
      <span className="font-medium">Measurement health</span>
      <span style={MUTED}>
        {measurement.label}
        {measurement.score !== null ? ` · ${measurement.score}/100` : ""}
        {measurement.issues > 0
          ? ` · ${measurement.issues} ${measurement.issues === 1 ? "issue" : "issues"}`
          : ""}
        {measurement.critical > 0 ? ` (${measurement.critical} critical)` : ""}
      </span>
      <Link href={measurement.href} className="underline underline-offset-2">
        Open
      </Link>
    </p>
  );
}

// --- Bulgular (What changed / Opportunities) ---------------------------------

function FindingRow({
  snap,
  projectId,
  decisions,
}: {
  snap: ReportFindingSnap;
  projectId: string;
  decisions: boolean;
}) {
  return (
    <li className="space-y-1 rounded-xl border px-2.5 py-2" style={BORDER}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium">{snap.title}</span>
        <Chip tone={snap.confidence === "Significant" ? "good" : "neutral"}>
          {snap.confidence}
        </Chip>
        {snap.preliminary ? <Chip tone="warn">Preliminary</Chip> : null}
      </div>
      {snap.detail ? (
        <p className="text-xs" style={MUTED}>
          {snap.detail}
        </p>
      ) : null}
      {snap.impact ? (
        <p className="text-xs" style={MUTED}>
          {snap.impact}
        </p>
      ) : null}
      {snap.explanation ? (
        <p className="text-xs" style={MUTED}>
          {snap.explanation}
        </p>
      ) : null}
      {snap.outcome ? (
        <p className="text-xs font-medium">{snap.outcome}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[11px]" style={FAINT}>
          {snap.period}
        </span>
        <Link
          href={snap.href}
          className="text-[11px] underline underline-offset-2"
          style={MUTED}
        >
          View on the Website page
        </Link>
      </div>
      {decisions ? (
        <FindingDecisionButtons
          projectId={projectId}
          findingId={snap.id}
          title={snap.title}
        />
      ) : null}
    </li>
  );
}

export function FindingsBlock({
  title,
  items,
  projectId,
  insights,
}: {
  title: string;
  items: readonly ReportFindingSnap[];
  projectId: string;
  // Accept / Dismiss yalnız GA-F4 açıkken ve bulgu hâlâ OPEN iken.
  insights: PeriodReportSections["insights"] | "none";
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {title ? <SectionTitle>{title}</SectionTitle> : null}
      <ul className="space-y-1.5">
        {items.map((snap) => (
          <FindingRow
            key={snap.id}
            snap={snap}
            projectId={projectId}
            decisions={insights === "on" && snap.status === "OPEN"}
          />
        ))}
      </ul>
    </div>
  );
}

// --- Hedefler ve tahminler ---------------------------------------------------

function GoalRow({
  goal,
  currency,
}: {
  goal: ReportGoalSnap;
  currency: string | null;
}) {
  const value = (amount: number) => money(goal.format, amount, currency);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="min-w-0 flex-1 font-medium">{goal.title}</span>
      <span className="tabular-nums" style={MUTED}>
        {goal.final ? "Result" : "So far"} {value(goal.monthToDate)}
        {goal.target !== null ? ` of ${value(goal.target)}` : ""}
      </span>
      {!goal.final && goal.forecast !== null ? (
        <span className="tabular-nums" style={MUTED}>
          Forecast {value(goal.forecast)}
          {goal.low !== null && goal.high !== null
            ? ` (${value(goal.low)}–${value(goal.high)})`
            : ""}
        </span>
      ) : null}
      <PacePill
        pace={goal.pace}
        label={goal.paceLabel}
        tone={paceTone(goal.pace)}
      />
    </li>
  );
}

export function GoalsBlock({
  goals,
  currency,
}: {
  goals: readonly ReportGoalSnap[];
  currency: string | null;
}) {
  if (goals.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <SectionTitle>Goals</SectionTitle>
      <ul className="space-y-1.5">
        {goals.map((goal) => (
          <GoalRow key={goal.goalId} goal={goal} currency={currency} />
        ))}
      </ul>
    </div>
  );
}

export function ForecastsBlock({
  forecasts,
  currency,
}: {
  forecasts: readonly ReportForecastSnap[];
  currency: string | null;
}) {
  if (forecasts.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <SectionTitle>Month-end forecast</SectionTitle>
      <ul className="space-y-1 text-xs">
        {forecasts.map((forecast) => {
          const value = (amount: number) =>
            money(forecast.format, amount, currency);
          return (
            <li key={forecast.metric} className="space-y-0.5">
              <span className="font-medium">{forecast.label}</span>{" "}
              <span className="tabular-nums" style={MUTED}>
                {value(forecast.monthToDate)} so far
                {forecast.forecast !== null
                  ? ` · forecast ${value(forecast.forecast)}`
                  : ""}
                {forecast.forecast !== null &&
                forecast.low !== null &&
                forecast.high !== null
                  ? ` (${value(forecast.low)}–${value(forecast.high)})`
                  : ""}
              </span>
              {forecast.note ? (
                <span className="block text-[11px]" style={FAINT}>
                  {forecast.note}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function OutcomesBlock({
  outcomes,
  projectId,
}: {
  outcomes: MonthlyBody["outcomes"];
  projectId: string;
}) {
  if (!outcomes) return null;
  const total = outcomes.worked + outcomes.didnt + outcomes.inconclusive;
  if (total === 0) return null;
  return (
    <div className="space-y-1.5">
      <SectionTitle>Results of accepted changes</SectionTitle>
      <p className="text-xs">
        {outcomes.worked} of {total} {total === 1 ? "change" : "changes"}{" "}
        clearly worked.
      </p>
      <FindingsBlock
        title=""
        items={outcomes.items}
        projectId={projectId}
        insights="none"
      />
    </div>
  );
}

export function NextSteps({
  steps,
  source,
}: {
  steps: readonly string[];
  source: PeriodReportSections["nextStepsSource"];
}) {
  if (steps.length === 0 || source === "none") return null;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle>Next steps</SectionTitle>
        <Chip>{source === "ai" ? "Suggested by AI" : "From findings"}</Chip>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

// --- Varyant gövdeleri -------------------------------------------------------

// Pulse: günlük, kısa. KPI satırları + uyarılar + kanal değişimleri.
export function PulseSection({
  body,
  currency,
  projectId,
}: {
  body: PulseBody;
  currency: string | null;
  projectId: string;
}) {
  return (
    <div className="space-y-3">
      {body.kpis.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {body.kpis.map((kpi) => (
            <li
              key={kpi.key}
              className={cn(
                "tabular-nums",
                kpi.unusual && "text-amber-700 dark:text-amber-400",
              )}
            >
              <span className="font-medium">{kpi.label}</span>{" "}
              {money(kpi.format, kpi.value, currency)}
              {kpi.usual !== null
                ? ` · usual ${money(kpi.format, kpi.usual, currency)}`
                : ""}
              {kpi.changePct !== null ? ` · ${signedPercent(kpi.changePct)}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {body.alerts.length > 0 ? (
        <div className="space-y-1.5">
          <SectionTitle>Open tracking alerts</SectionTitle>
          <ul className="space-y-1">
            {body.alerts.map((alert) => (
              <li
                key={`${alert.title}-${alert.href}`}
                className="flex flex-wrap items-center gap-1.5 text-sm"
              >
                <Link href={alert.href} className="underline underline-offset-2">
                  {alert.title}
                </Link>
                <Chip tone={alert.severity === "CRITICAL" ? "warn" : "neutral"}>
                  {alert.severity === "CRITICAL" ? "Critical" : "Warning"}
                </Chip>
                {alert.isNew ? <Chip tone="warn">New</Chip> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {body.changes.length > 0 ? (
        <div className="space-y-1.5">
          <SectionTitle>Channels that moved</SectionTitle>
          <ul className="space-y-1 text-xs tabular-nums">
            {body.changes.map((change) => (
              <li key={change.channel}>
                <span className="font-medium">{change.channel}</span>{" "}
                <span style={MUTED}>
                  {change.sessions.toLocaleString("en-US")} sessions · usual{" "}
                  {Math.round(change.usual).toLocaleString("en-US")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <FindingsBlock
        title="Unusual today"
        items={body.anomalies}
        projectId={projectId}
        insights="none"
      />
      {body.holiday ? (
        <p className="text-[11px]" style={FAINT}>
          {WEBSITE_REPORT_COPY.holidayNote}
        </p>
      ) : null}
      {body.suspect ? (
        <p className="text-[11px]" style={FAINT}>
          {WEBSITE_REPORT_COPY.suspectNote}
        </p>
      ) : null}
    </div>
  );
}

// Haftalık ve aylık: "Show full report" açılınca görünen ayrıntılar.
export function PeriodDetails({
  body,
  currency,
  projectId,
}: {
  body: WeeklyBody | MonthlyBody;
  currency: string | null;
  projectId: string;
}) {
  const monthly = body.variant === "monthly" ? body : null;
  const weekly = body.variant === "weekly" ? body : null;
  return (
    <div className="space-y-3">
      <ReportTableBlock
        title="Channels"
        firstColumn="Channel"
        table={body.channels}
        currency={currency}
      />
      <MoversBlock winners={body.winners} losers={body.losers} />
      {monthly ? (
        <ReportTableBlock
          title="Top pages"
          firstColumn="Page"
          table={monthly.topPages}
          currency={currency}
        />
      ) : null}
      <ReportTableBlock
        title="Key events"
        firstColumn="Event"
        table={body.keyEvents}
        currency={currency}
      />
      <ReportTableBlock
        title="AI assistants"
        firstColumn="Assistant"
        table={body.aiAssistants}
        currency={currency}
      />
      <ReportTableBlock
        title="Site search"
        firstColumn="Search term"
        table={body.siteSearch}
        currency={currency}
      />
      {monthly ? (
        <ReportTableBlock
          title="Paid traffic"
          firstColumn="Campaign"
          table={monthly.paidTraffic}
          currency={currency}
        />
      ) : null}
      <MeasurementLine measurement={body.measurement} />
      {body.insights === "pending" ? (
        <p className="text-xs" style={MUTED}>
          {WEBSITE_REPORT_COPY.insightsPending}
        </p>
      ) : null}
      <FindingsBlock
        title="What changed"
        items={body.whatChanged}
        projectId={projectId}
        insights={body.insights}
      />
      <FindingsBlock
        title="Opportunities"
        items={body.opportunities}
        projectId={projectId}
        insights={body.insights}
      />
      <GoalsBlock goals={body.goals} currency={currency} />
      {weekly ? (
        <ForecastsBlock forecasts={weekly.forecasts} currency={currency} />
      ) : null}
      {monthly ? (
        <OutcomesBlock outcomes={monthly.outcomes} projectId={projectId} />
      ) : null}
    </div>
  );
}

// "Next month plan": önerilen hedefler, öne çıkan bulgular, içerik ve reklam
// için girdiler, tahminler.
export function PlanSection({
  body,
  currency,
  projectId,
  commandId,
}: {
  body: PlanBody;
  currency: string | null;
  projectId: string;
  commandId?: string;
}) {
  return (
    <div className="space-y-3">
      {body.proposals.length > 0 ? (
        <div className="space-y-1.5">
          <SectionTitle>Suggested targets</SectionTitle>
          <PlanTargetsForm
            projectId={projectId}
            commandId={commandId}
            proposals={body.proposals}
            currency={currency}
          />
        </div>
      ) : body.proposalNote ? (
        <p className="text-xs" style={MUTED}>
          {body.proposalNote}
        </p>
      ) : null}
      <FindingsBlock
        title="Top opportunities"
        items={body.topFindings}
        projectId={projectId}
        insights="none"
      />
      {body.bestPages.length > 0 || body.channelQuality ? (
        <div className="space-y-2">
          <SectionTitle>For content and ads</SectionTitle>
          {body.bestPages.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {body.bestPages.map((page) => (
                <li key={page.page} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate" title={page.page}>
                    {page.page}
                  </span>
                  <span className="shrink-0 tabular-nums" style={MUTED}>
                    {page.sessions.toLocaleString("en-US")} sessions ·{" "}
                    {page.keyEvents.toLocaleString("en-US")} key events (
                    {formatMetric("percent", page.keyEventRate, null)})
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <ReportTableBlock
            title="Channel quality"
            firstColumn="Channel"
            table={body.channelQuality}
            currency={currency}
          />
        </div>
      ) : null}
      <ForecastsBlock forecasts={body.forecasts} currency={currency} />
    </div>
  );
}

// Kritik ölçüm uyarısı: metin, "Open" / "Reconnect" bağlantısı ve 7 günlük
// susturma (yeniden bağlanma uyarısında susturma yok).
export function AlertSection({
  body,
  projectId,
}: {
  body: AlertBody;
  projectId: string;
}) {
  return (
    <div className="space-y-2.5">
      <p className="text-sm">
        {body.reconnect
          ? WEBSITE_REPORT_COPY.reconnectBody
          : WEBSITE_REPORT_COPY.alertBody}
      </p>
      <p className="text-sm font-medium">{body.title}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={body.href}
          className="inline-flex h-6 items-center rounded-lg border px-2 text-xs font-medium hover:bg-muted"
          style={BORDER}
        >
          {body.reconnect ? "Reconnect" : "Open"}
        </Link>
        {body.reconnect ? null : (
          <ActionForm
            action={muteMeasurementAlertAction}
            successMessage="Muted for 7 days"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="alertId" value={body.alertId} />
            <SubmitButton variant="ghost" size="xs">
              Mute for 7 days
            </SubmitButton>
          </ActionForm>
        )}
      </div>
    </div>
  );
}
