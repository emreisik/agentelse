import type { ReportSummary } from "@/lib/module-flows/analytics/report";

import {
  WEBSITE_REPORT_COPY,
  dayLabel,
  monthLabel,
  rangeLabel,
  reportTitle,
  weekdayDayLabel,
} from "./copy";
import { GA_RECONNECT_ALERT_KINDS, alertHref, reportHrefs } from "./ids";
import { evaluatePulse } from "./pulse";
import {
  aiAssistantTable,
  channelTable,
  findingSnap,
  forecastSnaps,
  goalSnaps,
  keyEventTable,
  kpiRows,
  landingMovers,
  measurementSnap,
  paidTrafficTable,
  siteSearchTable,
  topPagesTable,
} from "./sections";
import {
  REPORT_CAPS,
  type MonthlyBody,
  type MonthlyReportInput,
  type PeriodReportInput,
  type PeriodReportSections,
  type PulseInput,
  type ReportFindingSnap,
  type ReportLinkInfo,
  type WeeklyBody,
  type WeeklyReportInput,
  type WebsiteReportCardData,
} from "./types";

// GA-F5 kart kurucuları: girdiler (ambardan okunmuş sayılar) kartın
// değişmez gövdesine çevrilir. Kart gösterdiği her sayıyı kendisi taşır ve
// gönderildikten sonra bir daha değişmez. Saf ve izomorfik.

type CardBase = Pick<
  WebsiteReportCardData,
  | "kind"
  | "v"
  | "projectId"
  | "linkId"
  | "propertyName"
  | "timeZone"
  | "currency"
  | "builtAt"
  | "dataThrough"
  | "isMock"
  | "narrative"
  | "narrativeNote"
>;

function cardBase(link: ReportLinkInfo, builtAt: string): CardBase {
  return {
    kind: "website-report",
    v: 1,
    projectId: link.projectId,
    linkId: link.linkId,
    propertyName: link.propertyName,
    timeZone: link.timeZone,
    currency: link.currency,
    builtAt,
    dataThrough: link.dataThrough || null,
    isMock: link.isMock,
    narrative: null,
    narrativeNote: null,
  };
}

// Fırsatlardan en çok 3 sıradaki adım.
export function nextStepsFromFindings(
  opportunities: readonly ReportFindingSnap[],
): string[] {
  return opportunities
    .slice(0, REPORT_CAPS.nextSteps)
    .map((finding) => `Review "${finding.title}" on the Website page.`);
}

// --- Nabız -----------------------------------------------------------------------

export function buildPulseCard(input: PulseInput): WebsiteReportCardData {
  const body = evaluatePulse(input);
  const dayRow = input.days.find((day) => day.day === input.day);
  return {
    ...cardBase(input.link, input.builtAt),
    variant: "pulse",
    title: reportTitle("pulse", { day: input.day }),
    periodLabel: weekdayDayLabel(input.day),
    // Dün henüz kesinleşmemiş olabilir; satır yoksa da kesin sayılmaz.
    preliminary: !dayRow?.isFinal,
    body,
  };
}

// --- Haftalık ve aylık ortak bölümler -------------------------------------------

function periodSections(
  input: PeriodReportInput,
  options: { weekly: boolean },
): PeriodReportSections {
  const { link, current, previous, findings } = input;
  const hrefs = reportHrefs(
    link.projectId,
    input.websitePage,
    link.propertyId ?? null,
  );
  const snapOf = (view: PeriodReportInput["findings"]["changed"][number]) =>
    findingSnap(view, {
      currency: link.currency,
      timeZone: link.timeZone,
      href: hrefs.finding(view.id),
    });
  // Bulgular kapalıyken (off) listeler boş kalır.
  const showFindings = findings.insights !== "off";
  const whatChanged = showFindings
    ? findings.changed.slice(0, REPORT_CAPS.whatChanged).map(snapOf)
    : [];
  const opportunities = showFindings
    ? findings.opportunities.slice(0, REPORT_CAPS.opportunities).map(snapOf)
    : [];
  const nextSteps = nextStepsFromFindings(opportunities);
  const movers = landingMovers(current.landing, previous.landing);

  // Not sırası sabittir; snapshotNote hep sonda.
  const notes: string[] = [];
  if (current.preliminary) notes.push(WEBSITE_REPORT_COPY.preliminaryNote);
  if (current.coveredDays < current.days) {
    notes.push(WEBSITE_REPORT_COPY.missingDaysNote);
  }
  if (current.totals.keyEvents === 0) {
    notes.push(WEBSITE_REPORT_COPY.noKeyEventsNote);
  }
  if (findings.insights === "pending") {
    notes.push(WEBSITE_REPORT_COPY.insightsPending);
  }
  notes.push(WEBSITE_REPORT_COPY.snapshotNote);

  return {
    kpis: kpiRows({
      current: current.totals,
      previous: previous.totals,
      lastYear: input.lastYear?.totals ?? null,
      users: input.users,
    }),
    channels: channelTable(current.channel, previous.channel, current.totals),
    winners: movers.winners,
    losers: movers.losers,
    keyEvents: keyEventTable(current.events, previous.events),
    aiAssistants: aiAssistantTable(current.sourceMedium, previous.sourceMedium),
    // Site içi arama yalnız haftalık veridir; aylık raporda hiç yok.
    siteSearch: options.weekly ? siteSearchTable(input.siteSearch) : null,
    measurement: measurementSnap(input.measurement, hrefs.measurement),
    insights: findings.insights,
    whatChanged,
    opportunities,
    goals: goalSnaps(input.goals, {
      final: !options.weekly,
      month: input.goalsMonth,
    }),
    nextSteps,
    nextStepsSource: nextSteps.length > 0 ? "findings" : "none",
    notes,
  };
}

