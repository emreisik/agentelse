import type { FunnelResult } from "./types";

// Huni için deterministik özet cümle (GA-F8). LLM yok; adların hepsi
// kullanıcının tanımından gelir (Google'ın yanıtındaki ad kullanılmaz).
// Saf modül.

export const FUNNEL_MIN_USERS = 30;
export const FUNNEL_NOT_ENOUGH =
  "Not enough visitors in this period to read the funnel.";

export type FunnelInsight = {
  headline: string;
  // İlk adımdan son adıma kalan pay (0..1); okunamıyorsa null.
  overall: number | null;
  biggestDrop: {
    fromIndex: number;
    toIndex: number;
    lostUsers: number;
    // 0..1: önceki adımdaki kullanıcıların yüzde kaçı bırakıp gitti.
    dropRate: number;
  } | null;
};

export function formatFunnelPercent(share: number): string {
  const percent = Math.round(share * 100);
  if (share > 0 && percent === 0) return "<1%";
  return `${percent}%`;
}

export function funnelInsight(
  steps: readonly { name: string }[],
  result: FunnelResult,
): FunnelInsight {
  const users = steps.map((_, index) => result.steps[index]?.users ?? 0);
  const first = users[0] ?? 0;
  if (steps.length < 2 || first < FUNNEL_MIN_USERS) {
    return { headline: FUNNEL_NOT_ENOUGH, overall: null, biggestDrop: null };
  }

  let biggestDrop: FunnelInsight["biggestDrop"] = null;
  for (let index = 1; index < users.length; index += 1) {
    const before = users[index - 1] ?? 0;
    const now = users[index] ?? 0;
    if (before <= 0) continue;
    const lostUsers = Math.max(0, before - now);
    const dropRate = lostUsers / before;
    if (lostUsers > 0 && (!biggestDrop || dropRate > biggestDrop.dropRate)) {
      biggestDrop = { fromIndex: index - 1, toIndex: index, lostUsers, dropRate };
    }
  }

  const last = users[users.length - 1] ?? 0;
  const overall = Math.min(1, last / first);
  const firstName = steps[0]?.name ?? "";
  const lastName = steps[steps.length - 1]?.name ?? "";
  const overallText = `${formatFunnelPercent(overall)} of people who reached "${firstName}" went on to "${lastName}".`;
  if (!biggestDrop) {
    return { headline: overallText, overall, biggestDrop: null };
  }
  const from = steps[biggestDrop.fromIndex]?.name ?? "";
  const to = steps[biggestDrop.toIndex]?.name ?? "";
  return {
    headline: `${overallText} The biggest drop is between "${from}" and "${to}": ${formatFunnelPercent(biggestDrop.dropRate)} leave there.`,
    overall,
    biggestDrop,
  };
}
