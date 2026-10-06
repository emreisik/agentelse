"use client";

import { useState } from "react";
import { AlertTriangle, BarChart3, ChevronDown } from "lucide-react";

import { ReportExportButtons } from "@/components/website-analytics/reports/report-export-buttons";
import {
  AlertSection,
  Chip,
  KpiGrid,
  NextSteps,
  NotesList,
  PeriodDetails,
  PlanSection,
  PulseSection,
} from "@/components/website-analytics/reports/report-sections";
import { cn } from "@/lib/utils";
import { formatBuiltAt } from "@/lib/module-flows/analytics/format";
import { readWebsiteReportCard } from "@/lib/website-analytics/reports/card";
import { WEBSITE_REPORT_COPY } from "@/lib/website-analytics/reports/copy";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";

// Website analytics sohbetindeki rapor kartı (GA-F5, docs/website-reports.md).
// YALNIZ kartın saklı kopyasından çizilir: hiçbir şey çekilmez, kart gönderildikten
// sonra değişmez. Tek duyarlı düzen: mobilde 2, md'den itibaren 4 sütunlu KPI
// ızgarası. Uzun (haftalık, aylık, plan) kartlar sohbette kompakt kart olarak
// durur ve sağ panelde tam açılır (works-card.tsx inPane).

const MUTED = { color: "var(--ws-text-2)" } as const;
const FAINT = { color: "var(--ws-text-3)" } as const;

function Narrative({ card }: { card: WebsiteReportCardData }) {
  const narrative = card.narrative;
  if (!narrative) {
    if (!card.narrativeNote) return null;
    return (
      <p className="text-xs" style={FAINT}>
        {card.narrativeNote}
      </p>
    );
  }
  return (
    <div
      className="space-y-2 rounded-xl border px-3 py-2.5"
      style={{ borderColor: "var(--ws-border)" }}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide" style={FAINT}>
        {WEBSITE_REPORT_COPY.narrativeLabel}
      </p>
      {narrative.headline ? (
        <p className="text-sm font-medium">{narrative.headline}</p>
      ) : null}
      {narrative.highlights.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4 text-sm">
          {narrative.highlights.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {narrative.watchouts.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4 text-sm" style={MUTED}>
          {narrative.watchouts.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CardBody({
  card,
  commandId,
}: {
  card: WebsiteReportCardData;
  commandId?: string;
}) {
  const [open, setOpen] = useState(card.variant === "monthly");
  const { body, currency, projectId } = card;

  switch (body.variant) {
    case "pulse":
      return <PulseSection body={body} currency={currency} projectId={projectId} />;
    case "alert":
      return <AlertSection body={body} projectId={projectId} />;
    case "plan":
      return (
        <PlanSection
          body={body}
          currency={currency}
          projectId={projectId}
          commandId={commandId}
        />
      );
    case "weekly":
    case "monthly":
      return (
        <div className="space-y-3">
          <KpiGrid kpis={body.kpis} currency={currency} />
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
            style={MUTED}
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
              aria-hidden="true"
            />
            {open ? "Hide full report" : "Show full report"}
          </button>
          {open ? (
            <PeriodDetails body={body} currency={currency} projectId={projectId} />
          ) : null}
          <NextSteps steps={body.nextSteps} source={body.nextStepsSource} />
          <NotesList notes={body.notes} />
        </div>
      );
  }
}

export function WebsiteReportCard({
  card,
  commandId,
}: {
  card: WebsiteReportCardData;
  commandId?: string;
}) {
  const Icon = card.variant === "alert" ? AlertTriangle : BarChart3;
  const titleId = `website-report-${commandId ?? card.variant}`;
  const showNarrative = card.variant === "weekly" || card.variant === "monthly";

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-card="website-report"
      data-card-id={commandId}
      className="mt-1 w-full max-w-2xl space-y-3 rounded-2xl border p-3.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
        boxShadow: "var(--ws-card-shadow)",
        color: "var(--ws-text)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--ws-hover)" }}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 id={titleId} className="text-sm font-medium leading-snug">
            {card.title}
          </h3>
          <p className="text-xs" style={MUTED}>
            {card.periodLabel}
            {card.propertyName ? ` · ${card.propertyName}` : ""}
          </p>
          {card.preliminary || card.isMock ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {card.preliminary ? <Chip tone="warn">Preliminary</Chip> : null}
              {card.isMock ? <Chip>Demo data</Chip> : null}
            </div>
          ) : null}
        </div>
      </div>

      {showNarrative ? <Narrative card={card} /> : null}

      <CardBody card={card} commandId={commandId} />

      <div
        className="flex flex-wrap items-center justify-between gap-2 border-t pt-2"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <ReportExportButtons card={card} />
        <p className="text-[11px]" style={FAINT}>
          Sent {formatBuiltAt(card.builtAt, card.timeZone)}
          {card.variant === "alert" ? "" : ` · ${WEBSITE_REPORT_COPY.snapshotNote}`}
        </p>
      </div>
    </div>
  );
}

// Works sohbetinin girişi: ham saklı kartı doğrular. Bozuk ya da gelecekteki
// sürümden bir kart sohbeti düşürmez, nötr bir satır gösterir.
export function WebsiteReportWorksCard({
  card,
  commandId,
}: {
  card: unknown;
  commandId?: string;
}) {
  const report = readWebsiteReportCard(card);
  if (!report) {
    return (
      <div
        data-card="website-report"
        data-card-id={commandId}
        className="mt-1 text-xs"
        style={FAINT}
      >
        {WEBSITE_REPORT_COPY.reportUnavailable}
      </div>
    );
  }
  return <WebsiteReportCard card={report} commandId={commandId} />;
}
