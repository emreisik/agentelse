import { summaryIsEmpty, type ReportSummary } from "./report";

// The cheap honesty check behind the AI summary (docs/modules.md "Analytics"):
// every number the model writes must be one of the report's own numbers, as
// written or rounded ("12,345" may read "12.3K" or "12.345" in Turkish). A
// sentence naming any other number (an invented growth rate, a target, a date)
// is dropped; a sentence without numbers stays. Pure.

// Within 5% (a rounding), or half a unit for small numbers ("4" for 4.2).
const RELATIVE_TOLERANCE = 0.05;
const ABSOLUTE_TOLERANCE = 0.51;
// "12.3K", "1,2 Mn", "3 bin": the number before the word, in thousands and up.
const SCALES = [1, 1e3, 1e6, 1e9] as const;

const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;
const GROUPED_COMMA = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const GROUPED_DOT = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/;
const PLAIN = /^\d+(?:[.,]\d+)?$/;
const SENTENCE_BREAK = /(?<=[.!?…])\s+/u;

// "12 345" (a space between digit groups) is one number in several languages.
function joinSpacedGroups(text: string): string {
  return text.replace(/(\d)[   ](?=\d{3}(?!\d))/g, "$1");
}

export function numberTokens(text: string): string[] {
  return joinSpacedGroups(text).match(NUMBER_TOKEN) ?? [];
}

// What a written number can stand for. "12,345" is twelve thousand in English
// and twelve point three in Turkish; both readings are tried. A token no
// language writes ("05.10.2026") has none, so it is never supported.
export function readingsOf(token: string): number[] {
  const values = new Set<number>();
  const add = (text: string) => {
    const value = Number(text);
    if (Number.isFinite(value)) values.add(value);
  };
  if (GROUPED_COMMA.test(token)) add(token.replace(/,/g, ""));
  if (GROUPED_DOT.test(token)) add(token.replace(/\./g, "").replace(",", "."));
  if (PLAIN.test(token)) add(token.replace(",", "."));
  return [...values];
}

// Every number in the data the model was given, strings included ("1,234.56
// TRY", "Last 28 days", a search for "iphone 15").
export function allowedNumbersOf(data: unknown): number[] {
  const values = new Set<number>();
  const walk = (value: unknown) => {
    if (typeof value === "number") {
      if (Number.isFinite(value)) values.add(value);
    } else if (typeof value === "string") {
      for (const token of numberTokens(value)) {
        for (const reading of readingsOf(token)) values.add(reading);
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return [...values];
}

function near(value: number, target: number): boolean {
  return (
    Math.abs(value - target) <=
    Math.max(ABSOLUTE_TOLERANCE, Math.abs(target) * RELATIVE_TOLERANCE)
  );
}

export function isSupportedToken(
  token: string,
  allowed: readonly number[],
): boolean {
  return readingsOf(token).some((reading) =>
    SCALES.some((scale) =>
      allowed.some((target) => near(reading * scale, target)),
    ),
  );
}

export function keepSupportedSentences(
  text: string,
  allowed: readonly number[],
): string {
  return text
    .split(SENTENCE_BREAK)
    .filter((sentence) =>
      numberTokens(sentence).every((token) => isSupportedToken(token, allowed)),
    )
    .join(" ")
    .trim();
}

// The summary with every unsupported sentence gone; null when nothing is left.
export function checkSummaryNumbers(
  summary: ReportSummary,
  allowed: readonly number[],
): ReportSummary | null {
  const keep = (items: readonly string[]) =>
    items
      .map((item) => keepSupportedSentences(item, allowed))
      .filter((item) => item.length > 0);
  const checked: ReportSummary = {
    headline: keepSupportedSentences(summary.headline, allowed),
    highlights: keep(summary.highlights),
    watchouts: keep(summary.watchouts),
    nextSteps: keep(summary.nextSteps),
  };
  return summaryIsEmpty(checked) ? null : checked;
}
