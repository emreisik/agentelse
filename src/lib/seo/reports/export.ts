import { escapeHtml } from "@/lib/module-flows/analytics/export";
import { formatCount, formatPosition } from "@/lib/module-flows/analytics/format";

import { kpiChangePct } from "./kpis";
import {
  DIAGNOSE_CAUSE,
  KPI_LABEL,
  SEO_REPORT_COPY as COPY,
  VERDICT_LABEL,
  changeText,
  changeTextFromRatio,
  dayLabel,
  kpiValueText,
  monthLabel,
} from "./text";
import type {
  SearchDiagnosis,
  SeoReportActions,
  SeoReportHealth,
  SeoReportPulse,
  SeoReportRow,
  SeoReportSection,
  SeoReportView,
  SeoRoadmapItem,
} from "./types";

// Raporu elden vermek için (docs/search-reports.md "Dışa aktarma"): Markdown,
// düz metin ve "PDF olarak kaydet" için baskı HTML'i. Üçü de saklanan
// görünümden üretilir; bir rapor sonradan da yazıldığı gün gibi okunur. Üç
// çıktı tek bir blok listesinden çizilir, böylece içerikleri aynıdır. Saf ve
// izomorfik; arayüz bunları panoya yazma, indirme ve yazdırmaya çevirir.

export type SeoExportOptions = {
  // Markanın adı, başlık satırında.
  brand?: string;
};

type Block =
  | { t: "h"; level: 1 | 2 | 3; text: string }
  | { t: "p"; text: string; style?: "bold" | "italic" | "muted" }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "table"; columns: string[]; rows: string[][] }
  | { t: "footer"; text: string };

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// İşaretli sayı farkı: +30, −12, 0.
function signedCount(delta: number): string {
  if (delta > 0) return `+${formatCount(delta)}`;
  if (delta < 0) return `−${formatCount(-delta)}`;
  return "0";
}

function orDash(value: number | null, format: (n: number) => string): string {
  return value === null ? "—" : format(value);
}

function titleOf(view: SeoReportView, options: SeoExportOptions): string {
  const brand = options.brand ? flat(options.brand) : "";
  return brand ? `${brand} · ${view.title}` : view.title;
}

function metaOf(view: SeoReportView): string {
  const { snapshot } = view;
  const parts = [snapshot.period.label, snapshot.site.label];
  if (view.isMock) parts.push(COPY.sampleBadge);
  return parts.join(" · ");
}

function statusOf(view: SeoReportView, id: string, fallback: string): string {
  return view.findingStatus?.[id] ?? fallback;
}

// ---- Bölüm blokları -------------------------------------------------------

function kpiBlocks(
  view: SeoReportView,
  section: Extract<SeoReportSection, { type: "kpis" }>,
): Block[] {
  return [
    { t: "h", level: 2, text: COPY.keyNumbers },
    {
      t: "table",
      columns: [
        "Metric",
        view.snapshot.period.label,
        section.compareLabel,
        "Change",
        section.yearAgoLabel ?? "Last year",
      ],
      rows: section.kpis.map((kpi) => [
        kpi.label,
        kpiValueText(kpi),
        kpiValueText(kpi, "previous"),
        changeText(kpiChangePct(kpi, "previous")),
        kpiValueText(kpi, "yearAgo"),
      ]),
    },
  ];
}

function tableBlocks(
  section: Extract<SeoReportSection, { type: "table" }>,
): Block[] {
  const { table } = section;
  if (table.rows.length === 0) return [];
  const page = table.aggregation === "By page";
  const cells = (row: SeoReportRow) => [
    row.label,
    formatCount(row.clicks),
    signedCount(row.clicks - row.previousClicks),
    formatCount(row.impressions),
    orDash(row.position, formatPosition),
  ];
  return [
    { t: "h", level: 2, text: table.title },
    { t: "p", text: table.aggregation, style: "muted" },
    {
      t: "table",
      columns: [
        page ? "Page" : "Query",
        "Clicks",
        "Change",
        "Impressions",
        "Position",
      ],
      rows: table.rows.map(cells),
    },
  ];
}

