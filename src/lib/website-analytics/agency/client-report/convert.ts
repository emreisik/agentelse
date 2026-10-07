import { formatMetric } from "@/lib/module-flows/analytics/format";
import type {
  MonthlyBody,
  PeriodReportSections,
  PlanBody,
  ReportAgentelseSection,
  ReportFindingSnap,
  ReportForecastSnap,
  ReportGoalSnap,
  ReportMover,
  ReportTable,
  ReportValueFormat,
  WebsiteReportCardData,
  WeeklyBody,
} from "@/lib/website-analytics/reports/types";

import type {
  ClientDoc,
  ClientDocBlock,
  ClientDocKpi,
  ClientDocTone,
} from "./document";
import {
  fillLabel,
  lab,
  resolveClientReportLabels,
  type ClientReportLabelKey,
  type ClientReportLabels,
} from "./labels";

// GA-F5 rapor kartından müşteri belgesine dönüştürücü (GA-F8 white-label).
// Biçim kuralları reports/export.ts'ten kopyalandı (oradan içe aktarılmaz:
// o dosya başlık ve alt bilgide Agentelse'i adıyla anar). Fark: bağlantı yok,
// sabit metinler etiket tablosundan gelir ve her dizgedeki "Agentelse" ajans
// adıyla değişir. Kart saklı ve değişmez olduğundan yalnız karttan okunur;
// eksik tablolar (ek mülklerde ek dilimler yok) hata değil, atlanan bölümdür.
// Saf ve izomorfik.

export type ClientReportOptions = {
  clientName: string;
  agencyName: string;
  // true: herkese açık paylaşım (site içi arama, Agentelse bölümü, plan ve
  // bulgudan türetilen sonraki adımlar çıkar).
  forShare: boolean;
  language?: string | null;
};

const DASH = "—";
const RANGE_DASH = "–";
// Yüzde değişim ±%1'den küçükse "flat".
const FLAT_BELOW_PCT = 1;

type Labels = ClientReportLabels;
type Key = ClientReportLabelKey;

function list<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function valueText(
  format: ReportValueFormat,
  value: number | null | undefined,
  currency: string | null,
): string {
  return typeof value !== "number" ? DASH : formatMetric(format, value, currency);
}

function changeText(pct: number | null | undefined): string {
  if (typeof pct !== "number") return DASH;
  return `${pct > 0 ? "+" : ""}${formatMetric("percent", pct, null)}`;
}

function toneOf(pct: number | null | undefined): ClientDocTone | null {
  if (typeof pct !== "number") return null;
  if (pct >= FLAT_BELOW_PCT) return "up";
  if (pct <= -FLAT_BELOW_PCT) return "down";
  return "flat";
}

function cellText(
  column: { label: string; format: ReportValueFormat },
  value: number | null | undefined,
  currency: string | null,
): string {
  if (typeof value !== "number") return DASH;
  // "Change" sütunu işaretli okunur: +12.5%.
  if (column.label === "Change" && column.format === "percent") {
    return changeText(value);
  }
  return valueText(column.format, value, currency);
}

function isTable(table: ReportTable | null | undefined): table is ReportTable {
  return (
    !!table && Array.isArray(table.columns) && Array.isArray(table.rows)
  );
}

function tableBlocks(
  labels: Labels,
  title: string | null,
  firstColumn: string,
  table: ReportTable | null | undefined,
  currency: string | null,
): ClientDocBlock[] {
  if (!isTable(table)) return [];
  const other = Array.isArray(table.other) ? table.other : null;
  if (table.rows.length === 0 && other === null) return [];
  const rows = table.rows.map((row) => [
    row.label,
    ...table.columns.map((column, index) =>
      cellText(column, list(row.values)[index], currency),
    ),
  ]);
  if (other) {
    rows.push([
      lab(labels, "table.other"),
      ...table.columns.map((column, index) =>
        cellText(column, other[index], currency),
      ),
    ]);
  }
  const notes = list(table.notes).filter((note) => note.trim() !== "");
  return [
    {
      type: "table",
      title,
      columns: [firstColumn, ...table.columns.map((column) => column.label)],
      rows,
      note: notes.length > 0 ? notes.join(" ") : null,
    },
  ];
}

