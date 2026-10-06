import { formatMoney } from "../money";
import { nameWithoutTag } from "../operation-tag";

import type { RuleCandidate } from "./optimize-rules";

// Kararın açıklaması (docs/meta-ads-plan.md §3.5 adım 4): şablon metin, her
// sayı kanıttan gelir (model sayı uyduramaz). Saf.

function pct(value: unknown): string {
  return typeof value === "number" ? `${Math.round(Math.abs(value) * 100)}%` : "";
}

export function explainDecision(
  candidate: RuleCandidate,
  context: { name: string; currency: string | null },
): string {
  const e = candidate.evidence;
  const money = (value: unknown) =>
    typeof value === "number" ? formatMoney(value, context.currency) : "";
  const name = nameWithoutTag(context.name);
  switch (candidate.ruleKey) {
    case "G3_ZERO_RESULTS":
      return `${name} spent ${money(e.spendMinor)} over the last days with no results. Pausing it stops the spend while you check the setup or tracking.`;
    case "O2_HIGH_CPA":
      return `${name} cost ${money(e.cpaMinor)} per result over 7 days, above the target of ${money(e.targetMinor)}. Lowering the daily budget from ${money(candidate.change?.from)} to ${money(candidate.change?.to)} cuts the spend while Meta finds cheaper results.`;
    case "O3_SCALE":
      return `${name} got ${e.results} results at ${money(e.cpaMinor)} each over 7 days, under the target of ${money(e.targetMinor)}. Raising the daily budget by 20% to ${money(candidate.change?.to)} can bring more at a similar cost.`;
    case "O8_LEARNING_LIMITED":
      return `${name} has been "learning limited" for ${e.ageDays} days: Meta doesn't get enough results to optimize.${typeof e.suggestedDailyMinor === "number" ? ` A daily budget near ${money(e.suggestedDailyMinor)}, a more frequent result or a wider audience helps.` : " A more frequent result or a wider audience helps."}`;
    case "O14_CREATIVE_CADENCE":
      return `${name} has had no new ad for ${e.newestAdAgeDays} days. A fresh idea now keeps results steady before people tire of the current ads.`;
    case "O4_FATIGUE":
      return `${name} is showing tiredness${typeof e.ctrChange === "number" ? `: link clicks are down ${pct(e.ctrChange)} on last week` : ""}${typeof e.frequency7d === "number" ? `, people see it ${e.frequency7d} times a week` : ""}. New ideas are on your Ideas board.`;
    case "O5_LOSER_AD":
      return `${name} spent ${money(e.spendMinor)} with no results while the other ads in its ad set deliver. Pausing it moves the budget to them.`;
    case "O6_LOW_CTR":
      return `${name} gets ${pct(e.linkCtr)} link clicks per view, well under this account's ${pct(e.accountLinkCtr)}. A sharper first line or offer usually helps.`;
    case "O7_WEAK_HOOK":
      return `Only ${pct(e.hookRate)} of people watch the first 3 seconds of ${name}. A stronger opening shot helps.`;
    case "O13_WEAK_HOLD":
      return `Only ${pct(e.holdRate)} of the people who start ${name} keep watching. A tighter middle and pace helps.`;
    default:
      return `${name}: ${candidate.kind.toLowerCase().replace(/_/g, " ")}.`;
  }
}
