import { formatCount, formatMoney } from "@/lib/module-flows/analytics/format";

import type {
  An2Evidence,
  GaDecompositionComponent,
  GaDecompositionMetric,
} from "./types";

// explain_website_change'in belirlenimci İngilizce yanıtı (docs/website-
// insights.md "LLM"). Metin yalnız kanıttaki sayıları yazar; yazdığı her
// sayı (gün ve yıl dahil) aynı yuvarlamayla `facts`'e girer, böylece
// keepSupportedSentences(answer, allowedNumbersOf(facts)) metni olduğu gibi
// bırakır. Sayımlar tam sayıya, yüzdeler tek ondalığa yuvarlanır; gün başına
// (MoM) değerler tek ondalık, para iki ondalık. Saf.

export type GaChangeAnswerSignificance =
  "significant" | "not_significant" | "low_volume";

const MONTHS = [
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

const METRIC_LABELS: Record<GaDecompositionMetric, string> = {
  keyEvents: "Key events",
  sessions: "Visits",
  revenue: "Revenue",
};

const MAX_COMPONENTS = 3;

const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

const SIGNIFICANCE_TEXT: Record<GaChangeAnswerSignificance, string> = {
  significant: "This change is statistically significant.",
  not_significant: "This change is within normal variation.",
  low_volume: "There is too little data to call this change significant.",
};

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  // -0 yazılmasın.
  return rounded === 0 ? 0 : rounded;
}

type Formatter = {
  round: (value: number) => number;
  text: (value: number) => string;
};

// Metriğin değeri nasıl yazılır: sayım tam sayı (gün başına tek ondalık),
// gelir para biçimi.
function valueFormatter(
  metric: GaDecompositionMetric,
  perDay: boolean,
  currency: string | null,
): Formatter {
  if (metric === "revenue") {
    return {
      round: (value) => roundTo(value, 2),
      text: (value) => formatMoney(roundTo(value, 2), currency),
    };
  }
  return perDay
    ? {
        round: (value) => roundTo(value, 1),
        text: (value) => ONE_DECIMAL.format(roundTo(value, 1)),
      }
    : {
        round: (value) => roundTo(value, 0),
        text: (value) => formatCount(roundTo(value, 0)),
      };
}

function sessionsFormatter(perDay: boolean): Formatter {
  return perDay
    ? {
        round: (value) => roundTo(value, 1),
        text: (value) => ONE_DECIMAL.format(roundTo(value, 1)),
      }
    : {
        round: (value) => roundTo(value, 0),
        text: (value) => formatCount(roundTo(value, 0)),
      };
}

function percentText(value: number): string {
  return `${ONE_DECIMAL.format(roundTo(value, 1))}%`;
}

type DayParts = { year: number; month: string; day: number };

function partsOf(day: string): DayParts {
  const [year, month, date] = day.split("-").map(Number);
  return {
    year: year ?? 0,
    month: MONTHS[(month ?? 1) - 1] ?? "",
    day: date ?? 0,
  };
}

