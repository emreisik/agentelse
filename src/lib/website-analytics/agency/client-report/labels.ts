// Müşteri raporunun sabit metinleri (dönüştürücü ve görünüm). Anahtarlar
// kararlıdır; dil başına yalnız bu tablo çoğalır. Şimdilik yalnız "en" dolu,
// bilinmeyen dil "en"e düşer. "Agentelse" kelimesi dönüştürücünün sonunda
// ajans adıyla değiştirilir (convert.ts), bu yüzden burada geçebilir.
// Saf ve izomorfik.

export type ClientReportLabels = Readonly<Record<string, string>>;

const EN = {
  "section.keyNumbers": "Key numbers",
  "section.summary": "Summary",
  "section.watchouts": "Watch-outs",
  "section.nextSteps": "Next steps",
  "section.measurement": "Measurement health",
  "section.goals": "Goals",
  "section.whatChanged": "What changed",
  "section.opportunities": "Opportunities",
  "section.outcomes": "Results of earlier findings",
  "section.forecast": "Month-end forecast",
  "section.notes": "Notes",
  "section.suggestedTargets": "Suggested targets",
  "section.topOpportunities": "Top opportunities",
  "section.forContentAndAds": "For content and ads",
  "table.channels": "Channels",
  "table.channel": "Channel",
  "table.landingUp": "Landing pages up",
  "table.landingDown": "Landing pages down",
  "table.keyEvents": "Key events",
  "table.keyEvent": "Key event",
  "table.aiAssistants": "AI assistants",
  "table.assistant": "Assistant",
  "table.siteSearch": "Site search",
  "table.searchTerm": "Search term",
  "table.topPages": "Top pages",
  "table.paidTraffic": "Paid traffic",
  "table.source": "Source",
  "table.campaign": "Campaign",
  "table.trackedLinks": "Tracked links",
  "table.adsOnSite": "Your ads on your website",
  "table.googleAds": "Google Ads",
  "table.fromAgency": "From Agentelse",
  "table.page": "Page",
  "table.sessions": "Sessions",
  "table.previous": "Previous",
  "table.change": "Change",
  "table.keyEventRate": "Key event rate",
  "table.other": "Other",
  "table.metric": "Metric",
  "table.last3Months": "Last 3 months",
  "table.seasonal": "Seasonal",
  "table.suggested": "Suggested",
  "table.range": "Range",
  "table.currentTarget": "Current target",
  "kpi.vsPrevious": "vs previous period",
  "kpi.vsLastYear": "vs last year",
  "finding.impact": "Impact",
  "goal.result": "result",
  "goal.soFar": "so far",
  "goal.forecast": "forecast",
  "goal.target": "target",
  "forecast.soFar": "so far",
  "forecast.forecast": "forecast",
  "measurement.noIssues": "no open issues",
  "measurement.issue": "open issue",
  "measurement.issues": "open issues",
  "measurement.critical": "critical",
  "outcomes.line": "{worked} worked, {didnt} didn't, {inconclusive} inconclusive.",
  "insights.pending": "Findings for this week are still being prepared.",
  "plan.baselineNote":
    "Last 3 months is the average of the latest full months, scaled to the days of the target month.",
  "footnote.snapshot":
    "This report keeps the numbers as they were when it was sent.",
  "footnote.preliminary":
    "Numbers from the last 7 days may still change slightly as Google finalizes them.",
  "meta.demo": "Demo data",
  "md.preparedBy": "Prepared by",
  "view.demoData": "Demo data",
  "view.up": "Up",
  "view.down": "Down",
  "view.flat": "Unchanged",
} as const;

export type ClientReportLabelKey = keyof typeof EN;

export const CLIENT_REPORT_LABEL_KEYS = Object.keys(
  EN,
) as readonly ClientReportLabelKey[];

const TABLES: Readonly<Record<string, ClientReportLabels>> = { en: EN };

// Dil yoksa ya da bilinmiyorsa İngilizce.
export function resolveClientReportLabels(
  language: string | null | undefined,
): ClientReportLabels {
  const code = (language ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  return TABLES[code] ?? EN;
}

// Anahtar tipli okuma: eksik anahtar İngilizce karşılığına düşer.
export function lab(
  labels: ClientReportLabels,
  key: ClientReportLabelKey,
): string {
  return labels[key] ?? EN[key];
}

// "{name}" yer tutucularını doldurur (değerler olduğu gibi girer).
export function fillLabel(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}
