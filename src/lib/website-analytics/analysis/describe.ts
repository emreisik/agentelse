import {
  formatCount,
  formatDuration,
  formatMoney,
  formatPercent,
} from "@/lib/module-flows/analytics/format";

import { AI_ASSISTANTS } from "./ai-sources";
import { gaRule } from "./registry";
import { evidenceHolidays } from "./stored";
import type {
  GaAnomalyMetric,
  GaDecompositionMetric,
  GaFindingConfidence,
  GaFindingEvidence,
  GaFindingKind,
  GaFindingOutcome,
  GaImpact,
  GaImpactMetric,
  GaPeriod,
  GaRange,
  GaRuleKey,
  GaWebsiteGoalKey,
} from "./types";
import type { GaFindingView } from "./view-types";

// GA-F4 bulgu metinleri (docs/google-analytics-plan.md §6.2; ayrıntı
// docs/website-insights.md "Yüzeyler"): başlık, ayrıntı, etki, dönem, durum,
// operatör başlığı, sinyal ve öğrenme metni. Saf ve istemci güvenli: yalnız A
// paketinin tip/kayıt/okuyucuları ve rapor biçimleyicisi içe aktarılır.
//
// Sayı dürüstlüğü: ayrıntı, etki ve dönem metnindeki her sayı aynı yazıcıdan
// (Printer) geçer; yazıcı yuvarlanmış değeri findingFacts'e de yazar. Böylece
// number-check (allowedNumbersOf) gidiş-dönüşü yapı gereği tutar. İşaret
// metinde kelimeyle verilir ("up", "fell"); sayılar mutlak yazılır.
//
// Sinyal ve öğrenme metni (Limited Use): yol, arama terimi, kampanya adı ve
// rakam taşımaz; yalnız GA varsayılan kanal adları ve yapay zekâ asistanı
// adları geçebilir (görev başlıkları Telegram'a ulaşır).

type Currency = { currency?: string | null };

// Meta'nın varsayılan atıf penceresi (tıklama sonrası 7 gün, görüntüleme
// sonrası 1 gün); AN13 metni bunu açıklar.
const META_CLICK_WINDOW_DAYS = 7;
const META_VIEW_WINDOW_DAYS = 1;

// Yazıcının topladığı olgular; konu metni en fazla 3 tane.
const MAX_SUBJECT_STRINGS = 3;

const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;