function pulseBlocks(pulse: SeoReportPulse): Block[] {
  const metric = KPI_LABEL[pulse.metric];
  const items = [
    `${metric} on ${dayLabel(pulse.day)}: ${formatCount(pulse.value)}${
      pulse.usual === null
        ? ""
        : ` (usual ${formatCount(pulse.usual)}, ${changeTextFromRatio(pulse.changePct)})`
    }`,
  ];
  if (pulse.biggest) {
    items.push(
      `Biggest ${pulse.biggest.dimension} change: ${pulse.biggest.key} had ${formatCount(pulse.biggest.value)} clicks (usual ${formatCount(pulse.biggest.usual)})`,
    );
  }
  if (pulse.newCritical > 0 || pulse.openCritical > 0) {
    items.push(
      `Critical alerts: ${pulse.newCritical} new, ${pulse.openCritical} open`,
    );
  }
  return [
    { t: "h", level: 2, text: COPY.pulseHeading },
    { t: "ul", items },
  ];
}

function healthBlocks(health: SeoReportHealth): Block[] {
  const items: string[] = [];
  items.push(
    health.score === null
      ? "Search health score: not available yet"
      : `Search health score: ${formatCount(health.score)} out of 100${
          health.cappedByCritical ? " (capped by a critical issue)" : ""
        }`,
  );
  items.push(`${health.critical} critical, ${health.warn} warnings`);
  for (const issue of health.issues)
    items.push(`${issue.severity}: ${issue.title}`);
  if (health.coverage) {
    const pct = (value: number) => `${Math.round(value * 100)}%`;
    items.push(
      `Pages indexed by Google: about ${pct(health.coverage.point)} (${pct(health.coverage.low)}–${pct(health.coverage.high)})`,
    );
  }
  if (health.cwv) {
    items.push(
      `Core Web Vitals: phone ${health.cwv.phone ?? "—"}, desktop ${health.cwv.desktop ?? "—"}`,
    );
  }
  return [
    { t: "h", level: 2, text: COPY.healthHeading },
    { t: "ul", items },
  ];
}

function opportunityBlocks(
  view: SeoReportView,
  section: Extract<SeoReportSection, { type: "opportunities" }>,
): Block[] {
  if (section.items.length === 0) return [];
  return [
    { t: "h", level: 2, text: COPY.opportunitiesHeading },
    {
      t: "ul",
      items: section.items.map((item) => {
        const effect =
          item.impactPerMonth !== null
            ? `about ${formatCount(item.impactPerMonth)} clicks a month`
            : item.reachPerMonth !== null
              ? `reach about ${formatCount(item.reachPerMonth)} impressions a month`
              : null;
        const parts = [
          item.action,
          effect,
          item.confidence,
          item.effort ? `${item.effort} effort` : null,
          statusOf(view, item.id, item.status),
        ].filter((part): part is string => Boolean(part));
        return `${item.title} (${parts.join(" · ")})`;
      }),
    },
  ];
}

function actionBlocks(actions: SeoReportActions): Block[] {
  const blocks: Block[] = [
    { t: "h", level: 2, text: COPY.actionsHeading },
    {
      t: "p",
      text: `Accepted ${actions.accepted} · Done ${actions.done} · Evaluated ${actions.evaluated}`,
    },
  ];
  if (actions.items.length > 0) {
    blocks.push({
      t: "ul",
      items: actions.items.map(
        (item) =>
          `${item.title} (${item.status}${item.outcome ? `: ${item.outcome}` : ""})`,
      ),
    });
  }
  return blocks;
}

function updateBlocks(
  section: Extract<SeoReportSection, { type: "updates" }>,
): Block[] {
  if (section.items.length === 0) return [];
  return [
    { t: "h", level: 2, text: COPY.updatesHeading },
    {
      t: "ul",
      items: section.items.map((item) => {
        const started = dayLabel(item.startedAt.slice(0, 10));
        const span = item.endedAt
          ? `${started} – ${dayLabel(item.endedAt.slice(0, 10))}`
          : `since ${started}`;
        return `${item.name} (${item.kind}, ${span})`;
      }),
    },
  ];
}

