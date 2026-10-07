import { formatMetric } from "@/lib/module-flows/analytics/format";
import { escapeHtml } from "@/lib/module-flows/analytics/export";

import { WEBSITE_REPORT_COPY } from "./copy";
import type {
  AlertBody,
  MonthlyBody,
  PeriodReportSections,
  PlanBody,
  PulseBody,
  ReportFindingSnap,
  ReportForecastSnap,
  ReportGoalSnap,
  ReportAgentelseSection,
  ReportMover,
  ReportTable,
  ReportValueFormat,
  WebsiteReportCardData,
  WeeklyBody,
} from "./types";

// Rapor kartının dışa aktarımı (docs/website-reports.md "Dışa aktarma"):
// Markdown, yazdırma HTML'i ve dosya adı. Hepsi yalnız SAKLI karttan kurulur,
// bu yüzden bir rapor yıllar sonra da gönderildiği gün gibi okunur. Düz metin
// (Copy) P2'nin text.ts'inde. Saf ve izomorfik.

export type ReportExportOptions = { brand?: string | null };

// Weekly, monthly ve plan dışa aktarılır; pulse ve alert yalnız kopyalanır.
export function isExportableReport(card: WebsiteReportCardData): boolean {
  return (
    card.variant === "weekly" ||
    card.variant === "monthly" ||
    card.variant === "plan"
  );
}

// ---- Ara gösterim -----------------------------------------------------------

// Markdown ve HTML aynı bloklardan üretilir; böylece iki çıktı hiç ayrışmaz.
type Block =
  | { t: "h2"; text: string }
  | { t: "h3"; text: string }
  | { t: "p"; text: string; muted?: boolean }
  | { t: "ul"; items: string[] }
  | { t: "table"; columns: string[]; rows: string[][] };

type Doc = {
  title: string;
  meta: string;
  brand: string | null;
  blocks: Block[];
  footer: string[];
};

const DASH = "—";

function valueText(
  format: ReportValueFormat,
  value: number | null,
  currency: string | null,
): string {
  return value === null ? DASH : formatMetric(format, value, currency);
}

function changeText(pct: number | null): string {
  if (pct === null) return DASH;
  return `${pct > 0 ? "+" : ""}${formatMetric("percent", pct, null)}`;
}

function sinceText(
  format: ReportValueFormat,
  value: number | null,
  pct: number | null,
  currency: string | null,
): string {
  if (value === null) return DASH;
  return pct === null
    ? valueText(format, value, currency)
    : `${valueText(format, value, currency)} (${changeText(pct)})`;
}

function cellText(
  column: { label: string; format: ReportValueFormat },
  value: number | null,
  currency: string | null,
): string {
  if (value === null) return DASH;
  // "Change" sütunu işaretli okunur: +12.5%.
  if (column.label === "Change" && column.format === "percent") {
    return changeText(value);
  }
  return valueText(column.format, value, currency);
}

function tableBlocks(
  title: string | null,
  firstColumn: string,
  table: ReportTable | null,
  currency: string | null,
): Block[] {
  if (!table || (table.rows.length === 0 && table.other === null)) return [];
  const blocks: Block[] = [];
  if (title) blocks.push({ t: "h3", text: title });
  const rows = table.rows.map((row) => [
    row.label,
    ...table.columns.map((column, index) =>
      cellText(column, row.values[index] ?? null, currency),
    ),
  ]);
  if (table.other) {
    const other = table.other;
    rows.push([
      "Other",
      ...table.columns.map((column, index) =>
        cellText(column, other[index] ?? null, currency),
      ),
    ]);
  }
  blocks.push({
    t: "table",
    columns: [firstColumn, ...table.columns.map((column) => column.label)],
    rows,
  });
  for (const note of table.notes)
    blocks.push({ t: "p", text: note, muted: true });
  return blocks;
}

function moverBlocks(title: string, movers: readonly ReportMover[]): Block[] {
  if (movers.length === 0) return [];
  return [
    { t: "h3", text: title },
    {
      t: "table",
      columns: ["Page", "Sessions", "Previous", "Change", "Key events"],
      rows: movers.map((row) => [
        row.page,
        formatMetric("count", row.sessions, null),
        formatMetric("count", row.previousSessions, null),
        changeText(row.changePct),
        formatMetric("count", row.keyEvents, null),
      ]),
    },
  ];
}