// Bir metindeki sayıların okunuşları (liste öğeleri: terim, yol). Olgulara
// metnin kendisi değil yalnız sayıları girer, konu metni bütçesi büyümez.
function numbersIn(text: string): number[] {
  const values = new Set<number>();
  for (const token of text.match(NUMBER_TOKEN) ?? []) {
    for (const candidate of [
      token.replace(/,/g, ""),
      token.replace(/\./g, "").replace(",", "."),
      token.replace(",", "."),
    ]) {
      const value = Number(candidate);
      if (Number.isFinite(value)) values.add(value);
    }
  }
  return [...values];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

class Printer {
  readonly facts: Record<string, unknown> = {};
  private subjects = 0;

  constructor(readonly currency: string | null) {}

  count(name: string, value: number): string {
    const rounded = Math.abs(Math.round(finite(value)));
    this.facts[name] = rounded;
    return formatCount(rounded);
  }

  // Kanıttaki oran kesirdir: yüzde = round(oran·100, 1).
  rate(name: string, fraction: number): string {
    const percent = Math.abs(round1(finite(fraction) * 100));
    this.facts[name] = percent;
    return formatPercent(percent);
  }

  // Zaten yüzde biriminde olan değer (changePct, dropPct).
  percent(name: string, value: number): string {
    const percent = Math.abs(round1(finite(value)));
    this.facts[name] = percent;
    return formatPercent(percent);
  }

  money(name: string, value: number): string {
    return this.moneyIn(name, value, this.currency);
  }

  // Mülk parasından farklı bir para birimi (AN13: Meta hesabının parası).
  moneyIn(name: string, value: number, currency: string | null): string {
    const rounded = Math.abs(round2(finite(value)));
    this.facts[name] = rounded;
    return formatMoney(rounded, currency);
  }

  // ROAS gibi birimsiz oran: iki ondalık, olgulara aynı yuvarlama.
  ratio(name: string, value: number): string {
    const rounded = Math.abs(round2(finite(value)));
    this.facts[name] = rounded;
    return String(rounded);
  }

  // "1m 35s": dakika ve saniye ayrı sayı olarak da yazılır.
  duration(name: string, seconds: number): string {
    const total = Math.max(0, Math.round(finite(seconds)));
    this.facts[name] = total;
    this.facts[`${name}Parts`] = [
      Math.floor(total / 3600),
      Math.floor((total % 3600) / 60),
      total % 60,
    ];
    return formatDuration(total);
  }

  // Gün "YYYY-MM-DD" olarak saklanır: ay günü ve yıl sayıları desteklenir.
  day(name: string, day: string): void {
    this.facts[name] = day;
  }

  subject(name: string, text: string): string {
    if (this.subjects < MAX_SUBJECT_STRINGS) {
      this.facts[name] = text;
      this.subjects += 1;
    } else {
      this.list(name, [text]);
    }
    return text;
  }

  // Liste öğeleri (terim, yol): yalnız içlerindeki sayılar.
  list(name: string, texts: readonly string[]): void {
    const numbers = texts.flatMap(numbersIn);
    if (numbers.length > 0) this.facts[`${name}Numbers`] = numbers;
  }
}

// --- Etiketler -------------------------------------------------------------

const ANOMALY_LABELS: Record<GaAnomalyMetric, string> = {
  sessions: "Visits",
  engagedSessions: "Engaged visits",
  keyEvents: "Key events",
  revenue: "Revenue",
  keyEventRate: "Key event rate",
};

const CHANGE_LABELS: Record<GaDecompositionMetric, string> = {
  keyEvents: "Key events",
  sessions: "Visits",
  revenue: "Revenue",
};

const CHANGE_NOUNS: Record<GaDecompositionMetric, string> = {
  keyEvents: "key events",
  sessions: "visits",
  revenue: "revenue",
};

const COMPARISON_WORDS: Record<"wow" | "mom" | "yoy", string> = {
  wow: "week over week",
  mom: "month over month",
  yoy: "compared with last year",
};

// GA4 varsayılan kanal grupları: sinyal/öğrenme metninde yalnız bunlar geçer.
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

const ASSISTANT_NAMES: ReadonlySet<string> = new Set(
  AI_ASSISTANTS.map((assistant) => assistant.name),
);

// Mağaza hunisi adımları (GA4 olay adları, kullanıcı metni değil).
const FUNNEL_LABELS: Readonly<Record<string, string>> = {
  view_item: "product view",
  add_to_cart: "add to cart",
  begin_checkout: "checkout",
  purchase: "purchase",
};

function funnelLabel(event: string): string {
  return FUNNEL_LABELS[event] ?? event;
}

const IMPACT_NOUNS: Record<
  Exclude<GaImpactMetric, "revenue">,
  [string, string]
> = {
  keyEvents: ["key event", "key events"],
  sessions: ["visit", "visits"],
  engagedSessions: ["engaged visit", "engaged visits"],
  views: ["view", "views"],
  purchases: ["purchase", "purchases"],
};

const GOAL_FORMAT: Record<GaWebsiteGoalKey, "count" | "money"> = {
  "web.sessions": "count",
  "web.key_events": "count",
  "web.revenue": "money",
};

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// --- Tarih -----------------------------------------------------------------

type DayParts = { year: number; month: number; day: number };

function dayParts(day: string): DayParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month, day: Number(match[3]) };
}

function shortDay(parts: DayParts, withYear: boolean): string {
  const text = `${MONTHS_SHORT[parts.month - 1]} ${parts.day}`;
  return withYear ? `${text}, ${parts.year}` : text;
}

// "Sep 28 – Oct 4, 2026"; yıllar farklıysa iki uçta da yıl.
function rangeText(from: DayParts, to: DayParts): string {
  if (from.year !== to.year) {
    return `${shortDay(from, true)} – ${shortDay(to, true)}`;
  }
  return `${shortDay(from, false)} – ${shortDay(to, true)}`;
}