export function buildWeeklyCard(
  input: WeeklyReportInput,
): WebsiteReportCardData {
  const { current, previous, lastYear } = input;
  const body: WeeklyBody = {
    ...periodSections(input, { weekly: true }),
    variant: "weekly",
    from: current.from,
    to: current.to,
    previous: { from: previous.from, to: previous.to },
    lastYear: lastYear ? { from: lastYear.from, to: lastYear.to } : null,
    forecasts: forecastSnaps(input.forecasts),
    // GA-F6: bölüm yoksa alan hiç yazılmaz (bayrak kapalıyken kart aynı kalır).
    ...(input.agentelse ? { agentelse: input.agentelse } : {}),
  };
  return {
    ...cardBase(input.link, input.builtAt),
    variant: "weekly",
    title: reportTitle("weekly", { from: current.from, to: current.to }),
    periodLabel: rangeLabel(current.from, current.to),
    preliminary: current.preliminary,
    body,
  };
}

export function buildMonthlyCard(
  input: MonthlyReportInput,
): WebsiteReportCardData {
  const { current, previous, lastYear, findings, link } = input;
  const hrefs = reportHrefs(
    link.projectId,
    input.websitePage,
    link.propertyId ?? null,
  );
  const outcomes = findings.outcomeCounts
    ? {
        worked: findings.outcomeCounts.worked,
        didnt: findings.outcomeCounts.didnt,
        inconclusive: findings.outcomeCounts.inconclusive,
        items: findings.evaluated.slice(0, REPORT_CAPS.outcomes).map((view) =>
          findingSnap(view, {
            currency: link.currency,
            timeZone: link.timeZone,
            href: hrefs.finding(view.id),
          }),
        ),
      }
    : null;
  const body: MonthlyBody = {
    ...periodSections(input, { weekly: false }),
    variant: "monthly",
    month: input.month,
    from: current.from,
    to: current.to,
    previous: { from: previous.from, to: previous.to },
    lastYear: lastYear ? { from: lastYear.from, to: lastYear.to } : null,
    topPages: topPagesTable(current.landing, current.totals),
    paidTraffic: paidTrafficTable(current.channel, current.campaign),
    outcomes,
  };
  return {
    ...cardBase(link, input.builtAt),
    variant: "monthly",
    title: reportTitle("monthly", { month: input.month }),
    periodLabel: monthLabel(input.month),
    preliminary: current.preliminary,
    body,
  };
}

// --- Uyarı ---------------------------------------------------------------------

export function buildAlertCard(input: {
  link: ReportLinkInfo;
  builtAt: string;
  websitePage: boolean;
  alert: { id: string; kind: string; title: string; firstSeenAt: string };
}): WebsiteReportCardData {
  const { link, alert } = input;
  const hrefs = reportHrefs(
    link.projectId,
    input.websitePage,
    link.propertyId ?? null,
  );
  return {
    ...cardBase(link, input.builtAt),
    variant: "alert",
    title: reportTitle("alert", { alertTitle: alert.title }),
    periodLabel: dayLabel(alert.firstSeenAt.slice(0, 10)),
    preliminary: false,
    body: {
      variant: "alert",
      alertId: alert.id,
      kind: alert.kind,
      severity: "CRITICAL",
      title: alert.title,
      href: alertHref(alert.kind, hrefs),
      reconnect: GA_RECONNECT_ALERT_KINDS.includes(alert.kind),
      openedAt: alert.firstSeenAt,
    },
  };
}

// --- Anlatı --------------------------------------------------------------------

// Yalnız gerçek (demo olmayan) haftalık ve aylık raporlar için LLM anlatısı;
// mock akıl yürütme modunda çağrı yapılmaz.
export function needsNarrative(
  card: WebsiteReportCardData,
  reasoningMock: boolean,
): boolean {
  return (
    (card.variant === "weekly" || card.variant === "monthly") &&
    !card.isMock &&
    !reasoningMock
  );
}

// Anlatı eklenmiş YENİ kart. Sayılara dokunmaz: yalnız narrative, not ve
// (anlatı sıradaki adım getirdiyse) nextSteps değişir.
export function withNarrative(
  card: WebsiteReportCardData,
  outcome: { narrative: ReportSummary | null; note: string | null },
): WebsiteReportCardData {
  const { narrative } = outcome;
  if (!narrative) {
    return { ...card, narrative: null, narrativeNote: outcome.note };
  }
  const aiSteps = narrative.nextSteps.slice(0, REPORT_CAPS.nextSteps);
  const body = card.body;
  if (
    aiSteps.length > 0 &&
    (body.variant === "weekly" || body.variant === "monthly")
  ) {
    return {
      ...card,
      narrative,
      narrativeNote: null,
      body: { ...body, nextSteps: aiSteps, nextStepsSource: "ai" },
    };
  }
  return { ...card, narrative, narrativeNote: null };
}