function moverBlocks(
  labels: Labels,
  title: Key,
  movers: readonly ReportMover[] | null | undefined,
): ClientDocBlock[] {
  const rows = list(movers);
  if (rows.length === 0) return [];
  return [
    {
      type: "table",
      title: lab(labels, title),
      columns: [
        lab(labels, "table.page"),
        lab(labels, "table.sessions"),
        lab(labels, "table.previous"),
        lab(labels, "table.change"),
        lab(labels, "table.keyEvents"),
      ],
      rows: rows.map((row) => [
        row.page,
        formatMetric("count", row.sessions, null),
        formatMetric("count", row.previousSessions, null),
        changeText(row.changePct),
        formatMetric("count", row.keyEvents, null),
      ]),
      note: null,
    },
  ];
}

function findingItem(labels: Labels, finding: ReportFindingSnap): string {
  let text = finding.title;
  if (finding.detail) text += ` ${DASH} ${finding.detail}`;
  if (finding.impact) {
    text += ` ${lab(labels, "finding.impact")}: ${finding.impact}.`;
  }
  if (finding.explanation) text += ` ${finding.explanation}`;
  return `${text} (${finding.confidence}, ${finding.period})`;
}

function findingBlocks(
  labels: Labels,
  title: Key,
  findings: readonly ReportFindingSnap[] | null | undefined,
): ClientDocBlock[] {
  const rows = list(findings);
  if (rows.length === 0) return [];
  return [
    { type: "heading", text: lab(labels, title), level: 3 },
    { type: "bullets", items: rows.map((row) => findingItem(labels, row)) },
  ];
}

function goalItem(
  labels: Labels,
  goal: ReportGoalSnap,
  currency: string | null,
): string {
  const text = (value: number | null) => valueText(goal.format, value, currency);
  const parts: string[] = [];
  if (goal.final) {
    parts.push(`${lab(labels, "goal.result")} ${text(goal.monthToDate)}`);
  } else {
    parts.push(`${text(goal.monthToDate)} ${lab(labels, "goal.soFar")}`);
    if (goal.forecast !== null) {
      const range =
        goal.low !== null && goal.high !== null
          ? ` (${text(goal.low)}${RANGE_DASH}${text(goal.high)})`
          : "";
      parts.push(`${lab(labels, "goal.forecast")} ${text(goal.forecast)}${range}`);
    }
  }
  parts.push(`${lab(labels, "goal.target")} ${text(goal.target)}`);
  if (goal.paceLabel) parts.push(goal.paceLabel);
  return `${goal.title}: ${parts.join(" · ")}`;
}

function forecastItem(
  labels: Labels,
  forecast: ReportForecastSnap,
  currency: string | null,
): string {
  const text = (value: number | null) =>
    valueText(forecast.format, value, currency);
  let line = `${forecast.label}: ${text(forecast.monthToDate)} ${lab(labels, "forecast.soFar")}`;
  if (forecast.forecast !== null) {
    line += `, ${lab(labels, "forecast.forecast")} ${text(forecast.forecast)}`;
    if (forecast.low !== null && forecast.high !== null) {
      line += ` (${text(forecast.low)}${RANGE_DASH}${text(forecast.high)})`;
    }
  } else if (forecast.note) {
    line += `. ${forecast.note}`;
  }
  return line;
}

function forecastBlocks(
  labels: Labels,
  forecasts: readonly ReportForecastSnap[] | null | undefined,
  currency: string | null,
): ClientDocBlock[] {
  const rows = list(forecasts);
  if (rows.length === 0) return [];
  return [
    { type: "heading", text: lab(labels, "section.forecast"), level: 3 },
    {
      type: "bullets",
      items: rows.map((row) => forecastItem(labels, row, currency)),
    },
  ];
}

function kpiBlocks(
  labels: Labels,
  kpis: PeriodReportSections["kpis"] | null | undefined,
  currency: string | null,
): ClientDocBlock[] {
  const rows = list(kpis);
  if (rows.length === 0) return [];
  const items: ClientDocKpi[] = rows.map((kpi) => {
    const parts: string[] = [];
    if (typeof kpi.changePct === "number") {
      parts.push(
        `${changeText(kpi.changePct)} ${lab(labels, "kpi.vsPrevious")}`,
      );
    }
    if (typeof kpi.lastYearChangePct === "number") {
      parts.push(
        `${changeText(kpi.lastYearChangePct)} ${lab(labels, "kpi.vsLastYear")}`,
      );
    }
    return {
      label: kpi.label,
      value: valueText(kpi.format, kpi.value, currency),
      delta: parts.length > 0 ? parts.join(" · ") : null,
      tone: toneOf(kpi.changePct),
    };
  });
  return [
    { type: "heading", text: lab(labels, "section.keyNumbers"), level: 2 },
    { type: "kpis", items },
  ];
}