function inclusiveDays(range: GaRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}

function printPeriod(period: GaPeriod, printer: Printer): string {
  const from = dayParts(period.from);
  const to = dayParts(period.to);
  if (!from || !to) return "";
  printer.day("periodFrom", period.from);
  printer.day("periodTo", period.to);
  switch (period.grain) {
    case "DAY":
      return shortDay(from, true);
    case "MONTH":
      return `${MONTHS_LONG[from.month - 1]} ${from.year}`;
    case "WEEK":
    case "WINDOW28":
      return period.from === period.to
        ? shortDay(from, true)
        : rangeText(from, to);
  }
}

// --- Başlık ----------------------------------------------------------------

export function findingTitle(f: GaFindingView): string {
  const evidence = f.evidence;
  switch (evidence.rule) {
    case "AN1": {
      const reading =
        evidence.readings.find((item) => item.metric === evidence.primary) ??
        evidence.readings[0];
      const label = ANOMALY_LABELS[evidence.primary];
      const verb = reading?.direction === "up" ? "jumped" : "dropped sharply";
      return `${label} ${verb}${evidence.mode === "week" ? " last week" : ""}`;
    }
    case "AN2": {
      const verb = evidence.change < 0 ? "fell" : "rose";
      return `${CHANGE_LABELS[evidence.metric]} ${verb} ${COMPARISON_WORDS[evidence.comparison]}`;
    }
    case "AN3":
      return evidence.variant === "cro"
        ? `${evidence.page} gets visits but few key events`
        : `${evidence.page} turns visitors into key events`;
    case "AN4":
      if (evidence.measure === "engagement") {
        return `${evidence.channel} visits engage less than the rest`;
      }
      return evidence.direction === "below"
        ? `${evidence.channel} visits convert less than the rest`
        : `${evidence.channel} visits convert better than the rest`;
    case "AN5":
      return "Mobile visitors convert less than desktop";
    case "AN6":
      return "Fewer returning visitors";
    case "AN7":
      return evidence.firstSeen
        ? "AI assistants started sending visitors"
        : "More visits from AI assistants";
    case "AN8":
      return "What visitors search for on your site";
    case "AN9":
      return "Visitors are landing on missing pages";
    case "AN10":
      return "Your most engaging content";
    case "AN11":
      return `Fewer shoppers go from ${funnelLabel(evidence.step.from)} to ${funnelLabel(evidence.step.to)}`;
    case "AN12":
      return `Campaign “${evidence.campaign}” converts ${
        evidence.direction === "below" ? "less" : "better"
      } than the rest`;
    case "AN13":
      return evidence.checks.includes("clicks")
        ? gaRule("AN13").title
        : "Meta and GA4 count conversions differently";
    case "AN14":
      return evidence.direction === "worse"
        ? "Google Ads: cost per key event went up"
        : "Google Ads: cost per key event went down";
    case "AN15":
      return `Goal “${evidence.goalTitle}” is behind this month`;
  }
}

// --- Ayrıntı ---------------------------------------------------------------

function anomalyValue(
  printer: Printer,
  name: string,
  metric: GaAnomalyMetric,
  value: number,
): string {
  if (metric === "keyEventRate") return printer.rate(name, value);
  if (metric === "revenue") return printer.money(name, value);
  return printer.count(name, value);
}

function changeValue(
  printer: Printer,
  name: string,
  metric: GaDecompositionMetric,
  value: number,
): string {
  return metric === "revenue"
    ? printer.money(name, value)
    : printer.count(name, value);
}

