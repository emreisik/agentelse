import type { ShadowScorecard } from "@/lib/ads/rules/shadow-score";
import { formatMoney } from "../money";
import { nameWithoutTag } from "../operation-tag";

// Haftalık ve aylık Ads raporlarının metni (docs/meta-ads-plan.md §3.7).
// Her sayı aynadan gelir; atıf etiketi ve "son günler değişebilir" notu
// her raporda vardır. Saf.

export type ReportTotals = {
  spendMinor: number;
  results: number | null;
  resultLabel: string;
  impressions: number;
  linkClicks: number;
  // Dönem okumasından (günlük satırlardan toplanmaz); okunamazsa null.
  reach: number | null;
  frequency: number | null;
};

export type ReportCreative = {
  name: string;
  spendMinor: number;
  results: number | null;
};

export type ReportDecision = {
  text: string;
  outcome: string | null;
};

const COUNT = new Intl.NumberFormat("en-US");

function cost(totals: ReportTotals, currency: string | null): string | null {
  return totals.results && totals.results > 0
    ? formatMoney(Math.round(totals.spendMinor / totals.results), currency)
    : null;
}

function change(now: number, before: number): string {
  if (!before) return "";
  const value = Math.round(((now - before) / before) * 100);
  return ` (${value > 0 ? "+" : ""}${value}% vs the week before)`;
}

// Gölge karnesinin tek satırı: kaç öneri ölçüldü, kaçı bir hafta sonra hâlâ
// gerçek bir sorunu işaret ediyordu, sen kaçında aynısını yaptın.
export function shadowLine(card: ShadowScorecard, currency: string | null): string {
  const pct = (value: number | null) =>
    value === null ? null : `${Math.round(value * 100)}%`;
  const parts = [
    `Optimizer test run (suggestions only, nothing was changed): ${card.total} judged.`,
  ];
  const still = pct(card.persistence);
  if (still) parts.push(`${still} still pointed at a real problem a week later.`);
  const agreed = pct(card.agreement);
  if (agreed) parts.push(`You made the same change on ${agreed}.`);
  if (card.exposureMinor > 0) {
    parts.push(
      `${formatMoney(card.exposureMinor, currency)} kept going to the flagged ads that week.`,
    );
  }
  parts.push(
    card.readiness === "READY"
      ? "Enough evidence to let it act within its limits."
      : card.readiness === "NOISY"
        ? "Too many suggestions fixed themselves; not ready to act."
        : "Not enough judged suggestions yet.",
  );
  return parts.join(" ");
}

export function weeklyReportText(input: {
  periodLabel: string;
  currency: string | null;
  current: ReportTotals;
  previous: ReportTotals;
  target: { label: string; valueMinor: number } | null;
  diagnosis: string | null;
  creatives: ReportCreative[];
  decisions: ReportDecision[];
  pending: number;
  metaSuggests: string[];
  attribution: string | null;
  // Optimizer gölge modundaki karne (yoksa satır yazılmaz).
  shadow?: ShadowScorecard | null;
}): string {
  const { current, previous, currency } = input;
  const lines: string[] = [`Ads week ${input.periodLabel}`];
  const nowCost = cost(current, currency);
  lines.push(
    `Spent ${formatMoney(current.spendMinor, currency)}${change(current.spendMinor, previous.spendMinor)}.` +
      (current.results !== null
        ? ` ${COUNT.format(current.results)} ${current.resultLabel.toLowerCase()}${nowCost ? ` at ${nowCost} each` : ""}.`
        : " Results unknown for this setup."),
  );
  if (input.target && nowCost && current.results) {
    const actual = Math.round(current.spendMinor / current.results);
    lines.push(
      actual <= input.target.valueMinor
        ? `On target: ${input.target.label} ${formatMoney(input.target.valueMinor, currency)} or less.`
        : `Above target: ${input.target.label} should be ${formatMoney(input.target.valueMinor, currency)} or less.`,
    );
  }
  if (current.reach !== null) {
    lines.push(
      `Reached ${COUNT.format(current.reach)} people${current.frequency ? `, each about ${current.frequency.toFixed(1)} times` : ""}.`,
    );
  }
  if (input.diagnosis) lines.push(input.diagnosis);
  if (input.creatives.length > 0) {
    lines.push("Ads that carried the week (directional):");
    for (const creative of input.creatives) {
      lines.push(
        `• ${nameWithoutTag(creative.name)}: ${formatMoney(creative.spendMinor, currency)}${creative.results !== null ? `, ${COUNT.format(creative.results)} results` : ""}`,
      );
    }
  }
  if (input.decisions.length > 0) {
    lines.push("Changes and how they did:");
    for (const decision of input.decisions) {
      lines.push(`• ${decision.text}${decision.outcome ? ` → ${decision.outcome.toLowerCase()}` : ""}`);
    }
  }
  if (input.pending > 0) {
    lines.push(`${input.pending} suggestion${input.pending === 1 ? " is" : "s are"} waiting for you.`);
  }
  if (input.metaSuggests.length > 0) {
    lines.push(`Meta suggests (a second opinion, never applied by itself): ${input.metaSuggests.join("; ")}.`);
  }
  if (input.shadow && input.shadow.total > 0) {
    lines.push(shadowLine(input.shadow, currency));
  }
  lines.push(
    `Meta's numbers${input.attribution ? `, attribution ${input.attribution}` : ""}, account time. Recent days may still change.`,
  );
  return lines.join("\n");
}

export function monthlyReportText(input: {
  monthLabel: string;
  currency: string | null;
  totals: ReportTotals;
  goals: { title: string; current: number | null; target: number | null }[];
  decisionsWorked: number;
  decisionsTotal: number;
  learnings: number;
  nextEnvelopeMinor: number | null;
  adLibraryUrl: string;
}): string {
  const { totals, currency } = input;
  const lines: string[] = [`Ads month ${input.monthLabel}`];
  const each = cost(totals, currency);
  lines.push(
    `Spent ${formatMoney(totals.spendMinor, currency)}` +
      (totals.results !== null
        ? `, ${COUNT.format(totals.results)} ${totals.resultLabel.toLowerCase()}${each ? ` at ${each} each` : ""}.`
        : "."),
  );
  if (totals.reach !== null) lines.push(`Reached ${COUNT.format(totals.reach)} people.`);
  for (const goal of input.goals) {
    lines.push(
      `Goal: ${goal.title}${goal.current !== null ? ` (now ${goal.current})` : ""}.`,
    );
  }
  if (input.decisionsTotal > 0) {
    lines.push(`${input.decisionsWorked} of ${input.decisionsTotal} changes clearly worked.`);
  }
  if (input.learnings > 0) {
    lines.push(`${input.learnings} new lesson${input.learnings === 1 ? "" : "s"} saved to the Brand Brain.`);
  }
  if (input.nextEnvelopeMinor) {
    lines.push(`At today's budgets next month comes to about ${formatMoney(input.nextEnvelopeMinor, currency)}.`);
  }
  lines.push("How many new customers did you get from ads last month? Reply here and Agentelse compares it with Meta's numbers.");
  lines.push(`See what others in your field run: ${input.adLibraryUrl}`);
  lines.push("Meta's numbers, account time. For Markdown or PDF, open Analytics and use Share.");
  return lines.join("\n");
}

export function adLibraryUrl(country: string | null): string {
  const params = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: country ?? "ALL",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}