function narrativeBlocks(
  labels: Labels,
  card: WebsiteReportCardData,
): ClientDocBlock[] {
  const narrative = card.narrative;
  if (!narrative) return [];
  const highlights = list(narrative.highlights);
  const watchouts = list(narrative.watchouts);
  if (!narrative.headline && highlights.length === 0 && watchouts.length === 0) {
    return [];
  }
  const blocks: ClientDocBlock[] = [
    { type: "heading", text: lab(labels, "section.summary"), level: 2 },
  ];
  if (narrative.headline) {
    blocks.push({ type: "paragraph", text: narrative.headline });
  }
  if (highlights.length > 0) {
    blocks.push({ type: "bullets", items: [...highlights] });
  }
  if (watchouts.length > 0) {
    blocks.push(
      { type: "heading", text: lab(labels, "section.watchouts"), level: 3 },
      { type: "bullets", items: [...watchouts] },
    );
  }
  return blocks;
}

// "From Agentelse" bölümü (yalnız paylaşım dışı): başlıktaki ad sonda ajans
// adına çevrilir.
function agencySectionBlocks(
  labels: Labels,
  section: ReportAgentelseSection | undefined,
  currency: string | null,
): ClientDocBlock[] {
  if (!section) return [];
  const parts = [
    ...tableBlocks(
      labels,
      lab(labels, "table.trackedLinks"),
      lab(labels, "table.source"),
      section.tracked,
      currency,
    ),
    ...tableBlocks(
      labels,
      lab(labels, "table.adsOnSite"),
      lab(labels, "table.campaign"),
      section.ads,
      currency,
    ),
    ...tableBlocks(
      labels,
      lab(labels, "table.googleAds"),
      lab(labels, "table.campaign"),
      section.googleAds,
      currency,
    ),
  ];
  if (parts.length === 0) return [];
  const blocks: ClientDocBlock[] = [
    { type: "heading", text: lab(labels, "table.fromAgency"), level: 2 },
    ...parts,
  ];
  const notes = list(section.notes);
  if (notes.length > 0) blocks.push({ type: "bullets", items: [...notes] });
  return blocks;
}

function measurementBlocks(
  labels: Labels,
  measurement: PeriodReportSections["measurement"] | undefined,
): ClientDocBlock[] {
  if (!measurement) return [];
  const score =
    typeof measurement.score === "number" ? ` (${measurement.score}/100)` : "";
  const issues = measurement.issues > 0
    ? `${measurement.issues} ${lab(
        labels,
        measurement.issues === 1 ? "measurement.issue" : "measurement.issues",
      )}${
        measurement.critical > 0
          ? `, ${measurement.critical} ${lab(labels, "measurement.critical")}`
          : ""
      }`
    : lab(labels, "measurement.noIssues");
  return [
    { type: "heading", text: lab(labels, "section.measurement"), level: 2 },
    { type: "paragraph", text: `${measurement.label}${score}: ${issues}.` },
  ];
}