function printDetail(f: GaFindingView, printer: Printer): string {
  const evidence = f.evidence;
  switch (evidence.rule) {
    case "AN1": {
      const reading =
        evidence.readings.find((item) => item.metric === evidence.primary) ??
        evidence.readings[0];
      if (!reading) return "";
      const label = ANOMALY_LABELS[reading.metric];
      const value = anomalyValue(
        printer,
        "value",
        reading.metric,
        reading.value,
      );
      const usual = anomalyValue(
        printer,
        "usual",
        reading.metric,
        reading.median,
      );
      const sentences = [
        evidence.mode === "week"
          ? `${label}: ${value} last week vs a usual ${usual} a week.`
          : `${label}: ${value} vs a usual ${usual} on this weekday.`,
      ];
      const top = evidence.breakdown?.components[0];
      if (top && top.share !== null && top.share > 0) {
        const name = printer.subject("topChannel", top.label);
        sentences.push(
          `${name} accounts for ${printer.rate("topShare", top.share)} of the change.`,
        );
      }
      return sentences.join(" ");
    }
    case "AN2": {
      const { metric } = evidence;
      const after = changeValue(
        printer,
        "after",
        metric,
        evidence.current.total,
      );
      const before = changeValue(
        printer,
        "before",
        metric,
        evidence.previous.total,
      );
      const direction = evidence.change < 0 ? "down" : "up";
      const days =
        evidence.comparison === "mom"
          ? {
              current: ` in ${printer.count("currentDays", evidence.current.days)} days`,
              previous: ` in ${printer.count("previousDays", evidence.previous.days)} days`,
            }
          : { current: "", previous: "" };
      const sentences = [
        evidence.changePct === null
          ? `${CHANGE_LABELS[metric]}: ${after}${days.current} vs none before.`
          : `${CHANGE_LABELS[metric]}: ${after}${days.current} vs ${before}${days.previous} (${direction} ${printer.percent("changePct", evidence.changePct)}).`,
      ];
      const top = evidence.channels.components[0];
      if (top && top.share !== null && top.share > 0) {
        const delta = top.sessionsAfter - top.sessionsBefore;
        const name = printer.subject("topChannel", top.label);
        const visits = printer.count("topSessionsChange", delta);
        const perDay = evidence.channels.perDay ? " a day" : "";
        sentences.push(
          `${name}: ${delta < 0 ? "lost" : "gained"} ${visits} visits${perDay} (${printer.rate("topShare", top.share)} of the change).`,
        );
      }
      return sentences.join(" ");
    }
    case "AN3": {
      const days = printer.count("windowDays", inclusiveDays(evidence.window));
      return `${printer.count("sessions", evidence.sessions)} visits in ${days} days; ${printer.rate("rate", evidence.rate)} became key events vs ${printer.rate("restRate", evidence.restRate)} on the rest of the site.`;
    }
    case "AN4": {
      const days = printer.count("windowDays", inclusiveDays(evidence.window));
      const visits = printer.count("sessions", evidence.sessions);
      const rate = printer.rate("rate", evidence.rate);
      const rest = printer.rate("restRate", evidence.restRate);
      return evidence.measure === "engagement"
        ? `${visits} visits in ${days} days; ${rate} were engaged vs ${rest} on the rest of the site.`
        : `${visits} visits in ${days} days; key event rate ${rate} vs ${rest} on the rest of the site.`;
    }
    case "AN5": {
      const days = printer.count("windowDays", inclusiveDays(evidence.window));
      return `Mobile: key event rate ${printer.rate("mobileRate", evidence.mobile.rate)} on ${printer.count("mobileSessions", evidence.mobile.sessions)} visits; desktop: ${printer.rate("desktopRate", evidence.desktop.rate)} on ${printer.count("desktopSessions", evidence.desktop.sessions)} visits (${days} days).`;
    }
    case "AN6": {
      const weeks = printer.count("weeks", evidence.weeks.length);
      return `Returning visits made up ${printer.rate("lateShare", evidence.lateShare)} of visits lately, down from ${printer.rate("earlyShare", evidence.earlyShare)} ${weeks} weeks ago.`;
    }
    case "AN7": {
      const days = printer.count("windowDays", inclusiveDays(evidence.current));
      const current = printer.count("sessions", evidence.current.sessions);
      const previous = printer.count(
        "previousSessions",
        evidence.previous.sessions,
      );
      const sentences = [
        evidence.firstSeen || evidence.changePct === null
          ? `${current} visits from AI assistants in ${days} days, up from ${previous} before.`
          : `${current} visits from AI assistants in ${days} days vs ${previous} in the ${days} days before (up ${printer.percent("changePct", evidence.changePct)}).`,
      ];
      const top = evidence.assistants[0];
      if (top) {
        const name = printer.subject("topAssistant", top.name);
        sentences.push(
          `Most came from ${name} (${printer.count("topAssistantSessions", top.sessions)}).`,
        );
      }
      return sentences.join(" ");
    }
    case "AN8": {
      const terms = evidence.terms.slice(0, 5);
      printer.list(
        "terms",
        terms.map((item) => item.term),
      );
      const listed = terms
        .map(
          (item, index) =>
            `“${item.term}” (${printer.count(`termSearches${index + 1}`, item.searches)})`,
        )
        .join(", ");
      const total = printer.count("totalSearches", evidence.totalSearches);
      const weeks = printer.count("weeks", evidence.weeks.length);
      return listed
        ? `${total} searches in ${weeks} weeks. Top: ${listed}.`
        : `${total} searches in ${weeks} weeks.`;
    }
    case "AN9": {
      const pages = evidence.pages.slice(0, 3);
      printer.list(
        "pages",
        pages.map((page) => page.path),
      );
      const listed = pages
        .map(
          (page, index) =>
            `${page.path} (${printer.count(`pageViews${index + 1}`, page.views)})`,
        )
        .join(", ");
      const total = printer.count("views", evidence.views);
      return listed
        ? `${total} views of missing pages in the week. Most: ${listed}.`
        : `${total} views of missing pages in the week.`;
    }
    case "AN10": {
      const pages = evidence.pages.slice(0, 3);
      printer.list(
        "pages",
        pages.map((page) => page.path),
      );
      const listed = pages
        .map(
          (page, index) =>
            `${page.path}: ${printer.rate(`pageEngagementRate${index + 1}`, page.engagementRate)} engaged, ${printer.duration(`pageEngagementTime${index + 1}`, page.avgEngagementSec)} average engagement time`,
        )
        .join("; ");
      const site = `Site average: ${printer.rate("siteEngagementRate", evidence.siteEngagementRate)} engaged, ${printer.duration("siteEngagementTime", evidence.siteAvgEngagementSec)}.`;
      return listed ? `${listed}. ${site}` : site;
    }
    case "AN11": {
      const { step } = evidence;
      return `${printer.rate("rate", step.current.rate)} of shoppers went from ${funnelLabel(step.from)} to ${funnelLabel(step.to)} in the week (${printer.count("completed", step.current.completed)} of ${printer.count("entered", step.current.entered)}) vs ${printer.rate("baselineRate", step.baseline.rate)} in the weeks before.`;
    }
    case "AN12": {
      const days = printer.count("windowDays", inclusiveDays(evidence.window));
      printer.subject("campaign", evidence.campaign);
      return `${printer.count("sessions", evidence.sessions)} visits in ${days} days; key event rate ${printer.rate("rate", evidence.rate)} vs ${printer.rate("restRate", evidence.restRate)} on the rest of the site.`;
    }
    case "AN13": {
      // Etiket her varyantta olgulara girer (açıklama istemi kampanyayı bilsin).
      const label = printer.subject("label", evidence.label);
      const sentences: string[] = [];
      if (evidence.checks.includes("clicks")) {
        const clicks = printer.count("metaLinkClicks", evidence.meta.linkClicks);
        const sessions = printer.count("gaSessions", evidence.ga.sessions);
        const loss = printer.rate("clickLoss", evidence.clickLoss ?? 0);
        sentences.push(
          `Meta counted ${clicks} link clicks on the ads Agentelse tagged in "${label}", but GA4 saw ${sessions} sessions from them (${loss} fewer). Check the landing page speed and that the Google tag loads before visitors leave.`,
        );
      }
      if (evidence.checks.includes("results")) {
        const results = printer.count("metaResults", evidence.meta.results ?? 0);
        const keyEvents = printer.count("gaKeyEvents", evidence.ga.keyEvents);
        const gap = printer.rate("resultsGap", evidence.resultsGap ?? 0);
        // Meta'nın atıf penceresi sabittir; metindeki sayılar olgulara da girer.
        printer.facts.metaClickWindowDays = META_CLICK_WINDOW_DAYS;
        printer.facts.metaViewWindowDays = META_VIEW_WINDOW_DAYS;
        sentences.push(
          `Meta reported ${results} results and GA4 ${keyEvents} key events (${gap} apart). Meta counts results up to ${META_CLICK_WINDOW_DAYS} days after a click or ${META_VIEW_WINDOW_DAYS} day after a view, so some gap is normal; a gap this large is worth a tracking check.`,
        );
      }
      if (evidence.costPerKeyEvent !== null) {
        const cost = printer.moneyIn(
          "costPerKeyEvent",
          evidence.costPerKeyEvent,
          evidence.metaCurrency,
        );
        sentences.push(`Cost per key event (GA4): ${cost}.`);
      }
      return sentences.join(" ");
    }
    case "AN14": {
      const days = printer.count("windowDays", inclusiveDays(evidence.window));
      const campaign = printer.subject("campaign", evidence.campaign);
      const cost = printer.money(
        "costPerKeyEvent",
        evidence.current.costPerKeyEvent,
      );
      const before = printer.money(
        "previousCostPerKeyEvent",
        evidence.previous.costPerKeyEvent,
      );
      const change = printer.percent("changePct", evidence.changePct);
      const sign = evidence.changePct < 0 ? "-" : "+";
      let roas = "";
      if (evidence.current.roas !== null) {
        roas = ` ROAS ${printer.ratio("roas", evidence.current.roas)}×`;
        if (evidence.previous.roas !== null) {
          roas += ` (was ${printer.ratio("previousRoas", evidence.previous.roas)}×)`;
        }
        roas += ".";
      }
      return `"${campaign}": ${cost} per key event over the last ${days} days, ${before} before (${sign}${change}).${roas}`;
    }
    case "AN15": {
      const money = GOAL_FORMAT[evidence.metricKey] === "money";
      const value = (name: string, amount: number) =>
        money ? printer.money(name, amount) : printer.count(name, amount);
      printer.subject("goal", evidence.goalTitle);
      const left = Math.max(0, evidence.daysInMonth - evidence.dayOfMonth);
      const leftText = printer.count("daysLeft", left);
      return `On pace for ${value("forecast", evidence.forecast)} of ${value("target", evidence.target)} (${printer.rate("pace", evidence.paceRatio)}) with ${leftText} ${left === 1 ? "day" : "days"} left.`;
    }
  }
}

