import { ANALYTICS_COPY as COPY } from "./copy";
import {
  formatBuiltAt,
  formatCount,
  formatMoney,
  formatPercent,
  formatPosition,
} from "./format";
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
} from "./report";

// The report as something to hand on (docs/modules.md "Analytics" Share): the
// summary as plain text, the whole report as Markdown, and a print-styled HTML
// page for "Save as PDF". All three are built from the stored report alone, so
// a report reads the same later as on the day it was built. Pure: the card
// turns them into a clipboard write, a download and a print.

export type ExportOptions = {
  // The brand's name, on the report's title line.
  brand?: string;
  // The project's timezone, for the build time.
  timeZone?: string;
};

type Table = { columns: string[]; rows: string[][] };

function titleOf(options: ExportOptions): string {
  const brand = options.brand?.replace(/\s+/g, " ").trim();
  return brand ? `${brand} · ${COPY.reportTitle}` : COPY.reportTitle;
}

function metaLineOf(report: ReportData, options: ExportOptions): string {
  const built = formatBuiltAt(report.builtAt, options.timeZone);
  return built
    ? `${periodText(report.period)} · ${COPY.builtAt(built)}`
    : periodText(report.period);
}

function headingOf(section: ReportSection): string {
  return section.ok && section.account
    ? `${sectionTitle(section)} · ${section.account}`
    : sectionTitle(section);
}

function metricName(section: OkSection, index: number): string {
  const metric = section.metrics[index]!;
  return isSnapshotMetric(metric.key)
    ? `${metricLabel(metric.key)} (${COPY.now.toLowerCase()})`
    : metricLabel(metric.key);
}

function tablesOf(
  section: OkSection,
): { title: string | null; table: Table }[] {
  const money = (value: number) => formatMoney(value, section.currency);
  const tables: { title: string | null; table: Table }[] = [
    {
      title: null,
      table: {
        columns: [COPY.metric, COPY.value],
        rows: section.metrics.map((metric, index) => [
          metricName(section, index),
          metricText(metric, section.currency),
        ]),
      },
    },
  ];
  if (section.results.length > 0) {
    tables.push({
      title: COPY.resultsHeading,
      table: {
        columns: [COPY.result, COPY.count, COPY.costPerResult],
        rows: section.results.map((result) => [
          result.label,
          formatCount(result.count),
          result.costPerResult !== null ? money(result.costPerResult) : "—",
        ]),
      },
    });
  }
  if (section.campaigns.length > 0) {
    tables.push({
      title: COPY.campaignsHeading,
      table: {
        columns: [COPY.campaign, COPY.spend, COPY.results, COPY.costPerResult],
        rows: section.campaigns.map((campaign) => [
          campaign.name,
          money(campaign.spend),
          campaign.results !== null && campaign.resultLabel
            ? `${formatCount(campaign.results)} ${campaign.resultLabel}`
            : "—",
          campaign.costPerResult !== null ? money(campaign.costPerResult) : "—",
        ]),
      },
    });
  }
  if (section.queries.length > 0) {
    tables.push({
      title: COPY.queriesHeading,
      table: {
        columns: [
          COPY.search,
          COPY.clicksColumn,
          COPY.impressions,
          COPY.ctr,
          COPY.positionColumn,
        ],
        rows: section.queries.map((query) => [
          query.query,
          formatCount(query.clicks),
          formatCount(query.impressions),
          formatPercent(query.ctr),
          formatPosition(query.position),
        ]),
      },
    });
  }
  return tables;
}

