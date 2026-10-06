// Teşhis ağacı (docs/meta-ads-plan.md §3.7): CPA = (CPM / 1000) / (link CTR ×
// CVR). Haftalık değişim log farklarıyla bileşenlere ayrılır:
// Δln CPA = Δln CPM − Δln CTR − Δln CVR. Saf ve testli.

export type Period = {
  spendMinor: number;
  impressions: number;
  linkClicks: number;
  results: number | null;
};

export type Diagnosis = {
  // Oransal değişimler (0,35 = +%35).
  cpa: number;
  cpm: number;
  ctr: number;
  cvr: number;
  // Payların toplamı CPA'nın log değişimine eşittir.
  shares: { cpm: number; ctr: number; cvr: number };
  text: string;
};

function parts(period: Period) {
  if (!period.impressions || !period.linkClicks || !period.results || !period.spendMinor) {
    return null;
  }
  const cpm = (period.spendMinor / period.impressions) * 1000;
  const ctr = period.linkClicks / period.impressions;
  const cvr = period.results / period.linkClicks;
  const cpa = period.spendMinor / period.results;
  return { cpm, ctr, cvr, cpa };
}

function pct(change: number): string {
  const value = Math.round(change * 100);
  return `${value > 0 ? "+" : ""}${value}%`;
}

const FLAT = 0.05;

export function diagnose(current: Period, previous: Period): Diagnosis | null {
  const now = parts(current);
  const before = parts(previous);
  if (!now || !before) return null;
  const ln = (a: number, b: number) => Math.log(a / b);
  const dCpm = ln(now.cpm, before.cpm);
  const dCtr = ln(now.ctr, before.ctr);
  const dCvr = ln(now.cvr, before.cvr);
  const change = (d: number) => Math.exp(d) - 1;
  const describe = (label: string, d: number, note: string) =>
    Math.abs(change(d)) < FLAT ? `${label} flat` : `${label} ${pct(change(d))}${note}`;
  const cpaChange = Math.exp(dCpm - dCtr - dCvr) - 1;
  const text = `Cost per result ${pct(cpaChange)}: ${[
    describe("CPM", dCpm, dCpm > 0 ? " (auction or season)" : ""),
    describe("link CTR", dCtr, dCtr < 0 ? " (hook or fatigue)" : ""),
    describe("conversion", dCvr, dCvr < 0 ? " (page, offer or form)" : ""),
  ].join(", ")}.`;
  return {
    cpa: cpaChange,
    cpm: change(dCpm),
    ctr: change(dCtr),
    cvr: change(dCvr),
    shares: { cpm: dCpm, ctr: -dCtr, cvr: -dCvr },
    text,
  };
}