function findingItem(finding: ReportFindingSnap): string {
  const parts = [finding.title];
  if (finding.detail) parts.push(`${DASH} ${finding.detail}`);
  let text = parts.join(" ");
  if (finding.impact) text += ` Impact: ${finding.impact}.`;
  if (finding.explanation) text += ` ${finding.explanation}`;
  return `${text} (${finding.confidence}, ${finding.period})`;
}

function findingBlocks(
  title: string,
  findings: readonly ReportFindingSnap[],
): Block[] {
  if (findings.length === 0) return [];
  return [
    { t: "h3", text: title },
    { t: "ul", items: findings.map(findingItem) },
  ];
}

function goalItem(goal: ReportGoalSnap, currency: string | null): string {
  const format: ReportValueFormat = goal.format;
  const text = (value: number | null) => valueText(format, value, currency);
  const parts: string[] = [];
  if (goal.final) {
    parts.push(`result ${text(goal.monthToDate)}`);
  } else {
    parts.push(`${text(goal.monthToDate)} so far`);
    if (goal.forecast !== null) {
      const range =
        goal.low !== null && goal.high !== null
          ? ` (${text(goal.low)}${"–"}${text(goal.high)})`
          : "";
      parts.push(`forecast ${text(goal.forecast)}${range}`);
    }
  }
  parts.push(`target ${text(goal.target)}`);
  parts.push(goal.paceLabel);
  return `${goal.title}: ${parts.join(" · ")}`;
}

function forecastItem(
  forecast: ReportForecastSnap,
  currency: string | null,
): string {
  const format: ReportValueFormat = forecast.format;
  const text = (value: number | null) => valueText(format, value, currency);
  let line = `${forecast.label}: ${text(forecast.monthToDate)} so far`;
  if (forecast.forecast !== null) {
    line += `, forecast ${text(forecast.forecast)}`;
    if (forecast.low !== null && forecast.high !== null) {
      line += ` (${text(forecast.low)}${"–"}${text(forecast.high)})`;
    }
  } else if (forecast.note) {
    line += `. ${forecast.note}`;
  }
  return line;
}

function narrativeBlocks(card: WebsiteReportCardData): Block[] {
  const narrative = card.narrative;
  if (!narrative) {
    return card.narrativeNote
      ? [{ t: "p", text: card.narrativeNote, muted: true }]
      : [];
  }
  const blocks: Block[] = [
    { t: "h2", text: "Summary" },
    { t: "p", text: "AI, checked against the numbers", muted: true },
  ];
  if (narrative.headline) blocks.push({ t: "p", text: narrative.headline });
  if (narrative.highlights.length > 0) {
    blocks.push({ t: "ul", items: narrative.highlights });
  }
  if (narrative.watchouts.length > 0) {
    blocks.push({ t: "h3", text: "Watch-outs" });
    blocks.push({ t: "ul", items: narrative.watchouts });
  }
  return blocks;
}

function kpiBlocks(
  kpis: PeriodReportSections["kpis"],
  currency: string | null,
): Block[] {
  if (kpis.length === 0) return [];
  return [
    { t: "h2", text: "Key numbers" },
    {
      t: "table",
      columns: ["Metric", "This period", "Previous", "Change", "Last year"],
      rows: kpis.map((kpi) => [
        kpi.label,
        valueText(kpi.format, kpi.value, currency),
        valueText(kpi.format, kpi.previous, currency),
        changeText(kpi.changePct),
        sinceText(kpi.format, kpi.lastYear, kpi.lastYearChangePct, currency),
      ]),
    },
  ];
}

// GA-F6: "From Agentelse" bölümü; yalnız haftalık gövdede ve doluysa bulunur.
function agentelseBlocks(
  section: ReportAgentelseSection | undefined,
  currency: string | null,
): Block[] {
  if (!section) return [];
  const parts = [
    ...tableBlocks("Tracked links", "Source", section.tracked, currency),
    ...tableBlocks(
      "Your ads on your website",
      "Campaign",
      section.ads,
      currency,
    ),
    ...tableBlocks("Google Ads", "Campaign", section.googleAds, currency),
  ];
  if (parts.length === 0) return [];
  const blocks: Block[] = [{ t: "h2", text: "From Agentelse" }, ...parts];
  if (section.notes.length > 0) {
    blocks.push({ t: "ul", items: [...section.notes] });
  }
  return blocks;
}