const HOLIDAY_SENTENCE = "Includes a public holiday.";

function withHoliday(text: string, evidence: GaFindingEvidence): string {
  if (evidenceHolidays(evidence).length === 0) return text;
  return text ? `${text} ${HOLIDAY_SENTENCE}` : HOLIDAY_SENTENCE;
}

// --- Etki ------------------------------------------------------------------

type ImpactFinding = Pick<GaFindingView, "ruleKey" | "evidence">;

// Kural cümlesi: tahminin neye dayandığı. Bilinmeyen kuralda yalnız sayı.
function impactSentence(
  amount: string,
  noun: string,
  finding: ImpactFinding | undefined,
): string {
  const plain = `About +${amount} ${noun} a week`;
  const evidence = finding?.evidence;
  if (!evidence) return plain;
  switch (evidence.rule) {
    case "AN3":
      return evidence.variant === "cro"
        ? `${plain} if this page converted like the rest of the site`
        : `About ${amount} ${noun} a week already come from this page`;
    case "AN4":
      if (evidence.direction === "above") {
        return `${plain} above the site average`;
      }
      return evidence.measure === "engagement"
        ? `${plain} if this channel engaged like the rest of the site`
        : `${plain} if this channel converted like the rest of the site`;
    case "AN5":
      return `${plain} if mobile converted closer to desktop`;
    case "AN9":
      return `About ${amount} ${noun} a week land on missing pages`;
    case "AN11":
      return `${plain} if this step worked like in earlier weeks`;
    case "AN12":
      return evidence.direction === "above"
        ? `${plain} above the site average`
        : `${plain} if this campaign converted like the rest of the site`;
    case "AN15":
      return `About ${amount} more ${noun} a week needed to reach the goal`;
    default:
      return plain;
  }
}

