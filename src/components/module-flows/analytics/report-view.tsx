"use client";

import { CircleAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import {
  wsToneDotColor,
  type WsTone,
} from "@/components/commands/ws-event-card";
import {
  integrationsHref,
  isConnectionReason,
} from "@/lib/module-flows/analytics/catalog";
import { ANALYTICS_COPY as COPY } from "@/lib/module-flows/analytics/copy";
import {
  formatBuiltAt,
  formatCount,
  formatMoney,
  formatPosition,
} from "@/lib/module-flows/analytics/format";
import {
  failReasonText,
  isSnapshotMetric,
  metricLabel,
  metricText,
  periodText,
  sectionNote,
  sectionTitle,
  type OkSection,
  type ReportData,
  type ReportSection,
} from "@/lib/module-flows/analytics/report";

import { GroupHeading, SourceMark } from "./parts";

// The built report on the card (Review and Share): the AI summary first, then
// one block per source with its KPI tiles (value, label, the period under the
// source's name) and its short lists, or the reason it has no numbers. Read
// only: everything comes from the stored report, so it reads the same later.

export function ReportView({
  report,
  projectId,
  timeZone,
}: {
  report: ReportData;
  projectId: string;
  timeZone?: string;
}) {
  const built = formatBuiltAt(report.builtAt, timeZone);
  return (
    <div className="space-y-4">
      <SummaryBlock report={report} />
      {report.sections.map((section) => (
        <SectionBlock
          key={section.source}
          section={section}
          report={report}
          projectId={projectId}
        />
      ))}
      <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
        {built ? `${COPY.builtAt(built)} · ` : ""}
        {COPY.onlyNumbers}
      </p>
    </div>
  );
}

function SummaryBlock({ report }: { report: ReportData }) {
  const headingId = useId();
  const summary = report.summary;
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl p-3.5"
      style={{ background: "var(--ws-surface-2)" }}
    >
      <p
        id={headingId}
        className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.08em] uppercase"
        style={{ color: "var(--ws-text-2)" }}
      >
        <Sparkles aria-hidden="true" className="size-3" />
        {COPY.summaryEyebrow}
      </p>
      {summary ? (
        <>
          {summary.headline ? (
            <p
              className="text-[15px] leading-snug font-semibold"
              style={{ color: "var(--ws-text)" }}
            >
              {summary.headline}
            </p>
          ) : null}
          <SummaryList
            title={COPY.highlightsHeading}
            items={summary.highlights}
            tone="positive"
          />
          <SummaryList
            title={COPY.watchoutsHeading}
            items={summary.watchouts}
            tone="waiting"
          />
          <SummaryList
            title={COPY.nextStepsHeading}
            items={summary.nextSteps}
            tone="neutral"
          />
        </>
      ) : (
        <p className="text-xs leading-5" style={{ color: "var(--ws-text-2)" }}>
          {report.summaryNote ?? COPY.summaryUnavailable}
        </p>
      )}
    </section>
  );
}