// Haftalık ve aylık raporun ortak gövdesi. Bağlantı taşıyan hiçbir alan
// (href) okunmaz.
function periodBlocks(
  labels: Labels,
  card: WebsiteReportCardData,
  body: WeeklyBody | MonthlyBody,
  forShare: boolean,
): ClientDocBlock[] {
  const currency = card.currency;
  const blocks: ClientDocBlock[] = [
    ...kpiBlocks(labels, body.kpis, currency),
    ...narrativeBlocks(labels, card),
    ...tableBlocks(
      labels,
      lab(labels, "table.channels"),
      lab(labels, "table.channel"),
      body.channels,
      currency,
    ),
    ...moverBlocks(labels, "table.landingUp", body.winners),
    ...moverBlocks(labels, "table.landingDown", body.losers),
    ...tableBlocks(
      labels,
      lab(labels, "table.keyEvents"),
      lab(labels, "table.keyEvent"),
      body.keyEvents,
      currency,
    ),
  ];
  if (!forShare && body.variant === "weekly") {
    blocks.push(...agencySectionBlocks(labels, body.agentelse, currency));
  }
  blocks.push(
    ...tableBlocks(
      labels,
      lab(labels, "table.aiAssistants"),
      lab(labels, "table.assistant"),
      body.aiAssistants,
      currency,
    ),
  );
  if (!forShare) {
    blocks.push(
      ...tableBlocks(
        labels,
        lab(labels, "table.siteSearch"),
        lab(labels, "table.searchTerm"),
        body.siteSearch,
        currency,
      ),
    );
  }
  if (body.variant === "monthly") {
    blocks.push(
      ...tableBlocks(
        labels,
        lab(labels, "table.topPages"),
        lab(labels, "table.page"),
        body.topPages,
        currency,
      ),
      ...tableBlocks(
        labels,
        lab(labels, "table.paidTraffic"),
        lab(labels, "table.source"),
        body.paidTraffic,
        currency,
      ),
    );
  }
  blocks.push(...measurementBlocks(labels, body.measurement));
  if (body.insights === "pending") {
    blocks.push({
      type: "paragraph",
      text: lab(labels, "insights.pending"),
      muted: true,
    });
  }
  blocks.push(
    ...findingBlocks(labels, "section.whatChanged", body.whatChanged),
    ...findingBlocks(labels, "section.opportunities", body.opportunities),
  );
  if (body.variant === "monthly" && body.outcomes) {
    const outcomes = body.outcomes;
    blocks.push(
      { type: "heading", text: lab(labels, "section.outcomes"), level: 3 },
      {
        type: "paragraph",
        text: fillLabel(lab(labels, "outcomes.line"), {
          worked: outcomes.worked,
          didnt: outcomes.didnt,
          inconclusive: outcomes.inconclusive,
        }),
      },
    );
    const items = list(outcomes.items);
    if (items.length > 0) {
      blocks.push({
        type: "bullets",
        items: items.map((item) => findingItem(labels, item)),
      });
    }
  }
  const goals = list(body.goals);
  if (goals.length > 0) {
    blocks.push(
      { type: "heading", text: lab(labels, "section.goals"), level: 2 },
      {
        type: "bullets",
        items: goals.map((goal) => goalItem(labels, goal, currency)),
      },
    );
  }
  if (body.variant === "weekly") {
    blocks.push(...forecastBlocks(labels, body.forecasts, currency));
  }
  // Bulgulardan türetilen (yapay zekâsız) sonraki adımlar paylaşımda yok.
  const nextSteps = list(body.nextSteps);
  if (
    nextSteps.length > 0 &&
    !(forShare && body.nextStepsSource === "findings")
  ) {
    blocks.push(
      { type: "heading", text: lab(labels, "section.nextSteps"), level: 2 },
      { type: "bullets", items: [...nextSteps] },
    );
  }
  return blocks;
}

function planBlocks(
  labels: Labels,
  card: WebsiteReportCardData,
  body: PlanBody,
): ClientDocBlock[] {
  const currency = card.currency;
  const blocks: ClientDocBlock[] = [];
  const proposals = list(body.proposals);
  if (proposals.length > 0) {
    blocks.push(
      {
        type: "heading",
        text: lab(labels, "section.suggestedTargets"),
        level: 2,
      },
      {
        type: "table",
        title: null,
        columns: [
          lab(labels, "table.metric"),
          lab(labels, "table.last3Months"),
          lab(labels, "table.seasonal"),
          lab(labels, "table.suggested"),
          lab(labels, "table.range"),
          lab(labels, "table.currentTarget"),
        ],
        rows: proposals.map((row) => {
          const text = (value: number | null) =>
            valueText(row.format, value, currency);
          return [
            row.label,
            text(row.baseline),
            row.seasonalPct === null ? DASH : changeText(row.seasonalPct),
            text(row.suggested),
            `${text(row.low)}${RANGE_DASH}${text(row.high)}`,
            text(row.currentGoal?.target ?? null),
          ];
        }),
        note: lab(labels, "plan.baselineNote"),
      },
    );
  } else if (body.proposalNote) {
    blocks.push({ type: "paragraph", text: body.proposalNote });
  }
  blocks.push(
    ...findingBlocks(labels, "section.topOpportunities", body.topFindings),
  );
  const bestPages = list(body.bestPages);
  if (bestPages.length > 0 || isTable(body.channelQuality)) {
    blocks.push({
      type: "heading",
      text: lab(labels, "section.forContentAndAds"),
      level: 2,
    });
    if (bestPages.length > 0) {
      blocks.push({
        type: "table",
        title: null,
        columns: [
          lab(labels, "table.page"),
          lab(labels, "table.sessions"),
          lab(labels, "table.keyEvents"),
          lab(labels, "table.keyEventRate"),
        ],
        rows: bestPages.map((page) => [
          page.page,
          formatMetric("count", page.sessions, null),
          formatMetric("count", page.keyEvents, null),
          formatMetric("percent", page.keyEventRate, null),
        ]),
        note: null,
      });
    }
    blocks.push(
      ...tableBlocks(
        labels,
        null,
        lab(labels, "table.channel"),
        body.channelQuality,
        currency,
      ),
    );
  }
  blocks.push(...forecastBlocks(labels, body.forecasts, currency));
  return blocks;
}