function printImpact(
  impact: GaImpact | null,
  printer: Printer,
  finding: ImpactFinding | undefined,
): string | null {
  if (!impact || !Number.isFinite(impact.perWeek)) return null;
  let amount: string;
  let noun: string;
  if (impact.metric === "revenue") {
    if (round2(Math.abs(impact.perWeek)) === 0) return null;
    amount = printer.money("impactPerWeek", impact.perWeek);
    noun = "revenue";
  } else {
    const rounded = Math.abs(Math.round(impact.perWeek));
    if (rounded === 0) return null;
    amount = printer.count("impactPerWeek", impact.perWeek);
    const [one, many] = IMPACT_NOUNS[impact.metric];
    noun = rounded === 1 ? one : many;
  }
  const sentence = impactSentence(amount, noun, finding);
  return impact.directional ? `${sentence} (directional)` : sentence;
}

// --- Dışa açık metinler ------------------------------------------------------

export function findingDetail(
  f: GaFindingView,
  options: Currency = {},
): string {
  const printer = new Printer(options.currency ?? null);
  return withHoliday(printDetail(f, printer), f.evidence);
}

// Etki cümlesi; `finding` verilince kurala özgü yan cümle eklenir.
export function findingImpactText(
  impact: GaImpact | null,
  options: Currency & { finding?: ImpactFinding } = {},
): string | null {
  const printer = new Printer(options.currency ?? null);
  return printImpact(impact, printer, options.finding);
}

