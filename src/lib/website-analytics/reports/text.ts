import { operatorFindingTitle } from "@/lib/website-analytics/analysis/describe";
import { isGaRuleKey } from "@/lib/website-analytics/analysis/registry";
import type {
  GaFindingKind,
  GaRuleKey,
} from "@/lib/website-analytics/analysis/types";
import {
  formatCount,
  formatMetric,
  formatPercent,
} from "@/lib/module-flows/analytics/format";

import { WEBSITE_REPORT_COPY } from "./copy";
import { WEBSITE_GOAL_LABEL } from "./goal-keys";
import {
  type ReportFindingSnap,
  type ReportForecastSnap,
  type ReportGoalSnap,
  type ReportAgentelseSection,
  type ReportKpi,
  type ReportTable,
  type ReportValueFormat,
  type WebsiteReportCardData,
} from "./types";

// GA-F5 kart metinleri: sohbet özeti (Command.replyText) ve düz metin. Sohbet
// özeti sonraki LLM turlarına girebilir (Limited Use): yalnız rakam, GA
// varsayılan kanal adı, sayaç ve genel bulgu başlığı taşır; sayfa yolu, arama
// terimi, kampanya, olay adı, uyarı ayrıntısı ve anlatı ASLA girmez. Saf ve
// izomorfik.

const DIGEST_MAX_CHARS = 1200;
const DIGEST_CHANNELS = 5;

const FINDING_KINDS: ReadonlySet<string> = new Set<GaFindingKind>([
  "ANOMALY",
  "CHANGE",
  "OPPORTUNITY",
  "RISK",
  "WIN",
]);

// GA4 varsayılan kanal grupları: yalnız bunlar özete girer (özel ad Google
// metnidir).
const DEFAULT_CHANNELS: ReadonlySet<string> = new Set([
  "Direct",
  "Organic Search",
  "Paid Search",
  "Organic Social",
  "Paid Social",
  "Email",
  "Referral",
  "Display",
  "Affiliates",
  "Organic Video",
  "Paid Video",
  "Organic Shopping",
  "Paid Shopping",
  "Cross-network",
  "Audio",
  "SMS",
  "Mobile Push Notifications",
]);

// Kayıtlı kural ve tür için operatör başlığı; bilinmeyende "Finding". Asla
// fırlatmaz.
export function safeOperatorTitle(ruleKey: string, kind: string): string {
  if (!isGaRuleKey(ruleKey) || !FINDING_KINDS.has(kind)) return "Finding";
  try {
    return operatorFindingTitle(ruleKey as GaRuleKey, kind as GaFindingKind);
  } catch {
    return "Finding";
  }
}

function fmt(
  format: ReportValueFormat,
  value: number,
  currency: string | null,
): string {
  return formatMetric(format, value, currency);
}

