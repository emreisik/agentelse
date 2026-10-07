import Link from "next/link";

import { cn } from "@/lib/utils";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import { addDays } from "@/lib/seo/dates";
import {
  SEARCH_PERIODS,
  changePercent,
  type SearchPeriodKey,
} from "@/lib/seo/periods";
import type {
  SearchKpi,
  SearchKpiFormat,
  SearchQueryFilter,
  SearchReport,
  SearchTable,
  SearchTrendPoint,
} from "@/server/seo/report";

// "Search" sayfasının gövdesi (SC-F2, docs/search-analytics.md): tek duyarlı
// düzen, sunucuda çizilir. Sayılar Search Console ambarından; günler PT,
// KPI'lar yalnız kesin günlerden. Dönem ve sorgu süzgeci arama parametresiyle.

const CARD = "rounded-xl p-4 ring-1 ring-foreground/10";

function format(value: number | null, kind: SearchKpiFormat): string {
  if (value === null) return "—";
  return formatMetric(kind, value, null, { compact: true });
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

// Varsayılanlar (28d, all) adreste yazılmaz.
function searchHref(
  base: string,
  period: SearchPeriodKey,
  queryFilter: SearchQueryFilter,
): string {
  const params = new URLSearchParams();
  if (period !== "28d") params.set("period", period);
  if (queryFilter !== "all") params.set("queries", queryFilter);
  const query = params.toString();
  // SC-F9: ikincil site görünümünde ?site= parametresi korunur.
  const joiner = base.includes("?") ? "&" : "?";
  return query ? `${base}${joiner}${query}` : base;
}

export function SearchPeriodSelector({
  base,
  value,
  queryFilter,
}: {
  base: string;
  value: SearchPeriodKey;
  queryFilter: SearchQueryFilter;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-full bg-muted p-0.5">
      {SEARCH_PERIODS.map((period) => {
        const active = period.key === value;
        return (
          <Link
            key={period.key}
            href={searchHref(base, period.key, queryFilter)}
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

// Ortalama sıra gibi "düşük iyi" KPI'larda düşüş yeşildir.
function Change({ kpi }: { kpi: SearchKpi }) {
  const change = changePercent(kpi.value, kpi.previous);
  if (change === null) {
    return <span className="text-xs text-muted-foreground">No comparison</span>;
  }
  const up = change >= 0;
  const good = kpi.lowerIsBetter ? change <= 0 : up;
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        good
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-rose-700 dark:text-rose-400",
      )}
    >
      {up ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
      <span className="font-normal text-muted-foreground"> vs previous</span>
    </span>
  );
}

function SearchKpis({ kpis }: { kpis: SearchKpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {kpis.map((kpi) => (
        <div key={kpi.key} className={CARD} data-kpi={kpi.key}>
          <p className="text-xs text-muted-foreground">{kpi.label}</p>
          <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
            {format(kpi.value, kpi.format)}
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

// `offset`: çizginin x ekseninde başladığı gün sırası (taze devam için).
function linePath(
  values: number[],
  max: number,
  count: number,
  offset = 0,
): string {
  const step = count > 1 ? (CHART_WIDTH - PAD * 2) / (count - 1) : 0;
  return values
    .map((value, index) => {
      const x = PAD + (offset + index) * step;
      const y =
        CHART_HEIGHT -
        PAD -
        (max > 0 ? (value / max) * (CHART_HEIGHT - PAD * 2) : 0);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

// Günlük tıklamalar: kesin günler düz çizgi, taze günler noktalı devam,
// önceki dönem kesikli (gün sırasıyla hizalı).
function SearchTrendChart({
  trend: all,
  previous,
}: {
  trend: SearchTrendPoint[];
  previous: number[];
}) {
  // Seri kesin günlerden seçilir: marka serisi yalnız kesin günlere yazılır,
  // taze günlerde nonBrandClicks hep null gelir.
  const finalPoints = all.filter((point) => !point.fresh);
  const nonBrand =
    finalPoints.length > 0 &&
    finalPoints.every((point) => point.nonBrandClicks !== null);
  // Markasız çizgide marka ayrımı olmayan taze günler dışarıda kalır
  // (toplam tıklamayla karışık bir çizgi yanıltırdı).
  const freshDropped =
    nonBrand &&
    all.some((point) => point.fresh && point.nonBrandClicks === null);
  const trend = freshDropped ? finalPoints : all;
  if (trend.length === 0) return null;
  const title = nonBrand ? "Non-brand clicks per day" : "Clicks per day";
  const values = trend.map((point) =>
    nonBrand ? (point.nonBrandClicks ?? 0) : point.clicks,
  );
  const firstFresh = trend.findIndex((point) => point.fresh);
  const finalCount = firstFresh === -1 ? values.length : firstFresh;
  const finalValues = values.slice(0, finalCount);
  // Taze çizgi son kesin günden başlar, böylece iki çizgi birleşir.
  const freshStart = Math.max(0, finalCount - 1);
  const freshValues = firstFresh === -1 ? [] : values.slice(freshStart);
  const freshDays = firstFresh === -1 ? 0 : values.length - finalCount;

  const count = Math.max(values.length, previous.length);
  const max = Math.max(1, ...values, ...previous);
  const total = finalValues.reduce((sum, value) => sum + value, 0);
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const summary =
    `${title} from ${dayLabel(first.day)} to ${dayLabel(last.day)}: ` +
    `${total} in total on final days, at most ${max} a day.` +
    (freshDays > 0
      ? ` The last ${freshDays} day${freshDays === 1 ? " is" : "s are"} fresh and may change.`
      : "") +
    (freshDropped ? " Fresh days aren't split by brand yet, so they're left out." : "");
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-foreground" /> This
            period
          </span>
          {freshDays > 0 ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 border-t-2 border-dotted border-foreground" />{" "}
              Fresh (may change)
            </span>
          ) : null}
          {previous.length > 1 ? (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3 border-t border-dashed border-muted-foreground" />{" "}
              Previous
            </span>
          ) : null}
        </p>
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="mt-3 h-40 w-full"
        role="img"
        aria-label={summary}
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
        {finalValues.length > 0 ? (
          <path
            d={linePath(finalValues, max, count)}
            fill="none"
            className="stroke-foreground"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {freshValues.length > 0 ? (
          <path
            d={linePath(freshValues, max, count, freshStart)}
            fill="none"
            className="stroke-foreground"
            strokeWidth={2}
            strokeDasharray="1 5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            data-series="fresh"
          />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{dayLabel(first.day)}</span>
        <span>Peak {max.toLocaleString("en-US")} a day</span>
        <span>{dayLabel(last.day)}</span>
      </div>
      {freshDropped ? (
        <p className="mt-1 text-[11px] text-muted-foreground" data-fresh-dropped>
          Fresh days aren&apos;t split by brand yet, so they&apos;re left out.
        </p>
      ) : null}
    </div>
  );
}

// "Oct 6 – Oct 26 · By property": tablolar tam Pzt–Paz haftalarından.
function tableCaption(table: SearchTable): string {
  const end = addDays(table.weeks.to, 6);
  return `${dayLabel(table.weeks.from)} – ${dayLabel(end)} · ${table.aggregation}`;
}

const FILTERS: { key: SearchQueryFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "non-brand", label: "Non-brand" },
  { key: "brand", label: "Brand" },
];

function QueryFilter({ base, report }: { base: string; report: SearchReport }) {
  if (report.link.brandSplit === "none") return null;
  return (
    <div
      className="flex items-center gap-1 rounded-full bg-muted p-0.5"
      data-filter="queries"
    >
      {FILTERS.map((filter) => {
        const active = filter.key === report.queryFilter;
        return (
          <Link
            key={filter.key}
            href={searchHref(base, report.period.key, filter.key)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {filter.label}
          </Link>
        );
      })}
    </div>
  );
}

function SearchTableCard({
  title,
  firstColumn,
  table,
  empty,
  aside,
  footer,
}: {
  title: string;
  firstColumn: string;
  table: SearchTable;
  empty: string;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px] text-muted-foreground">
            {tableCaption(table)}
          </p>
        </div>
        {aside ?? null}
      </div>
      {table.rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{firstColumn}</th>
                <th className="py-1.5 pl-3 text-right font-medium">Clicks</th>
                <th className="py-1.5 pl-3 text-right font-medium">
                  Impressions
                </th>
                <th className="py-1.5 pl-3 text-right font-medium">CTR</th>
                <th className="py-1.5 pl-3 text-right font-medium">Position</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-foreground/5">
              {table.rows.map((row, index) => (
                <tr key={`${row.label}-${index}`}>
                  <td className="max-w-[280px] py-1.5 pr-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {row.href ? (
                        <a
                          href={row.href}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate underline-offset-2 hover:underline"
                          title={row.label}
                        >
                          {row.label}
                        </a>
                      ) : (
                        <span className="truncate" title={row.label}>
                          {row.label}
                        </span>
                      )}
                      {row.isBrand ? (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                          Brand
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">
                    {format(row.clicks, "count")}
                  </td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">
                    {format(row.impressions, "count")}
                  </td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">
                    {format(row.ctr, "percent")}
                  </td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">
                    {format(row.position, "position")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {footer ?? null}
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

// Google'ın gizlilik için göstermediği aramaların payı (kesir, 0–1).
function anonymousSentence(share: number | null): string | null {
  if (share === null) return null;
  const percent = Math.round(Math.min(1, Math.max(0, share)) * 100);
  return `${percent}% of clicks come from searches Google doesn't show.`;
}

export function SearchReportBody({
  report,
  base,
}: {
  report: SearchReport;
  base: string;
}) {
  const anonymous = anonymousSentence(report.anonymousShare);
  const footnotes = [
    ...report.notes,
    ...(report.archiveNote ? [report.archiveNote] : []),
  ];
  return (
    <div className="space-y-4">
      <SearchKpis kpis={report.kpis} />
      <SearchTrendChart trend={report.trend} previous={report.previousTrend} />
      <SearchTableCard
        title="Top searches"
        firstColumn="Search"
        table={report.queries}
        empty="No searches in these weeks yet."
        aside={<QueryFilter base={base} report={report} />}
        footer={
          anonymous ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {anonymous}
            </p>
          ) : null
        }
      />
      <SearchTableCard
        title="Top pages"
        firstColumn="Page"
        table={report.pages}
        empty="No pages in these weeks yet."
      />
      {footnotes.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {footnotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
