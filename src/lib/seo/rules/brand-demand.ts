import { brandDemandCopy } from "./copy";
import { finishRule, makeDraft } from "./helpers";
import type { SeoRule } from "./types";

// SO10 marka talebi: marka ayrımı hazır ve 8 haftanın hepsinde marka gösterimi
// biliniyorsa, son 4 haftanın haftalık ortalaması (R) ilk 4 haftanınkine (P)
// göre ≥ %20 değiştiyse (P ≥ 100). Yeni kabul edilen bir terim sahte talep
// değişimi üretmesin diye ayrım "ready" olmalıdır.

export const SO10_WEEKS = 8;
export const SO10_MIN_IMPRESSIONS = 100;
export const SO10_MIN_CHANGE = 0.2;

export const SO10: SeoRule = {
  key: "SO10_BRAND_DEMAND",
  version: 1,
  querySignal: true,
  evaluate(snapshot) {
    const weeks = [...snapshot.brandWeeks]
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .slice(-SO10_WEEKS);
    const values = weeks.map((w) => w.brandImpressions);
    if (
      !snapshot.brandSplitReady ||
      weeks.length < SO10_WEEKS ||
      values.some((v) => v === null)
    ) {
      return { evaluable: false, reason: "NO_BRAND_SPLIT" };
    }
    const numbers = values as number[];
    const P = numbers.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
    const R = numbers.slice(4).reduce((s, v) => s + v, 0) / 4;
    if (P < SO10_MIN_IMPRESSIONS || Math.abs(R - P) / P < SO10_MIN_CHANGE) {
      return { evaluable: true, drafts: [], seen: [] };
    }
    const metrics = {
      weeklyImpressions: Math.round(R),
      previousWeeklyImpressions: Math.round(P),
      changePercent: Math.round((Math.abs(R - P) / P) * 100),
    };
    const draft = makeDraft(snapshot, {
      ruleKey: "SO10_BRAND_DEMAND",
      kind: "CHANGE",
      subject: "site:brand",
      severity: "INFO",
      confidence: "SIGNIFICANT",
      effort: "VARIES",
      actionKind: "INVESTIGATE",
      impact: null,
      ...brandDemandCopy(metrics),
      evidence: {
        window: snapshot.current,
        compare: snapshot.previous,
        metrics,
      },
      signalWorthy: true,
    });
    return finishRule([{ draft, rank: 0 }], 1);
  },
};
