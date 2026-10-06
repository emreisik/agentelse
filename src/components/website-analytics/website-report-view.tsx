import Link from "next/link";

import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import {
  WEBSITE_PERIODS,
  changePercent,
  type WebsitePeriodKey,
} from "@/lib/website-analytics/periods";
import type {
  WebsiteKpi,
  WebsiteKpiFormat,
  WebsiteReport,
  WebsiteTable,
  WebsiteTrendPoint,
} from "@/server/website-analytics/report";

// "Website" sayfasının gövdesi (docs/google-analytics-plan.md §3.9): tek
// duyarlı düzen, sunucuda çizilir. Sayılar ambardan; dönem bağlantıları
// arama parametresiyle.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";

function format(
  value: number | null,
  kind: WebsiteKpiFormat,
  currency: string | null,
): string {
  if (value === null) return "—";
  return formatMetric(kind, value, currency, { compact: true });
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

export function WebsitePeriodSelector({
  base,
  value,
}: {
  base: string;
  value: WebsitePeriodKey;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-full bg-muted p-0.5">
      {WEBSITE_PERIODS.map((period) => {
        const active = period.key === value;
        return (
          <Link
            key={period.key}
            href={period.key === "28d" ? base : `${base}?period=${period.key}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {period.label}
          </Link>
        );
      })}
    </div>
  );
}

function Change({ kpi }: { kpi: WebsiteKpi }) {
  const change = changePercent(kpi.value, kpi.previous);
  if (change === null) {
    return <span className="text-xs text-muted-foreground">No comparison</span>;
  }
  const up = change >= 0;
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        up
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-rose-700 dark:text-rose-400",
      )}
    >
      {up ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
      <span className="font-normal text-muted-foreground"> vs previous</span>
    </span>
  );
}

export function WebsiteKpis({
  kpis,
  currency,
}: {
  kpis: WebsiteKpi[];
  currency: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {kpis.map((kpi) => (
        <div key={kpi.key} className={CARD} data-kpi={kpi.key}>
          <p className="text-xs text-muted-foreground">{kpi.label}</p>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
            {format(kpi.value, kpi.format, currency)}
          </p>
          <div className="mt-1">
            <Change kpi={kpi} />
          </div>
        </div>
      ))}
    </div>
  );
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 160;
const PAD = 8;

function linePath(values: number[], max: number, count: number): string {
  const step = count > 1 ? (CHART_WIDTH - PAD * 2) / (count - 1) : 0;
  return values
    .map((value, index) => {
      const x = PAD + index * step;
      const y =
        CHART_HEIGHT -
        PAD -
        (max > 0 ? (value / max) * (CHART_HEIGHT - PAD * 2) : 0);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Günlük oturumlar; kesikli çizgi önceki dönem (gün sırasıyla hizalı).
export function WebsiteTrendChart({
  trend,
  previous,
}: {
  trend: WebsiteTrendPoint[];
  previous: number[];
}) {
  if (trend.length === 0) return null;
  const current = trend.map((point) => point.sessions);
  const count = Math.max(current.length, previous.length);
  const max = Math.max(1, ...current, ...previous);
  const total = current.reduce((sum, value) => sum + value, 0);
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Sessions per day</p>
        <p className="text-xs text-muted-foreground">
          <span className="mr-3 inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-foreground" /> This
            period
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 border-t border-dashed border-muted-foreground" />{" "}
            Previous
          </span>
        </p>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="mt-3 h-40 w-full"
        role="img"
        aria-label={`Sessions per day from ${dayLabel(first.day)} to ${dayLabel(last.day)}: ${total} in total, at most ${max} a day.`}
        preserveAspectRatio="none"
      >
        <line
          x1={PAD}
          x2={CHART_WIDTH - PAD}
          y1={CHART_HEIGHT - PAD}
          y2={CHART_HEIGHT - PAD}
          className="stroke-foreground/10"
          strokeWidth={1}
        />
        {previous.length > 1 ? (
          <path
            d={linePath(previous, max, count)}
            fill="none"
            className="stroke-muted-foreground"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={linePath(current, max, count)}
          fill="none"
          className="stroke-foreground"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{dayLabel(first.day)}</span>
        <span>Peak {max.toLocaleString("en-US")} a day</span>
        <span>{dayLabel(last.day)}</span>
      </div>
    </div>
  );
}

export function WebsiteTableCard({
  title,
  firstColumn,
  table,
  currency,
  empty,
}: {
  title: string;
  firstColumn: string;
  table: WebsiteTable;
  currency: string | null;
  empty: string;
}) {
  return (
    <div className={CARD}>
      <p className="text-sm font-medium">{title}</p>
      {table.rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{firstColumn}</th>
                {table.columns.map((column) => (
                  <th
                    key={column.label}
                    className="py-1.5 pl-3 text-right font-medium"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/5">
              {table.rows.map((row) => (
                <tr key={row.label}>
                  <td
                    className="max-w-[260px] truncate py-1.5 pr-3"
                    title={row.label}
                  >
                    {row.label}
                  </td>
                  {row.values.map((value, index) => (
                    <td
                      key={index}
                      className="py-1.5 pl-3 text-right tabular-nums"
                    >
                      {format(
                        value,
                        table.columns[index]?.format ?? "count",
                        currency,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {table.other ? (
                <tr className="text-muted-foreground">
                  <td className="py-1.5 pr-3">Other / not shown</td>
                  {table.other.map((value, index) => (
                    <td
                      key={index}
                      className="py-1.5 pl-3 text-right tabular-nums"
                    >
                      {value === null
                        ? ""
                        : format(
                            value,
                            table.columns[index]?.format ?? "count",
                            currency,
                          )}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      {table.notes.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
          {table.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WebsiteReportBody({ report }: { report: WebsiteReport }) {
  const currency = report.link.currencyCode;
  return (
    <div className="space-y-4">
      <WebsiteKpis kpis={report.kpis} currency={currency} />
      <WebsiteTrendChart trend={report.trend} previous={report.previousTrend} />
      <div className="grid gap-4 lg:grid-cols-2">
        <WebsiteTableCard
          title="Channels"
          firstColumn="Channel"
          table={report.channels}
          currency={currency}
          empty="No sessions in this period."
        />
        <WebsiteTableCard
          title="Key events"
          firstColumn="Event"
          table={report.keyEvents}
          currency={currency}
          empty="No key events in this period. Mark the actions that matter (a form sent, a call) as key events in Google Analytics."
        />
      </div>
      <WebsiteTableCard
        title="Landing pages"
        firstColumn="Page"
        table={report.landingPages}
        currency={currency}
        empty="No landing pages in this period."
      />
      {report.siteSearch ? (
        <WebsiteTableCard
          title="Site search"
          firstColumn="Search term"
          table={report.siteSearch}
          currency={currency}
          empty="No site searches in these weeks."
        />
      ) : null}
      {report.notes.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