// Haftalık ve aylık raporun ortak gövdesi.
function periodBlocks(
  card: WebsiteReportCardData,
  body: WeeklyBody | MonthlyBody,
): Block[] {
  const currency = card.currency;
  const blocks: Block[] = [
    ...narrativeBlocks(card),
    ...kpiBlocks(body.kpis, currency),
    ...tableBlocks("Channels", "Channel", body.channels, currency),
    ...moverBlocks("Landing pages up", body.winners),
    ...moverBlocks("Landing pages down", body.losers),
    ...tableBlocks("Key events", "Key event", body.keyEvents, currency),
    ...(body.variant === "weekly"
      ? agentelseBlocks(body.agentelse, currency)
      : []),
    ...tableBlocks("AI assistants", "Assistant", body.aiAssistants, currency),
    ...tableBlocks("Site search", "Search term", body.siteSearch, currency),
  ];
  if (body.variant === "monthly") {
    blocks.push(
      ...tableBlocks("Top pages", "Page", body.topPages, currency),
      ...tableBlocks("Paid traffic", "Source", body.paidTraffic, currency),
    );
  }
  if (body.measurement) {
    const m = body.measurement;
    const score = m.score === null ? "" : ` (${m.score}/100)`;
    const issues =
      m.issues === 0
        ? "no open issues"
        : `${m.issues} open ${m.issues === 1 ? "issue" : "issues"}${
            m.critical > 0 ? `, ${m.critical} critical` : ""
          }`;
    blocks.push(
      { t: "h2", text: "Measurement health" },
      { t: "p", text: `${m.label}${score}: ${issues}.` },
    );
  }
  if (body.insights === "pending") {
    blocks.push({
      t: "p",
      text: WEBSITE_REPORT_COPY.insightsPending,
      muted: true,
    });
  }
  blocks.push(
    ...findingBlocks("What changed", body.whatChanged),
    ...findingBlocks("Opportunities", body.opportunities),
  );
  if (body.variant === "monthly" && body.outcomes) {
    const o = body.outcomes;
    blocks.push({ t: "h3", text: "Results of earlier findings" });
    blocks.push({
      t: "p",
      text: `${o.worked} worked, ${o.didnt} didn't, ${o.inconclusive} inconclusive.`,
    });
    if (o.items.length > 0) {
      blocks.push({ t: "ul", items: o.items.map(findingItem) });
    }
  }
  if (body.goals.length > 0) {
    blocks.push(
      { t: "h2", text: "Goals" },
      { t: "ul", items: body.goals.map((goal) => goalItem(goal, currency)) },
    );
  }
  if (body.variant === "weekly" && body.forecasts.length > 0) {
    blocks.push(
      { t: "h3", text: "Month-end forecast" },
      {
        t: "ul",
        items: body.forecasts.map((row) => forecastItem(row, currency)),
      },
    );
  }
  if (body.nextSteps.length > 0) {
    blocks.push(
      { t: "h2", text: "Next steps" },
      { t: "ul", items: [...body.nextSteps] },
    );
  }
  return blocks;
}

function planBlocks(card: WebsiteReportCardData, body: PlanBody): Block[] {
  const currency = card.currency;
  const blocks: Block[] = [];
  if (body.proposals.length > 0) {
    blocks.push(
      { t: "h2", text: "Suggested targets" },
      {
        t: "table",
        columns: [
          "Metric",
          "Last 3 months",
          "Seasonal",
          "Suggested",
          "Range",
          "Current target",
        ],
        rows: body.proposals.map((row) => {
          const text = (value: number | null) =>
            valueText(row.format, value, currency);
          return [
            row.label,
            text(row.baseline),
            row.seasonalPct === null ? DASH : changeText(row.seasonalPct),
            text(row.suggested),
            `${text(row.low)}–${text(row.high)}`,
            text(row.currentGoal?.target ?? null),
          ];
        }),
      },
      {
        t: "p",
        text: "Last 3 months is the average of the latest full months, scaled to the days of the target month.",
        muted: true,
      },
    );
  } else if (body.proposalNote) {
    blocks.push({ t: "p", text: body.proposalNote });
  }
  blocks.push(...findingBlocks("Top opportunities", body.topFindings));
  if (body.bestPages.length > 0 || body.channelQuality) {
    blocks.push({ t: "h2", text: "For content and ads" });
    if (body.bestPages.length > 0) {
      blocks.push({
        t: "table",
        columns: ["Page", "Sessions", "Key events", "Key event rate"],
        rows: body.bestPages.map((page) => [
          page.page,
          formatMetric("count", page.sessions, null),
          formatMetric("count", page.keyEvents, null),
          formatMetric("percent", page.keyEventRate, null),
        ]),
      });
    }
    blocks.push(...tableBlocks(null, "Channel", body.channelQuality, currency));
  }
  if (body.forecasts.length > 0) {
    blocks.push(
      { t: "h3", text: "Month-end forecast" },
      {
        t: "ul",
        items: body.forecasts.map((row) => forecastItem(row, currency)),
      },
    );
  }
  return blocks;
}