export function findingPeriodText(period: GaPeriod): string {
  return printPeriod(period, new Printer(null));
}

export function findingConfidenceText(
  confidence: GaFindingConfidence,
): "Significant" | "Directional" {
  return confidence === "SIGNIFICANT" ? "Significant" : "Directional";
}

export function outcomeText(outcome: GaFindingOutcome): string {
  switch (outcome) {
    case "WORKED":
      return "It worked";
    case "DIDNT":
      return "No clear effect";
    case "INCONCLUSIVE":
      return "Not enough data to tell";
  }
}

// "Nov 12" mülk saat diliminde; bilinmeyen dilimde UTC.
function monthDay(iso: string, timeZone: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: timeZone || "UTC",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(date);
  }
}

// Uygulama içi durum satırı; OPEN bulguda yalnız tekrar sayısı.
export function findingStatusText(
  f: GaFindingView,
  options: { timeZone: string },
): string | null {
  switch (f.status) {
    case "ACCEPTED":
      return f.evaluable
        ? "Accepted — mark it done when the change is live"
        : "Noted";
    case "DONE": {
      const until = f.evaluateAfter
        ? monthDay(f.evaluateAfter, options.timeZone)
        : null;
      return until ? `Measuring results until ${until}` : "Measuring results";
    }
    case "EVALUATED":
      return f.outcome ? outcomeText(f.outcome) : null;
    case "OPEN":
      return f.occurrences >= 2
        ? `Seen ${f.occurrences} periods in a row`
        : null;
    default:
      return null;
  }
}

// /health listesi: kayıt başlığı + yön/çeşit kelimesi; rakam ve konu yok.
export function operatorFindingTitle(
  ruleKey: GaRuleKey,
  kind: GaFindingKind,
): string {
  const title = gaRule(ruleKey).title;
  switch (ruleKey) {
    case "AN3":
      return `${title}: ${kind === "WIN" ? "promote" : "improve"}`;
    case "AN4":
    case "AN12":
      return `${title}: ${kind === "WIN" ? "above the rest" : "below the rest"}`;
    default:
      return title;
  }
}

const DIGIT = /\d/;

// Son güvence: rakam taşıyan metin yerine kayıt başlığı.
function digitFree(text: string, fallback: string): string {
  return DIGIT.test(text) ? fallback : text;
}

