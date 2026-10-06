import { formatMoney } from "./money";

// Günlük Ads sağlık özeti (docs/meta-ads-plan.md §3.6, K24). Saf: metin ve
// "söylenecek bir şey var mı" kararı. Not edilecek bir şey yoksa özet çıkmaz.

export const DIGEST_LOCAL_TIME = "08:30";

export type DigestFacts = {
  currency: string | null;
  yesterdaySpendMinor: number;
  // Çalışan kampanyaların günlük bütçe toplamı (dünün planı).
  plannedDailyMinor: number;
  runningCampaigns: number;
  criticalAlerts: string[];
  warnAlerts: string[];
  pendingDecisions: number;
  updatedText: string | null;
};

export function digestWorthy(facts: DigestFacts): boolean {
  return (
    facts.yesterdaySpendMinor > 0 ||
    facts.runningCampaigns > 0 ||
    facts.criticalAlerts.length > 0 ||
    facts.warnAlerts.length > 0 ||
    facts.pendingDecisions > 0
  );
}

function pct(actual: number, plan: number): string | null {
  if (plan <= 0) return null;
  const value = Math.round(((actual - plan) / plan) * 100);
  return `${value > 0 ? "+" : ""}${value}%`;
}

export function digestText(facts: DigestFacts): string {
  const lines: string[] = [];
  const spent = formatMoney(facts.yesterdaySpendMinor, facts.currency);
  const diff = pct(facts.yesterdaySpendMinor, facts.plannedDailyMinor);
  lines.push(
    facts.plannedDailyMinor > 0
      ? `Yesterday you spent ${spent} against a plan of ${formatMoney(facts.plannedDailyMinor, facts.currency)}${diff ? ` (${diff})` : ""}.`
      : `Yesterday you spent ${spent}.`,
  );
  lines.push(
    facts.runningCampaigns === 0
      ? "No campaign is running."
      : `${facts.runningCampaigns} campaign${facts.runningCampaigns === 1 ? " is" : "s are"} running.`,
  );
  for (const title of facts.criticalAlerts.slice(0, 3)) lines.push(`Urgent: ${title}.`);
  for (const title of facts.warnAlerts.slice(0, 3)) lines.push(`Check: ${title}.`);
  if (facts.pendingDecisions > 0) {
    lines.push(
      `${facts.pendingDecisions} change${facts.pendingDecisions === 1 ? " is" : "s are"} waiting for your approval.`,
    );
  }
  if (facts.updatedText) lines.push(facts.updatedText);
  return lines.join("\n");
}

export function adsWorkId(projectId: string): string {
  return `ads_${projectId}`;
}

export function digestCommandId(projectId: string, day: string): string {
  return `adsdigest_${projectId}_${day}`;
}