function pulseBlocks(card: WebsiteReportCardData, body: PulseBody): Block[] {
  const currency = card.currency;
  const blocks: Block[] = [];
  if (body.kpis.length > 0) {
    blocks.push({
      t: "table",
      columns: ["Metric", "Value", "Usual", "Change"],
      rows: body.kpis.map((kpi) => [
        kpi.unusual ? `${kpi.label} (unusual)` : kpi.label,
        valueText(kpi.format, kpi.value, currency),
        valueText(kpi.format, kpi.usual, currency),
        changeText(kpi.changePct),
      ]),
    });
  }
  if (body.changes.length > 0) {
    blocks.push({
      t: "ul",
      items: body.changes.map(
        (row) =>
          `${row.channel}: ${formatMetric("count", row.sessions, null)} sessions, usual ${formatMetric("count", row.usual, null)}`,
      ),
    });
  }
  if (body.alerts.length > 0) {
    blocks.push(
      { t: "h3", text: "Open tracking alerts" },
      {
        t: "ul",
        items: body.alerts.map(
          (alert) =>
            `${alert.title} (${alert.severity === "CRITICAL" ? "critical" : "warning"}${alert.isNew ? ", new" : ""})`,
        ),
      },
    );
  }
  blocks.push(...findingBlocks("Unusual signals", body.anomalies));
  if (body.holiday) {
    blocks.push({ t: "p", text: WEBSITE_REPORT_COPY.holidayNote, muted: true });
  }
  if (body.suspect) {
    blocks.push({ t: "p", text: WEBSITE_REPORT_COPY.suspectNote, muted: true });
  }
  return blocks;
}

function alertBlocks(body: AlertBody): Block[] {
  return [
    {
      t: "p",
      text: body.reconnect
        ? WEBSITE_REPORT_COPY.reconnectBody
        : WEBSITE_REPORT_COPY.alertBody,
    },
    { t: "p", text: `Opened ${body.openedAt.slice(0, 10)}.`, muted: true },
  ];
}

function metaLineOf(card: WebsiteReportCardData): string {
  const parts: string[] = [];
  if (card.propertyName) parts.push(card.propertyName);
  parts.push(card.periodLabel);
  parts.push(`Google Analytics, property time (${card.timeZone})`);
  if (card.isMock) parts.push("Demo data");
  return parts.join(" · ");
}

function docOf(card: WebsiteReportCardData, options: ReportExportOptions): Doc {
  const body = card.body;
  let blocks: Block[];
  switch (body.variant) {
    case "weekly":
    case "monthly":
      blocks = periodBlocks(card, body);
      break;
    case "plan":
      blocks = planBlocks(card, body);
      break;
    case "pulse":
      blocks = pulseBlocks(card, body);
      break;
    case "alert":
      blocks = alertBlocks(body);
      break;
  }
  // Rapor notları gövdeden sonra; kart ek not taşımıyorsa boş kalır.
  const notes =
    body.variant === "weekly" || body.variant === "monthly" ? body.notes : [];
  if (notes.length > 0) {
    blocks.push({ t: "h3", text: "Notes" }, { t: "ul", items: [...notes] });
  }
  const footer: string[] = [WEBSITE_REPORT_COPY.snapshotNote];
  if (
    card.preliminary &&
    !notes.includes(WEBSITE_REPORT_COPY.preliminaryNote)
  ) {
    footer.push(WEBSITE_REPORT_COPY.preliminaryNote);
  }
  const brand = options.brand?.replace(/\s+/g, " ").trim();
  return {
    title: card.title,
    meta: metaLineOf(card),
    brand: brand ? brand : null,
    blocks,
    footer,
  };
}

// ---- Markdown -----------------------------------------------------------------

// Satır sonları tek boşluğa iner; "<" kaçırılır ki Google'dan gelen metin
// Markdown görüntüleyicide ham HTML olmasın.
function mdText(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/</g, "\\<");
}

function mdCell(text: string): string {
  return mdText(text).replace(/\|/g, "\\|");
}