function signalTitle(
  f: Pick<GaFindingView, "ruleKey" | "kind" | "evidence">,
): string {
  const evidence = f.evidence;
  switch (evidence.rule) {
    case "AN2": {
      const top = evidence.channels.components[0];
      const named = top && DEFAULT_CHANNELS.has(top.label) ? top : null;
      const channel = named ? named.label : "Your website";
      const down = named ? named.total < 0 : evidence.change < 0;
      const amount =
        evidence.metric === "revenue"
          ? down
            ? "less"
            : "more"
          : down
            ? "fewer"
            : "more";
      return `${channel} brought ${amount} ${CHANGE_NOUNS[evidence.metric]} (${COMPARISON_WORDS[evidence.comparison]})`;
    }
    case "AN3":
      return evidence.variant === "promote"
        ? "A landing page turns visitors into key events"
        : "A landing page gets visits but few key events";
    case "AN7": {
      if (evidence.firstSeen) return "AI assistants started sending visitors";
      const top = evidence.assistants[0]?.name;
      return top && ASSISTANT_NAMES.has(top)
        ? `Visits from ${top} and other AI assistants are growing`
        : "Visits from AI assistants are growing";
    }
    default:
      return gaRule(f.ruleKey).title;
  }
}

// Sinyal metni: değer, yol, terim ve kampanya adı yok (Telegram'a ulaşabilir).
export function findingSignalText(
  f: Pick<
    GaFindingView,
    "ruleKey" | "kind" | "subject" | "subjectLabel" | "evidence" | "confidence"
  >,
): { title: string; summary: string } {
  const fallback = gaRule(f.ruleKey).title;
  const strength =
    f.confidence === "SIGNIFICANT" ? "significant" : "directional";
  return {
    title: digitFree(signalTitle(f), fallback),
    summary: `Agentelse found a ${strength} change in your website's Google Analytics data. Open the Website page for the details.`,
  };
}

// Yalnız WORKED sonucunda yazılan öğrenme; sinyal metniyle aynı kısıtlar.
export function learningText(input: {
  ruleKey: GaRuleKey;
  evidence: GaFindingEvidence;
}): string {
  const evidence = input.evidence;
  const fallback = `Acting on a website insight (${gaRule(input.ruleKey).title.toLowerCase()}) improved results.`;
  let text: string;
  switch (evidence.rule) {
    case "AN3":
      text =
        evidence.variant === "cro"
          ? "Improving a landing page that got visits but few key events raised its key event rate."
          : "Promoting a landing page that already converted well brought it more visits.";
      break;
    case "AN4": {
      const measure =
        evidence.measure === "engagement" ? "engagement" : "key event rate";
      text = DEFAULT_CHANNELS.has(evidence.channel)
        ? `Improving ${evidence.channel} traffic raised its ${measure}.`
        : `Improving a traffic channel raised its ${measure}.`;
      break;
    }
    case "AN5":
      text = "Fixing the mobile experience raised mobile key events.";
      break;
    case "AN9":
      text = "Fixing links to missing pages cut visits to error pages.";
      break;
    case "AN11": {
      const from = FUNNEL_LABELS[evidence.step.from];
      const to = FUNNEL_LABELS[evidence.step.to];
      text =
        from && to
          ? `Fixing the ${from} → ${to} shop step raised its completion rate.`
          : "Fixing a shop step raised its completion rate.";
      break;
    }
    case "AN12":
      text = "Improving an underperforming campaign raised its key event rate.";
      break;
    default:
      text = fallback;
  }
  return digitFree(text, fallback);
}

// findingDetail/findingImpactText/findingPeriodText'in yazdığı her sayı (aynı
// yuvarlama) ve en fazla 3 konu metni. Açıklama isteminin olgu listesi.
export function findingFacts(
  f: GaFindingView,
  options: Currency = {},
): Record<string, unknown> {
  const printer = new Printer(options.currency ?? null);
  printDetail(f, printer);
  printImpact(f.impact, printer, f);
  printPeriod(f.period, printer);
  switch (f.evidence.rule) {
    case "AN3":
      printer.subject("page", f.evidence.page);
      break;
    case "AN4":
      printer.subject("channel", f.evidence.channel);
      break;
    default:
      break;
  }
  return printer.facts;
}
