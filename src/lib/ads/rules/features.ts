import { addDays } from "../sync-plan";

// Optimizasyon özellikleri (docs/meta-ads-plan.md §3.5 adım 1): nesne başına
// bugün, dün, 3 gün, 7 gün, önceki 7 gün ve 28 günlük taban. Erişim ve sıklık
// tekil kişi metrikleridir: pencere değerleri windowStats'tan gelir. Saf.

export type DayRow = {
  date: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  results: number | null;
  video3s: number | null;
  thruplays: number | null;
};

export type Window = {
  days: number;
  spendMinor: number;
  impressions: number;
  linkClicks: number;
  // null: bu pencerede sonuç bilinmiyor (yedek eşleme yok).
  results: number | null;
  video3s: number;
  thruplays: number;
  cpaMinor: number | null;
  // Bağlantı tıklama oranı (0-1).
  linkCtr: number | null;
  cpmMinor: number | null;
  // 3 sn oynatma / gösterim ve ThruPlay / 3 sn oynatma.
  hookRate: number | null;
  holdRate: number | null;
};

export function windowOf(
  rows: readonly DayRow[],
  since: string,
  until: string,
): Window {
  const inRange = rows.filter((row) => row.date >= since && row.date <= until);
  let spendMinor = 0;
  let impressions = 0;
  let linkClicks = 0;
  let results: number | null = null;
  let video3s = 0;
  let thruplays = 0;
  for (const row of inRange) {
    spendMinor += row.spendMinor;
    impressions += row.impressions;
    linkClicks += row.linkClicks;
    if (row.results !== null) results = (results ?? 0) + row.results;
    video3s += row.video3s ?? 0;
    thruplays += row.thruplays ?? 0;
  }
  const days =
    Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
  return {
    days,
    spendMinor,
    impressions,
    linkClicks,
    results,
    video3s,
    thruplays,
    cpaMinor: results && results > 0 ? spendMinor / results : null,
    linkCtr: impressions > 0 ? linkClicks / impressions : null,
    cpmMinor: impressions > 0 ? (spendMinor / impressions) * 1000 : null,
    hookRate: impressions > 0 && video3s > 0 ? video3s / impressions : null,
    holdRate: video3s > 0 ? thruplays / video3s : null,
  };
}

export type Features = {
  today: Window;
  yesterday: Window;
  d3: Window;
  d7: Window;
  prev7: Window;
  d28: Window;
  // windowStats'tan (yoksa null).
  frequency7d: number | null;
  frequency28d: number | null;
  learningStatus: string | null;
  lastSigEditAt: Date | null;
  ageDays: number;
};

export function featuresOf(input: {
  rows: readonly DayRow[];
  // Hesap gününe göre bugün.
  today: string;
  windowStats?: unknown;
  learningStatus?: string | null;
  lastSigEditAt?: Date | null;
  createdAt: Date;
  now: Date;
}): Features {
  const { rows, today } = input;
  const yesterday = addDays(today, -1);
  const stats = (input.windowStats ?? {}) as {
    d7?: { frequency?: number };
    d28?: { frequency?: number };
  };
  return {
    today: windowOf(rows, today, today),
    yesterday: windowOf(rows, yesterday, yesterday),
    d3: windowOf(rows, addDays(today, -3), yesterday),
    d7: windowOf(rows, addDays(today, -7), yesterday),
    prev7: windowOf(rows, addDays(today, -14), addDays(today, -8)),
    d28: windowOf(rows, addDays(today, -28), yesterday),
    frequency7d: typeof stats.d7?.frequency === "number" ? stats.d7.frequency : null,
    frequency28d: typeof stats.d28?.frequency === "number" ? stats.d28.frequency : null,
    learningStatus: input.learningStatus ?? null,
    lastSigEditAt: input.lastSigEditAt ?? null,
    ageDays: Math.floor((input.now.getTime() - input.createdAt.getTime()) / 86_400_000),
  };
}