function markdownOf(doc: Doc): string {
  const lines: string[] = [`# ${mdText(doc.title)}`, "", mdText(doc.meta)];
  if (doc.brand) lines.push("", `Prepared for ${mdText(doc.brand)}`);
  for (const block of doc.blocks) {
    lines.push("");
    switch (block.t) {
      case "h2":
        lines.push(`## ${mdText(block.text)}`);
        break;
      case "h3":
        lines.push(`### ${mdText(block.text)}`);
        break;
      case "p": {
        const text = mdText(block.text);
        lines.push(block.muted && !text.includes("*") ? `*${text}*` : text);
        break;
      }
      case "ul":
        lines.push(...block.items.map((item) => `- ${mdText(item)}`));
        break;
      case "table":
        lines.push(
          `| ${block.columns.map(mdCell).join(" | ")} |`,
          `| ${block.columns.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
          ...block.rows.map((row) => `| ${row.map(mdCell).join(" | ")} |`),
        );
        break;
    }
  }
  lines.push("", "---", "");
  for (const text of doc.footer) lines.push(mdText(text), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function websiteReportMarkdown(
  card: WebsiteReportCardData,
  options: ReportExportOptions = {},
): string {
  return markdownOf(docOf(card, options));
}

// ---- Yazdırma HTML'i ----------------------------------------------------------

const PRINT_CSS = `
@page { size: A4; margin: 16mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; background: #fff; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header { border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 18px 0 4px; }
h3 { font-size: 12px; margin: 12px 0 6px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; }
.meta, .muted { color: #666; font-size: 12px; margin: 0 0 6px; }
p { margin: 0 0 6px; }
ul { margin: 0 0 8px; padding-left: 18px; }
li { margin: 0 0 2px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 12px; break-inside: avoid; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; }
th { color: #555; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
footer { border-top: 1px solid #ddd; padding-top: 10px; margin-top: 18px; color: #666; font-size: 11px; }
footer p { margin: 0 0 2px; }
`;

function htmlBlock(block: Block): string {
  switch (block.t) {
    case "h2":
      return `<h2>${escapeHtml(block.text)}</h2>`;
    case "h3":
      return `<h3>${escapeHtml(block.text)}</h3>`;
    case "p":
      return `<p${block.muted ? ' class="muted"' : ""}>${escapeHtml(block.text)}</p>`;
    case "ul":
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "table": {
      const cell = (tag: "th" | "td", text: string, index: number) =>
        `<${tag}${index === 0 ? "" : ' class="num"'}>${escapeHtml(text)}</${tag}>`;
      return [
        "<table><thead><tr>",
        block.columns.map((text, index) => cell("th", text, index)).join(""),
        "</tr></thead><tbody>",
        block.rows
          .map(
            (row) =>
              `<tr>${row.map((text, index) => cell("td", text, index)).join("")}</tr>`,
          )
          .join(""),
        "</tbody></table>",
      ].join("");
    }
  }
}

export function websiteReportPrintHtml(
  card: WebsiteReportCardData,
  options: ReportExportOptions = {},
): string {
  const doc = docOf(card, options);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(doc.title)}</title>`,
    `<style>${PRINT_CSS}</style></head><body>`,
    `<header><h1>${escapeHtml(doc.title)}</h1><p class="meta">${escapeHtml(doc.meta)}</p>`,
    doc.brand
      ? `<p class="meta">${escapeHtml(`Prepared for ${doc.brand}`)}</p>`
      : "",
    "</header>",
    doc.blocks.map(htmlBlock).join(""),
    `<footer>${doc.footer.map((text) => `<p>${escapeHtml(text)}</p>`).join("")}</footer>`,
    "</body></html>",
  ].join("");
}

// ---- Dosya adı ----------------------------------------------------------------

// Yalnız ASCII: gün ve ay anahtarları dışındaki her şey elenir.
function safePart(value: string, fallback: string): string {
  const clean = value.replace(/[^0-9A-Za-z-]/g, "");
  return clean || fallback;
}

export function websiteReportFileName(
  card: WebsiteReportCardData,
  extension = "md",
): string {
  const ext = safePart(extension, "md");
  const body = card.body;
  switch (body.variant) {
    case "weekly":
      return `website-report-weekly-${safePart(body.from, "report")}.${ext}`;
    case "monthly":
      return `website-report-${safePart(body.month, "report")}.${ext}`;
    case "plan":
      return `website-plan-${safePart(body.month, "plan")}.${ext}`;
    case "pulse":
      return `website-pulse-${safePart(body.day, "report")}.${ext}`;
    case "alert": {
      const day = /^\d{4}-\d{2}-\d{2}/.exec(body.openedAt)?.[0];
      const fallback = /^\d{4}-\d{2}-\d{2}/.exec(card.builtAt)?.[0] ?? "report";
      return `website-alert-${day ?? fallback}.${ext}`;
    }
  }
}