// "Sep 28 – Oct 4", yıl gerekiyorsa "Sep 28 – Oct 4, 2025" ya da
// "Dec 29, 2025 – Jan 4, 2026". Yazılan gün ve yıl sayıları `numbers`'a.
function rangeText(
  range: { from: string; to: string },
  withYear: boolean,
  numbers: number[],
): string {
  const from = partsOf(range.from);
  const to = partsOf(range.to);
  numbers.push(from.day, to.day);
  const fromText = `${from.month} ${from.day}`;
  const toText = `${to.month} ${to.day}`;
  if (!withYear) {
    return range.from === range.to ? fromText : `${fromText} – ${toText}`;
  }
  numbers.push(from.year, to.year);
  if (range.from === range.to) return `${fromText}, ${from.year}`;
  return from.year === to.year
    ? `${fromText} – ${toText}, ${to.year}`
    : `${fromText}, ${from.year} – ${toText}, ${to.year}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

type ComponentFacts = {
  label: string;
  visits: number;
  volume: number;
  rate: number | null;
  rateBefore: number | null;
  rateAfter: number | null;
  total: number | null;
};

function componentSentence(
  component: GaDecompositionComponent,
  metric: GaDecompositionMetric,
  perDay: boolean,
  value: Formatter,
): { text: string; facts: ComponentFacts } {
  const sessions = sessionsFormatter(perDay);
  const sessionsChange = component.sessionsAfter - component.sessionsBefore;
  const visits = sessions.round(Math.abs(sessionsChange));
  const visitsPart =
    visits === 0
      ? "kept the same number of visits"
      : `${sessionsChange > 0 ? "gained" : "lost"} ${sessions.text(Math.abs(sessionsChange))} visits`;
  // Hacim payı: oturumda sayım, KE'de tek ondalık, gelirde para.
  const share: Formatter =
    metric === "revenue"
      ? value
      : {
          round: (v) => roundTo(v, 1),
          text: (v) => ONE_DECIMAL.format(roundTo(v, 1)),
        };
  const volume = share.round(Math.abs(component.volume));
  const facts: ComponentFacts = {
    label: component.label,
    visits,
    volume,
    rate: null,
    rateBefore: null,
    rateAfter: null,
    total: null,
  };

  if (metric === "sessions") {
    return {
      text: `${component.label}: ${visitsPart}, which explains ${share.text(Math.abs(component.volume))} of the change.`,
      facts,
    };
  }
  if (component.rateBefore === null || component.rateAfter === null) {
    facts.total = share.round(Math.abs(component.total));
    return {
      text: `${component.label}: ${visitsPart}, which together with its ${metric === "revenue" ? "revenue per visit" : "conversion rate"} explains ${share.text(Math.abs(component.total))} of the change.`,
      facts,
    };
  }
  facts.rate = share.round(Math.abs(component.rate));
  if (metric === "revenue") {
    facts.rateBefore = roundTo(component.rateBefore, 2);
    facts.rateAfter = roundTo(component.rateAfter, 2);
    return {
      text: `${component.label}: ${visitsPart}, which explains ${share.text(Math.abs(component.volume))} of the change; its revenue per visit went from ${value.text(component.rateBefore)} to ${value.text(component.rateAfter)}, which explains ${share.text(Math.abs(component.rate))}.`,
      facts,
    };
  }
  facts.rateBefore = roundTo(component.rateBefore * 100, 1);
  facts.rateAfter = roundTo(component.rateAfter * 100, 1);
  return {
    text: `${component.label}: ${visitsPart}, which explains ${share.text(Math.abs(component.volume))} of the change; its conversion rate went from ${percentText(component.rateBefore * 100)} to ${percentText(component.rateAfter * 100)}, which explains ${share.text(Math.abs(component.rate))}.`,
    facts,
  };
}

export function changeAnswer(input: {
  evidence: An2Evidence;
  significance: GaChangeAnswerSignificance;
  currency: string | null;
}): { answer: string; facts: Record<string, unknown> } {
  const { evidence, significance, currency } = input;
  const metric = evidence.metric;
  const perDay = evidence.channels.perDay;
  const value = valueFormatter(metric, perDay, currency);
  const label = METRIC_LABELS[metric];
  const verb = metric === "revenue" ? "was" : "were";
  const unit = perDay ? " a day" : "";

  const dates: number[] = [];
  const years = new Set(
    [
      evidence.current.from,
      evidence.current.to,
      evidence.previous.from,
      evidence.previous.to,
    ].map((day) => day.slice(0, 4)),
  );
  const withYear = evidence.comparison === "yoy" || years.size > 1;
  const currentRange = rangeText(evidence.current, withYear, dates);
  const previousRange = rangeText(evidence.previous, withYear, dates);

  // Gün başına karşılaştırmada değerler ayrıştırmanın normalleştirilmiş
  // önce/sonra değerleridir; değişim de aynı ölçektedir.
  const after = evidence.channels.after;
  const before = evidence.channels.before;
  const sentences: string[] = [];
  const facts: Record<string, unknown> = {
    metric,
    comparison: evidence.comparison,
    perDay,
    significance,
    currency,
    current: value.round(after),
    previous: value.round(before),
    dates,
  };

  if (evidence.changePct === null) {
    sentences.push(
      `${label} ${verb} ${value.text(after)}${unit} in ${currentRange} against none in ${previousRange}.`,
    );
  } else {
    const change = value.round(Math.abs(evidence.change));
    const changePct = roundTo(Math.abs(evidence.changePct), 1);
    facts.change = change;
    facts.changePct = changePct;
    const movement =
      change === 0
        ? "unchanged"
        : `${evidence.change > 0 ? "up" : "down"} ${value.text(Math.abs(evidence.change))} (${percentText(Math.abs(evidence.changePct))})`;
    sentences.push(
      `${label} ${verb} ${value.text(after)}${unit} in ${currentRange} against ${value.text(before)}${unit} in ${previousRange}, ${movement}.`,
    );
  }
  sentences.push(SIGNIFICANCE_TEXT[significance]);
  if (evidence.metricReason === "low_key_events") {
    sentences.push(
      "There were too few key events to compare, so this looks at visits.",
    );
  }

  const components = evidence.channels.components
    .filter((component) => component.total !== 0)
    .slice(0, MAX_COMPONENTS)
    .map((component) => componentSentence(component, metric, perDay, value));
  for (const component of components) sentences.push(component.text);
  facts.components = components.map((component) => component.facts);

  const suspect = evidence.suspectDays.length;
  if (suspect > 0) {
    sentences.push(
      `${plural(suspect, "day")} in this period had a tracking problem.`,
    );
    facts.suspectDays = suspect;
  }
  const holidays = evidence.holidays.length;
  if (holidays > 0) {
    sentences.push(
      `This period includes ${plural(holidays, "public holiday")}.`,
    );
    facts.holidays = holidays;
  }
  if (evidence.preliminary) {
    sentences.push(
      "The most recent days are still preliminary and may change.",
    );
  }

  return { answer: sentences.join(" "), facts };
}