// Kartın en az gerekli kabuğu: bozuk ya da çeşit/gövde uyuşmayan kart null.
function isCardShape(card: WebsiteReportCardData | null | undefined): boolean {
  if (!card || typeof card !== "object") return false;
  if (card.kind !== "website-report") return false;
  const body = card.body as { variant?: unknown } | null | undefined;
  if (!body || typeof body !== "object") return false;
  return body.variant === card.variant;
}

// Her dizgedeki "Agentelse" (büyük/küçük harf fark etmez) ajans adına döner.
function scrubber(agencyName: string): (text: string) => string {
  const name = agencyName.replace(/\s+/g, " ").trim() || "Your agency";
  return (text) => text.replace(/agentelse/gi, () => name);
}

function scrubBlock(
  block: ClientDocBlock,
  scrub: (text: string) => string,
): ClientDocBlock {
  switch (block.type) {
    case "heading":
      return { ...block, text: scrub(block.text) };
    case "paragraph":
      return { ...block, text: scrub(block.text) };
    case "bullets":
      return { ...block, items: block.items.map(scrub) };
    case "kpis":
      return {
        ...block,
        items: block.items.map((item) => ({
          ...item,
          label: scrub(item.label),
          value: scrub(item.value),
          delta: item.delta === null ? null : scrub(item.delta),
        })),
      };
    case "table":
      return {
        ...block,
        title: block.title === null ? null : scrub(block.title),
        columns: block.columns.map(scrub),
        rows: block.rows.map((row) => row.map(scrub)),
        note: block.note === null ? null : scrub(block.note),
      };
  }
}

// weekly | monthly (+ plan paylaşım dışında); pulse, alert ve bozuk kart null.
export function websiteCardToDocument(
  card: WebsiteReportCardData,
  options: ClientReportOptions,
): ClientDoc | null {
  if (!isCardShape(card)) return null;
  const labels = resolveClientReportLabels(options.language);
  const body = card.body;
  const preliminaryText = lab(labels, "footnote.preliminary");

  let blocks: ClientDocBlock[];
  switch (body.variant) {
    case "weekly":
    case "monthly": {
      blocks = periodBlocks(labels, card, body, options.forShare);
      const notes = list(body.notes).filter(
        (note) => note.trim() !== "" && note !== preliminaryText,
      );
      if (notes.length > 0) {
        blocks.push(
          { type: "heading", text: lab(labels, "section.notes"), level: 3 },
          { type: "bullets", items: [...notes] },
        );
      }
      break;
    }
    case "plan":
      if (options.forShare) return null;
      blocks = planBlocks(labels, card, body);
      break;
    default:
      return null;
  }

  const footnotes = [lab(labels, "footnote.snapshot")];
  if (card.preliminary) footnotes.push(preliminaryText);

  const subtitleParts = [card.propertyName, options.clientName]
    .map((part) => (part ?? "").replace(/\s+/g, " ").trim())
    .filter((part) => part !== "");
  const scrub = scrubber(options.agencyName);

  return {
    title: scrub(card.title),
    subtitle: subtitleParts.length > 0 ? scrub(subtitleParts.join(" · ")) : null,
    periodLabel: scrub(card.periodLabel),
    clientName: scrub(options.clientName),
    builtAt: card.builtAt,
    isDemo: card.isMock === true,
    blocks: blocks.map((block) => scrubBlock(block, scrub)),
    footnotes: footnotes.map(scrub),
  };
}