function diagnosisBlocks(diagnosis: SearchDiagnosis): Block[] {
  const metric = KPI_LABEL[diagnosis.metric];
  const blocks: Block[] = [
    { t: "h", level: 2, text: COPY.diagnosisHeading },
    {
      t: "p",
      text: `${metric}: ${formatCount(diagnosis.current)} against ${formatCount(diagnosis.previous)} (${changeTextFromRatio(diagnosis.changePct)}).${
        diagnosis.primary
          ? ` Most likely cause: ${DIAGNOSE_CAUSE[diagnosis.primary]}.`
          : ""
      }`,
    },
    {
      t: "ol",
      items: diagnosis.steps.map((step) => {
        const evidence =
          step.evidence.length > 0 ? ` ${step.evidence.join(" ")}` : "";
        return `${step.question} ${VERDICT_LABEL[step.verdict]}.${evidence}`;
      }),
    },
  ];
  if (diagnosis.askUser.length > 0) {
    blocks.push(
      { t: "h", level: 3, text: COPY.checkInSearchConsole },
      {
        t: "ul",
        items: diagnosis.askUser.map((ask) => `${ask.screen}: ${ask.text}`),
      },
    );
  }
  return blocks;
}

function goalBlocks(
  section: Extract<SeoReportSection, { type: "goals" }>,
): Block[] {
  if (section.goals.length === 0) return [];
  return [
    { t: "h", level: 2, text: COPY.goalsHeading },
    {
      t: "table",
      columns: ["Goal", "Target", "Now", "Pace"],
      rows: section.goals.map((goal) => [
        goal.title,
        orDash(goal.target, formatCount),
        orDash(goal.current, formatCount),
        goal.paceLabel,
      ]),
    },
  ];
}

function forecastBlocks(
  section: Extract<SeoReportSection, { type: "forecast" }>,
): Block[] {
  const { forecast } = section;
  const blocks: Block[] = [
    {
      t: "h",
      level: 2,
      text: `${COPY.forecastHeading}: ${monthLabel(forecast.month)}`,
    },
    {
      t: "p",
      text: `About ${formatCount(forecast.value)} (${formatCount(forecast.low)}–${formatCount(forecast.high)}), ${forecast.method}; ${COPY.directional}. ${KPI_LABEL[forecast.metric]}.`,
    },
  ];
  if (forecast.newContent) {
    blocks.push({
      t: "p",
      text: `New content: ${formatCount(forecast.newContent.clicks)} clicks from ${formatCount(forecast.newContent.pages)} pages (${COPY.directional}).`,
      style: "muted",
    });
  }
  return blocks;
}

function contentBlocks(
  section: Extract<SeoReportSection, { type: "content" }>,
): Block[] {
  if (section.items.length === 0) return [];
  return [
    { t: "h", level: 2, text: section.title },
    {
      t: "ul",
      items: section.items.map(
        (item) => `${dayLabel(item.date)}: ${item.title} (${item.status})`,
      ),
    },
  ];
}