// "+12.3%" / "-4.5%" / "0%".
function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${formatPercent(value)}`;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function comparedWith(variant: "weekly" | "monthly"): string {
  return variant === "weekly" ? "the week before" : "the month before";
}

// --- Sohbet özeti --------------------------------------------------------------

function kpiDigestLine(
  kpi: ReportKpi,
  currency: string | null,
  compared: string,
): string | null {
  if (kpi.value === null) return null;
  const value = fmt(kpi.format, kpi.value, currency);
  return kpi.changePct === null
    ? `${kpi.label} ${value}`
    : `${kpi.label} ${value} (${signedPercent(kpi.changePct)} vs ${compared})`;
}

function findingTitles(findings: readonly ReportFindingSnap[]): string {
  return unique(
    findings.map((finding) => safeOperatorTitle(finding.ruleKey, finding.kind)),
  ).join("; ");
}

function goalDigestLine(goal: ReportGoalSnap): string {
  return `Goal ${WEBSITE_GOAL_LABEL[goal.metricKey]}: ${goal.paceLabel.toLowerCase()}`;
}

function openAlertsText(count: number): string {
  return `${count} open tracking ${count === 1 ? "alert" : "alerts"}`;
}

export function websiteReportChatDigest(card: WebsiteReportCardData): string {
  const lines: string[] = [card.title];
  const body = card.body;
  const currency = card.currency;
  switch (body.variant) {
    case "weekly":
    case "monthly": {
      const compared = comparedWith(body.variant);
      for (const kpi of body.kpis) {
        const line = kpiDigestLine(kpi, currency, compared);
        if (line) lines.push(line);
      }
      const channels = body.channels.rows
        .filter((row) => DEFAULT_CHANNELS.has(row.label))
        .slice(0, DIGEST_CHANNELS)
        .map((row) => `${row.label} ${formatCount(row.values[0] ?? 0)}`);
      if (channels.length > 0)
        lines.push(`Top channels: ${channels.join(", ")}`);
      if (body.whatChanged.length > 0) {
        lines.push(
          `What changed (${body.whatChanged.length}): ${findingTitles(body.whatChanged)}`,
        );
      }
      if (body.opportunities.length > 0) {
        lines.push(
          `Opportunities (${body.opportunities.length}): ${findingTitles(body.opportunities)}`,
        );
      }
      for (const goal of body.goals) lines.push(goalDigestLine(goal));
      if (body.variant === "monthly" && body.outcomes) {
        const { worked, didnt, inconclusive } = body.outcomes;
        lines.push(
          `Results of earlier changes: ${worked} worked, ${didnt} no clear effect, ${inconclusive} inconclusive`,
        );
      }
      break;
    }
    case "pulse": {
      for (const kpi of body.kpis) {
        const value = fmt(kpi.format, kpi.value, currency);
        lines.push(
          kpi.usual === null
            ? `${kpi.label} ${value}`
            : `${kpi.label} ${value} (usual ${fmt(kpi.format, kpi.usual, currency)})`,
        );
      }
      const unusual = body.kpis.filter((kpi) => kpi.unusual);
      if (unusual.length > 0) {
        lines.push(`Unusual: ${unusual.map((kpi) => kpi.label).join(", ")}`);
      }
      for (const change of body.changes) {
        if (!DEFAULT_CHANNELS.has(change.channel)) continue;
        lines.push(
          `${change.channel} ${formatCount(change.sessions)} (usual ${formatCount(change.usual)})`,
        );
      }
      if (body.alerts.length > 0)
        lines.push(openAlertsText(body.alerts.length));
      if (body.anomalies.length > 0) {
        lines.push(`Anomalies: ${findingTitles(body.anomalies)}`);
      }
      if (body.holiday) lines.push(WEBSITE_REPORT_COPY.holidayNote);
      if (body.suspect) lines.push(WEBSITE_REPORT_COPY.suspectNote);
      break;
    }
    case "plan": {
      for (const proposal of body.proposals) {
        lines.push(
          `${proposal.label} target suggestion ${fmt(proposal.format, proposal.suggested, currency)} (range ${fmt(proposal.format, proposal.low, currency)}–${fmt(proposal.format, proposal.high, currency)})`,
        );
      }
      if (body.topFindings.length > 0) {
        lines.push(`Opportunities: ${findingTitles(body.topFindings)}`);
      }
      break;
    }
    case "alert": {
      // Başlık satırı zaten "Tracking alert: <başlık>" der.
      lines.push(
        body.reconnect
          ? WEBSITE_REPORT_COPY.reconnectBody
          : WEBSITE_REPORT_COPY.alertBody,
      );
      break;
    }
  }
  return lines.join("\n").slice(0, DIGEST_MAX_CHARS);
}

// --- Düz metin (Copy) ----------------------------------------------------------

const EMPTY_VALUE = "–";

function cellText(
  format: ReportValueFormat,
  label: string,
  value: number | null,
  currency: string | null,
): string {
  if (value === null) return EMPTY_VALUE;
  // "Change" sütunu işaretli yazılır.
  return label === "Change" && format === "percent"
    ? signedPercent(value)
    : fmt(format, value, currency);
}

function tableLines(
  title: string,
  table: ReportTable,
  currency: string | null,
): string[] {
  const lines = [
    `${title} (${table.columns.map((column) => column.label).join(" · ")})`,
  ];
  const render = (label: string, values: readonly (number | null)[]) => {
    const cells = table.columns.map((column, index) =>
      cellText(column.format, column.label, values[index] ?? null, currency),
    );
    lines.push(`- ${label}: ${cells.join(" · ")}`);
  };
  for (const row of table.rows) render(row.label, row.values);
  if (table.other) render("Other", table.other);
  for (const note of table.notes) lines.push(`  ${note}`);
  return lines;
}

// GA-F6: "From Agentelse" bölümü; yalnız haftalık gövdede ve doluysa yazılır.
function agentelseLines(
  section: ReportAgentelseSection | undefined,
  currency: string | null,
): string[] {
  if (!section) return [];
  const hasRows = (table: ReportTable | null): table is ReportTable =>
    table !== null && (table.rows.length > 0 || table.other !== null);
  const tables: [string, ReportTable | null][] = [
    ["Tracked links", section.tracked],
    ["Your ads on your website", section.ads],
    ["Google Ads", section.googleAds],
  ];
  const lines: string[] = [];
  for (const [title, table] of tables) {
    if (hasRows(table)) lines.push(...tableLines(title, table, currency));
  }
  if (lines.length === 0) return [];
  for (const note of section.notes) lines.push(`  ${note}`);
  return ["From Agentelse", ...lines];
}

function kpiLines(kpis: readonly ReportKpi[], card: WebsiteReportCardData) {
  const lines: string[] = ["Key numbers"];
  for (const kpi of kpis) {
    if (kpi.value === null) continue;
    const parts = [fmt(kpi.format, kpi.value, card.currency)];
    if (kpi.previous !== null) {
      const change =
        kpi.changePct === null ? "" : `, ${signedPercent(kpi.changePct)}`;
      parts.push(
        `(before: ${fmt(kpi.format, kpi.previous, card.currency)}${change})`,
      );
    }
    if (kpi.lastYear !== null) {
      const change =
        kpi.lastYearChangePct === null
          ? ""
          : `, ${signedPercent(kpi.lastYearChangePct)}`;
      parts.push(
        `(last year: ${fmt(kpi.format, kpi.lastYear, card.currency)}${change})`,
      );
    }
    lines.push(`- ${kpi.label}: ${parts.join(" ")}`);
  }
  return lines;
}

function findingLines(
  title: string,
  findings: readonly ReportFindingSnap[],
): string[] {
  if (findings.length === 0) return [];
  const lines = [title];
  for (const finding of findings) {
    lines.push(`- ${finding.title} (${finding.confidence}, ${finding.period})`);
    lines.push(`  ${finding.detail}`);
    if (finding.impact) lines.push(`  ${finding.impact}`);
    if (finding.explanation) lines.push(`  ${finding.explanation}`);
    if (finding.outcome) lines.push(`  Result: ${finding.outcome}`);
  }
  return lines;
}

function goalLines(
  goals: readonly ReportGoalSnap[],
  currency: string | null,
): string[] {
  if (goals.length === 0) return [];
  const lines = ["Goals"];
  for (const goal of goals) {
    const label = WEBSITE_GOAL_LABEL[goal.metricKey];
    const target =
      goal.target === null
        ? "no target"
        : `target ${fmt(goal.format, goal.target, currency)}`;
    const forecast =
      goal.forecast === null
        ? ""
        : `, forecast ${fmt(goal.format, goal.forecast, currency)}`;
    lines.push(
      `- ${label}: ${fmt(goal.format, goal.monthToDate, currency)} so far, ${target}${forecast} — ${goal.paceLabel}`,
    );
  }
  return lines;
}

function forecastLines(
  forecasts: readonly ReportForecastSnap[],
  currency: string | null,
): string[] {
  if (forecasts.length === 0) return [];
  const lines = ["Month forecast"];
  for (const forecast of forecasts) {
    const so = fmt(forecast.format, forecast.monthToDate, currency);
    if (forecast.forecast === null) {
      lines.push(
        `- ${forecast.label}: ${so} so far${forecast.note ? ` (${forecast.note})` : ""}`,
      );
      continue;
    }
    const range =
      forecast.low !== null && forecast.high !== null
        ? ` (range ${fmt(forecast.format, forecast.low, currency)}–${fmt(forecast.format, forecast.high, currency)})`
        : "";
    lines.push(
      `- ${forecast.label}: ${so} so far, forecast ${fmt(forecast.format, forecast.forecast, currency)}${range}`,
    );
  }
  return lines;
}

function moverLines(
  title: string,
  movers: readonly {
    page: string;
    sessions: number;
    previousSessions: number;
  }[],
): string[] {
  if (movers.length === 0) return [];
  return [
    title,
    ...movers.map(
      (mover) =>
        `- ${mover.page}: ${formatCount(mover.sessions)} (before: ${formatCount(mover.previousSessions)})`,
    ),
  ];
}

// Bölümler arasına boş satır koyar; boş bölüm atlanır.
function joinSections(sections: readonly (readonly string[])[]): string {
  return sections
    .filter((section) => section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n\n");
}

function headerLines(card: WebsiteReportCardData): string[] {
  const lines = [card.title];
  const meta = [card.propertyName, card.periodLabel].filter(
    (part): part is string => Boolean(part),
  );
  if (meta.length > 0) lines.push(meta.join(" · "));
  if (card.isMock) lines.push("Demo data");
  return lines;
}

function narrativeLines(card: WebsiteReportCardData): string[] {
  const narrative = card.narrative;
  if (!narrative) return card.narrativeNote ? [card.narrativeNote] : [];
  const lines = [WEBSITE_REPORT_COPY.narrativeLabel, narrative.headline];
  for (const item of narrative.highlights) lines.push(`- ${item}`);
  for (const item of narrative.watchouts) lines.push(`- Watch out: ${item}`);
  return lines;
}

function listLines(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [title, ...items.map((item) => `- ${item}`)];
}

function sourceLines(card: WebsiteReportCardData): string[] {
  return [WEBSITE_REPORT_COPY.sourceLine.replace("{tz}", card.timeZone)];
}

export function websiteReportPlainText(card: WebsiteReportCardData): string {
  const body = card.body;
  const currency = card.currency;
  const header = headerLines(card);
  switch (body.variant) {
    case "weekly":
    case "monthly": {
      // snapshotNote en sonda durur; diğer notlar ondan önce.
      const notes = body.notes.filter(
        (note) => note !== WEBSITE_REPORT_COPY.snapshotNote,
      );
      return joinSections([
        header,
        narrativeLines(card),
        kpiLines(body.kpis, card),
        goalLines(body.goals, currency),
        body.variant === "weekly"
          ? forecastLines(body.forecasts, currency)
          : [],
        tableLines("Channels", body.channels, currency),
        moverLines("Pages gaining visits", body.winners),
        moverLines("Pages losing visits", body.losers),
        tableLines("Key events", body.keyEvents, currency),
        body.variant === "weekly"
          ? agentelseLines(body.agentelse, currency)
          : [],
        body.aiAssistants
          ? tableLines("AI assistants", body.aiAssistants, currency)
          : [],
        body.siteSearch
          ? tableLines("Site search", body.siteSearch, currency)
          : [],
        body.variant === "monthly"
          ? tableLines("Top pages", body.topPages, currency)
          : [],
        body.variant === "monthly" && body.paidTraffic
          ? tableLines("Paid traffic", body.paidTraffic, currency)
          : [],
        body.measurement
          ? [
              `Measurement health: ${body.measurement.label}${body.measurement.score === null ? "" : ` (${formatCount(body.measurement.score)}/100)`}, ${body.measurement.issues} ${body.measurement.issues === 1 ? "issue" : "issues"}`,
            ]
          : [],
        findingLines("What changed", body.whatChanged),
        findingLines("Opportunities", body.opportunities),
        body.variant === "monthly" && body.outcomes
          ? [
              `Results of earlier changes: ${body.outcomes.worked} worked, ${body.outcomes.didnt} no clear effect, ${body.outcomes.inconclusive} inconclusive`,
              ...body.outcomes.items.flatMap((item) => [
                `- ${item.title}${item.outcome ? `: ${item.outcome}` : ""}`,
              ]),
            ]
          : [],
        listLines("Next steps", body.nextSteps),
        listLines("Notes", notes),
        sourceLines(card),
        [WEBSITE_REPORT_COPY.snapshotNote],
      ]);
    }
    case "pulse": {
      const kpis = body.kpis.map((kpi) => {
        const usual =
          kpi.usual === null
            ? ""
            : ` (usual ${fmt(kpi.format, kpi.usual, currency)}${kpi.changePct === null ? "" : `, ${signedPercent(kpi.changePct)}`})`;
        return `${kpi.label}: ${fmt(kpi.format, kpi.value, currency)}${usual}${kpi.unusual ? " — unusual" : ""}`;
      });
      return joinSections([
        header,
        listLines("Yesterday", kpis),
        listLines(
          "Channel changes",
          body.changes.map(
            (change) =>
              `${change.channel}: ${formatCount(change.sessions)} (usual ${formatCount(change.usual)})`,
          ),
        ),
        listLines(
          "Open tracking alerts",
          body.alerts.map(
            (alert) =>
              `${alert.title} (${alert.severity === "CRITICAL" ? "critical" : "warning"})`,
          ),
        ),
        findingLines("Anomalies", body.anomalies),
        body.holiday ? [WEBSITE_REPORT_COPY.holidayNote] : [],
        body.suspect ? [WEBSITE_REPORT_COPY.suspectNote] : [],
        sourceLines(card),
        [WEBSITE_REPORT_COPY.snapshotNote],
      ]);
    }
    case "plan": {
      const proposals = body.proposals.map((proposal) => {
        const seasonal =
          proposal.seasonalPct === null
            ? ""
            : `, seasonal ${signedPercent(proposal.seasonalPct)}`;
        return `${proposal.label}: suggested ${fmt(proposal.format, proposal.suggested, currency)} (range ${fmt(proposal.format, proposal.low, currency)}–${fmt(proposal.format, proposal.high, currency)}; baseline ${fmt(proposal.format, proposal.baseline, currency)} from ${proposal.baselineMonths} months${seasonal})`;
      });
      return joinSections([
        header,
        listLines("Suggested targets", proposals),
        body.proposalNote ? [body.proposalNote] : [],
        forecastLines(body.forecasts, currency),
        findingLines("For content and ads", body.topFindings),
        listLines(
          "Best converting pages",
          body.bestPages.map(
            (page) =>
              `${page.page}: ${formatCount(page.sessions)} sessions, ${formatPercent(page.keyEventRate)} key event rate`,
          ),
        ),
        body.channelQuality
          ? tableLines("Channel quality", body.channelQuality, currency)
          : [],
        sourceLines(card),
        [WEBSITE_REPORT_COPY.snapshotNote],
      ]);
    }
    case "alert": {
      return joinSections([
        header,
        [
          body.reconnect
            ? WEBSITE_REPORT_COPY.reconnectBody
            : WEBSITE_REPORT_COPY.alertBody,
        ],
      ]);
    }
  }
}