function SummaryList({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly string[];
  tone: WsTone;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium" style={{ color: "var(--ws-text)" }}>
        {title}
      </p>
      <ul className="space-y-1">
        {items.map((item, index) => (
          <li
            key={index}
            className="flex gap-2 text-sm leading-5"
            style={{ color: "var(--ws-text-body)" }}
          >
            <span
              aria-hidden="true"
              className="mt-2 size-1.5 shrink-0 rounded-full"
              style={{ background: wsToneDotColor(tone) }}
            />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionBlock({
  section,
  report,
  projectId,
}: {
  section: ReportSection;
  report: ReportData;
  projectId: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center gap-2.5">
        <SourceMark source={section.source} />
        <p
          id={headingId}
          className="min-w-0 flex-1 truncate text-sm font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {sectionTitle(section)}
          {section.ok && section.account ? (
            <span className="font-normal" style={{ color: "var(--ws-text-2)" }}>
              {" · "}
              {section.account}
            </span>
          ) : null}
        </p>
        {section.ok ? (
          <span
            className="shrink-0 text-[11px]"
            style={{ color: "var(--ws-text-3)" }}
          >
            {periodText(section.days)}
          </span>
        ) : null}
      </div>
      {section.ok ? (
        <OkSectionBody section={section} report={report} />
      ) : (
        <div
          className="flex items-start gap-2 rounded-xl border border-dashed px-3 py-2.5 text-xs"
          style={{ borderColor: "var(--ws-border)", color: "var(--ws-text-2)" }}
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <p className="min-w-0 flex-1 leading-5">
            {failReasonText(section.reason)}
          </p>
          {isConnectionReason(section.reason) ? (
            <Link
              href={integrationsHref(projectId)}
              className="inline-flex min-h-6 shrink-0 items-center font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
              style={{ color: "var(--ws-text)" }}
            >
              {COPY.openIntegrations}
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}

function OkSectionBody({
  section,
  report,
}: {
  section: OkSection;
  report: ReportData;
}) {
  const money = (value: number) => formatMoney(value, section.currency);
  const period = periodText(section.days);
  const note = sectionNote(section, report.period);
  return (
    <div className="space-y-2.5">
      {section.metrics.length > 0 ? (
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {section.metrics.map((metric) => {
            const snapshot = isSnapshotMetric(metric.key);
            return (
              <li
                key={metric.key}
                className="min-w-0 rounded-xl border px-3 py-2.5"
                style={{ borderColor: "var(--ws-border)" }}
              >
                <p
                  className="truncate text-lg leading-tight font-semibold tabular-nums"
                  style={{ color: "var(--ws-text)" }}
                >
                  {metricText(metric, section.currency, { compact: true })}
                </p>
                <p
                  className="mt-0.5 truncate text-[11px]"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {metricLabel(metric.key)}
                  {snapshot ? ` · ${COPY.now}` : null}
                  <span className="sr-only">
                    {snapshot ? "" : `, ${period}`}
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      <RowList
        title={COPY.resultsHeading}
        rows={section.results.map((result) => ({
          key: result.label,
          main: result.label,
          value: formatCount(result.count),
          sub:
            result.costPerResult !== null
              ? COPY.costEach(money(result.costPerResult))
              : null,
        }))}
      />
      <RowList
        title={COPY.campaignsHeading}
        rows={section.campaigns.map((campaign, index) => ({
          key: `${index}`,
          main: campaign.name,
          value: money(campaign.spend),
          sub:
            campaign.results !== null && campaign.resultLabel
              ? `${formatCount(campaign.results)} ${campaign.resultLabel}`
              : null,
        }))}
      />
      <RowList
        title={COPY.queriesHeading}
        rows={section.queries.map((query, index) => ({
          key: `${index}`,
          main: query.query,
          value: COPY.clicks(formatCount(query.clicks)),
          sub: COPY.position(formatPosition(query.position)),
        }))}
      />
      {note ? (
        <p className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

function RowList({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; main: string; value: string; sub: string | null }[];
}) {
  const headingId = useId();
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <GroupHeading id={headingId}>{title}</GroupHeading>
      <ul
        aria-labelledby={headingId}
        className="divide-y rounded-xl border"
        style={{ borderColor: "var(--ws-border)" }}
      >
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-center gap-3 px-3 py-2"
            style={{ borderColor: "var(--ws-border)" }}
          >
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-xs font-medium"
                style={{ color: "var(--ws-text)" }}
              >
                {row.main}
              </span>
              {row.sub ? (
                <span
                  className="block truncate text-[11px]"
                  style={{ color: "var(--ws-text-2)" }}
                >
                  {row.sub}
                </span>
              ) : null}
            </span>
            <span
              className="shrink-0 text-xs font-medium tabular-nums"
              style={{ color: "var(--ws-text)" }}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