function roadmapLine(view: SeoReportView, item: SeoRoadmapItem): string {
  const parts = [
    item.action,
    item.severity,
    item.impactPerMonth !== null
      ? `about ${formatCount(item.impactPerMonth)} clicks a month`
      : null,
    item.effort ? `${item.effort} effort` : null,
    item.count !== null ? `${formatCount(item.count)} pages` : null,
    item.findingId ? statusOf(view, item.findingId, "") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${item.title} (${parts.join(" · ")})` : item.title;
}

function roadmapBlocks(
  view: SeoReportView,
  section: Extract<SeoReportSection, { type: "roadmap" }>,
): Block[] {
  const blocks: Block[] = [];
  if (section.actions.length > 0) {
    blocks.push(
      { t: "h", level: 2, text: COPY.roadmapActionsHeading },
      {
        t: "ol",
        items: section.actions.map((item) => roadmapLine(view, item)),
      },
    );
  }
  if (section.techDebt.length > 0) {
    blocks.push(
      { t: "h", level: 2, text: COPY.roadmapDebtHeading },
      {
        t: "ul",
        items: section.techDebt.map((item) => roadmapLine(view, item)),
      },
    );
  }
  return blocks;
}

function sectionBlocks(
  view: SeoReportView,
  section: SeoReportSection,
): Block[] {
  switch (section.type) {
    case "kpis":
      return kpiBlocks(view, section);
    case "table":
      return tableBlocks(section);
    case "pulse":
      return pulseBlocks(section.pulse);
    case "health":
      return healthBlocks(section.health);
    case "opportunities":
      return opportunityBlocks(view, section);
    case "actions":
      return actionBlocks(section.actions);
    case "updates":
      return updateBlocks(section);
    case "diagnosis":
      return diagnosisBlocks(section.diagnosis);
    case "goals":
      return goalBlocks(section);
    case "forecast":
      return forecastBlocks(section);
    case "content":
      return contentBlocks(section);
    case "roadmap":
      return roadmapBlocks(view, section);
  }
}

function narrativeBlocks(view: SeoReportView): Block[] {
  const { narrative } = view;
  if (!narrative) {
    return view.narrativeNote
      ? [{ t: "p", text: view.narrativeNote, style: "italic" }]
      : [];
  }
  const blocks: Block[] = [];
  if (narrative.headline) {
    blocks.push({ t: "p", text: narrative.headline, style: "bold" });
  }
  const lists = [
    { title: COPY.highlights, items: narrative.highlights },
    { title: COPY.watchouts, items: narrative.watchouts },
    { title: COPY.nextSteps, items: narrative.nextSteps },
  ];
  for (const list of lists) {
    if (list.items.length === 0) continue;
    blocks.push(
      { t: "h", level: 3, text: list.title },
      { t: "ul", items: list.items },
    );
  }
  return blocks;
}

function blocksOf(view: SeoReportView, options: SeoExportOptions): Block[] {
  const blocks: Block[] = [
    { t: "h", level: 1, text: titleOf(view, options) },
    { t: "p", text: metaOf(view), style: "muted" },
    ...narrativeBlocks(view),
  ];
  for (const section of view.snapshot.sections) {
    blocks.push(...sectionBlocks(view, section));
  }
  if (view.snapshot.notes.length > 0) {
    blocks.push(
      { t: "h", level: 3, text: COPY.notesHeading },
      { t: "ul", items: view.snapshot.notes },
    );
  }
  blocks.push({ t: "footer", text: COPY.footer });
  return blocks;
}

// ---- Markdown -------------------------------------------------------------

// Google'dan ve modelden gelen metin etkisizleştirilir: kendi vurgusu,
// bağlantısı, HTML'i, başlığı ya da tablo kırması olmaz.
function md(text: string): string {
  return flat(text).replace(/([\\`*_[\]<>#|~!])/g, "\\$1");
}

function mdTable(columns: string[], rows: string[][]): string[] {
  const row = (cells: readonly string[]) => `| ${cells.map(md).join(" | ")} |`;
  return [
    row(columns),
    `| ${columns.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map(row),
  ];
}

export function buildSeoReportMarkdown(
  view: SeoReportView,
  options: SeoExportOptions = {},
): string {
  const lines: string[] = [];
  for (const block of blocksOf(view, options)) {
    switch (block.t) {
      case "h":
        lines.push(`${"#".repeat(block.level)} ${md(block.text)}`, "");
        break;
      case "p":
        lines.push(
          block.style === "bold"
            ? `**${md(block.text)}**`
            : block.style === "italic"
              ? `_${md(block.text)}_`
              : md(block.text),
          "",
        );
        break;
      case "ul":
        lines.push(...block.items.map((item) => `- ${md(item)}`), "");
        break;
      case "ol":
        lines.push(
          ...block.items.map((item, index) => `${index + 1}. ${md(item)}`),
          "",
        );
        break;
      case "table":
        lines.push(...mdTable(block.columns, block.rows), "");
        break;
      case "footer":
        lines.push("---", "", md(block.text));
        break;
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

// ---- Düz metin ------------------------------------------------------------

export function buildSeoReportPlainText(
  view: SeoReportView,
  options: SeoExportOptions = {},
): string {
  const lines: string[] = [];
  for (const block of blocksOf(view, options)) {
    switch (block.t) {
      case "h":
        lines.push(flat(block.text), "");
        break;
      case "p":
        lines.push(flat(block.text), "");
        break;
      case "ul":
        lines.push(...block.items.map((item) => `- ${flat(item)}`), "");
        break;
      case "ol":
        lines.push(
          ...block.items.map((item, index) => `${index + 1}. ${flat(item)}`),
          "",
        );
        break;
      case "table":
        // Tablo sözdizimi yok: her satır "etiket: sütun değer · ..." olur.
        lines.push(
          ...block.rows.map(
            (cells) =>
              `- ${flat(cells[0] ?? "")}: ${cells
                .slice(1)
                .map(
                  (cell, index) =>
                    `${flat(block.columns[index + 1] ?? "")} ${flat(cell)}`,
                )
                .join(" · ")}`,
          ),
          "",
        );
        break;
      case "footer":
        lines.push(flat(block.text));
        break;
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

// "search-weekly-2026-09-28.md", "search-monthly-2026-09.md"
export function seoReportFileName(
  view: SeoReportView,
  extension = "md",
): string {
  return `search-${view.kind.toLowerCase()}-${view.periodKey.slice(2)}.${extension}`;
}

// ---- Baskı görünümü (PDF olarak kaydet) -----------------------------------

const PRINT_CSS = `
@page { size: A4; margin: 16mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; background: #fff; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
header { border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 16px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 18px 0 4px; }
h3 { font-size: 12px; margin: 12px 0 6px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 8px; }
.meta, .muted { color: #666; font-size: 12px; }
.headline { font-size: 15px; font-weight: 600; }
ul, ol { margin: 0 0 8px; padding-left: 18px; }
li { margin: 0 0 2px; }
table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 12px; }
th, td { text-align: left; padding: 4px 6px; border: 1px solid #ddd; }
th { color: #555; font-weight: 600; background: #f6f6f6; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
footer { border-top: 1px solid #ddd; padding-top: 10px; margin-top: 18px; color: #666; font-size: 11px; }
@media print { h2, h3 { break-after: avoid; } table, ul, ol { break-inside: avoid; } }
`;

function htmlTable(columns: string[], rows: string[][]): string {
  const cell = (tag: "th" | "td", text: string, index: number) =>
    `<${tag}${index === 0 ? "" : ' class="num"'}>${escapeHtml(text)}</${tag}>`;
  return [
    "<table><thead><tr>",
    columns.map((column, index) => cell("th", column, index)).join(""),
    "</tr></thead><tbody>",
    rows
      .map(
        (row) =>
          `<tr>${row.map((text, index) => cell("td", text, index)).join("")}</tr>`,
      )
      .join(""),
    "</tbody></table>",
  ].join("");
}

function htmlBlock(block: Block): string {
  switch (block.t) {
    case "h":
      // Başlık blokları <header> içindeki h1'e ayrılmıştır; buraya h2/h3 gelir.
      return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
    case "p": {
      const text = escapeHtml(block.text);
      if (block.style === "bold") return `<p class="headline">${text}</p>`;
      if (block.style === "italic")
        return `<p class="muted"><em>${text}</em></p>`;
      return block.style === "muted"
        ? `<p class="muted">${text}</p>`
        : `<p>${text}</p>`;
    }
    case "ul":
      return `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "ol":
      return `<ol>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
    case "table":
      return htmlTable(block.columns, block.rows);
    case "footer":
      return `<footer>${escapeHtml(block.text)}</footer>`;
  }
}

export function buildSeoReportPrintHtml(
  view: SeoReportView,
  options: SeoExportOptions = {},
): string {
  const title = titleOf(view, options);
  const body = blocksOf(view, options).filter(
    (block) => !(block.t === "h" && block.level === 1),
  );
  // Başlık satırı (meta) <header> içinde, kalan bloklar sırayla.
  const [meta, ...rest] = body;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PRINT_CSS}</style></head><body>`,
    `<header><h1>${escapeHtml(title)}</h1>${meta ? `<p class="meta">${escapeHtml(meta.t === "p" ? meta.text : "")}</p>` : ""}</header>`,
    rest.map(htmlBlock).join(""),
    "</body></html>",
  ].join("");
}