function summaryLists(
  report: ReportData,
): { title: string; items: string[] }[] {
  const summary = report.summary;
  if (!summary) return [];
  return [
    { title: COPY.highlightsHeading, items: summary.highlights },
    { title: COPY.watchoutsHeading, items: summary.watchouts },
    { title: COPY.nextStepsHeading, items: summary.nextSteps },
  ].filter((list) => list.items.length > 0);
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---- Plain text (Copy summary) ----------------------------------------------

export function buildReportPlainText(
  report: ReportData,
  options: ExportOptions = {},
): string {
  const lines: string[] = [titleOf(options), metaLineOf(report, options), ""];
  if (report.summary?.headline) lines.push(flat(report.summary.headline), "");
  for (const list of summaryLists(report)) {
    lines.push(list.title, ...list.items.map((item) => `- ${flat(item)}`), "");
  }
  if (!report.summary && report.summaryNote) {
    lines.push(flat(report.summaryNote), "");
  }
  lines.push(COPY.keyNumbers);
  for (const section of report.sections) {
    if (!section.ok) {
      lines.push(
        `${headingOf(section)}: ${COPY.unavailable(failReasonText(section.reason))}`,
      );
      continue;
    }
    const numbers = section.metrics
      .map(
        (metric, index) =>
          `${metricName(section, index)} ${metricText(metric, section.currency)}`,
      )
      .join(" · ");
    lines.push(
      `${headingOf(section)} (${periodText(section.days)}): ${numbers}`,
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

// ---- Markdown (Download) ----------------------------------------------------

// Text from people and the model, made inert: no emphasis, links, HTML,
// headings or table breaks of its own.
function md(text: string): string {
  return flat(text).replace(/([\\`*_[\]<>#|~!])/g, "\\$1");
}

function mdTable(table: Table): string[] {
  const row = (cells: readonly string[]) => `| ${cells.map(md).join(" | ")} |`;
  return [
    row(table.columns),
    `| ${table.columns.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...table.rows.map(row),
  ];
}

export function buildReportMarkdown(
  report: ReportData,
  options: ExportOptions = {},
): string {
  const lines: string[] = [
    `# ${md(titleOf(options))}`,
    "",
    md(metaLineOf(report, options)),
    "",
    `## ${COPY.summaryEyebrow}`,
    "",
  ];
  if (report.summary) {
    if (report.summary.headline) {
      lines.push(`**${md(report.summary.headline)}**`, "");
    }
    for (const list of summaryLists(report)) {
      lines.push(
        `**${md(list.title)}**`,
        "",
        ...list.items.map((item) => `- ${md(item)}`),
        "",
      );
    }
  } else if (report.summaryNote) {
    lines.push(`_${md(report.summaryNote)}_`, "");
  }
  for (const section of report.sections) {
    lines.push(`## ${md(headingOf(section))}`, "");
    if (!section.ok) {
      lines.push(md(COPY.unavailable(failReasonText(section.reason))), "");
      continue;
    }
    lines.push(md(periodText(section.days)), "");
    for (const { title, table } of tablesOf(section)) {
      if (table.rows.length === 0) continue;
      if (title) lines.push(`### ${md(title)}`, "");
      lines.push(...mdTable(table), "");
    }
    const note = sectionNote(section, report.period);
    if (note) lines.push(`_${md(note)}_`, "");
  }
  lines.push("---", "", md(COPY.onlyNumbers));
  return `${lines.join("\n").trim()}\n`;
}

// "analytics-report-2026-10-05.md"
export function reportFileName(report: ReportData, extension = "md"): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(report.builtAt)?.[0] ?? "report";
  return `analytics-report-${day}.${extension}`;
}

// ---- Print view (Save as PDF) -----------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; background: #fff; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header { border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 0 0 4px; }
h3 { font-size: 12px; margin: 12px 0 6px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; }
.meta, .muted { color: #666; font-size: 12px; margin: 0; }
section { break-inside: avoid; margin: 0 0 18px; }
.headline { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
ul { margin: 0 0 8px; padding-left: 18px; }
li { margin: 0 0 2px; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0; }
.tile { border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; }
.tile b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; }
.tile span { color: #666; font-size: 11px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 12px; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; }
th { color: #555; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
footer { border-top: 1px solid #ddd; padding-top: 10px; color: #666; font-size: 11px; }
`;

function htmlTable(table: Table): string {
  const cell = (tag: "th" | "td", text: string, index: number) =>
    `<${tag}${index === 0 ? "" : ' class="num"'}>${escapeHtml(text)}</${tag}>`;
  return [
    "<table><thead><tr>",
    table.columns.map((column, index) => cell("th", column, index)).join(""),
    "</tr></thead><tbody>",
    table.rows
      .map(
        (row) =>
          `<tr>${row.map((text, index) => cell("td", text, index)).join("")}</tr>`,
      )
      .join(""),
    "</tbody></table>",
  ].join("");
}

function htmlSection(section: ReportSection, report: ReportData): string {
  const parts = [`<section><h2>${escapeHtml(headingOf(section))}</h2>`];
  if (!section.ok) {
    parts.push(
      `<p class="muted">${escapeHtml(COPY.unavailable(failReasonText(section.reason)))}</p></section>`,
    );
    return parts.join("");
  }
  parts.push(`<p class="muted">${escapeHtml(periodText(section.days))}</p>`);
  parts.push('<div class="tiles">');
  section.metrics.forEach((metric, index) => {
    parts.push(
      `<div class="tile"><b>${escapeHtml(metricText(metric, section.currency))}</b><span>${escapeHtml(metricName(section, index))}</span></div>`,
    );
  });
  parts.push("</div>");
  for (const { title, table } of tablesOf(section).slice(1)) {
    if (table.rows.length === 0) continue;
    if (title) parts.push(`<h3>${escapeHtml(title)}</h3>`);
    parts.push(htmlTable(table));
  }
  const note = sectionNote(section, report.period);
  if (note) parts.push(`<p class="muted">${escapeHtml(note)}</p>`);
  parts.push("</section>");
  return parts.join("");
}

export function buildReportPrintHtml(
  report: ReportData,
  options: ExportOptions = {},
): string {
  const title = titleOf(options);
  const summary: string[] = [
    `<section><h3>${escapeHtml(COPY.summaryEyebrow)}</h3>`,
  ];
  if (report.summary) {
    if (report.summary.headline) {
      summary.push(
        `<p class="headline">${escapeHtml(report.summary.headline)}</p>`,
      );
    }
    for (const list of summaryLists(report)) {
      summary.push(
        `<h3>${escapeHtml(list.title)}</h3><ul>${list.items
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul>`,
      );
    }
  } else if (report.summaryNote) {
    summary.push(`<p class="muted">${escapeHtml(report.summaryNote)}</p>`);
  }
  summary.push("</section>");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PRINT_CSS}</style></head><body>`,
    `<header><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(metaLineOf(report, options))}</p></header>`,
    summary.join(""),
    report.sections.map((section) => htmlSection(section, report)).join(""),
    `<footer>${escapeHtml(COPY.onlyNumbers)}</footer>`,
    "</body></html>",
  ].join("");
}
