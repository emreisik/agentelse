import {
  SEO_RULE_KEYS,
  type RuleSnapshot,
  type SeoFindingDraft,
  type SeoRuleKey,
} from "@/lib/seo/opportunity-types";

import { SO10 } from "./brand-demand";
import { SO4 } from "./cannibalization";
import { SO3 } from "./content-decay";
import { SO5 } from "./content-gap";
import { SO2 } from "./ctr-gap";
import { SO8 } from "./internal-links";
import { SO13 } from "./international";
import { SO11 } from "./local-intent";
import { SO7 } from "./lost";
import { SO14 } from "./media-search";
import { SO15 } from "./new-content";
import { SO9 } from "./page-groups";
import { SO12 } from "./rich-results";
import { SO6 } from "./rising-queries";
import { SO1 } from "./striking-distance";
import { SO16 } from "./tech-impact";
import type { RuleSkipReason, SeoRule } from "./types";

// Kural kayıt defteri ve tek koşu (docs/search-opportunities.md "Kurallar").
// - Az veri (şimdiki 28 günde < 1.000 web gösterimi): sorgu kuralları
//   LOW_DATA ile atlanır; SO8, SO12 ve SO16 yine çalışır.
// - Her kural kendi try/catch'inde koşar; hata yalnız o kuralı ERROR yapar.
// - Taslaklar öncelik (azalan), kural sırası, konu ile sıralanır ve 25'te
//   kesilir. Kesilenler seen'de kalır (yaşam döngüsü onları çözmez) ve
//   dropped'da sayılır.

export const SEO_RULES: readonly SeoRule[] = [
  SO1,
  SO2,
  SO3,
  SO4,
  SO5,
  SO6,
  SO7,
  SO8,
  SO9,
  SO10,
  SO11,
  SO12,
  SO13,
  SO14,
  SO15,
  SO16,
];

export const MAX_FINDINGS_PER_RUN = 25;
export const LOW_DATA_IMPRESSIONS = 1000;

export type SeoRulesRun = {
  drafts: SeoFindingDraft[];
  evaluated: SeoRuleKey[];
  seen: { ruleKey: SeoRuleKey; subject: string }[];
  skipped: { ruleKey: SeoRuleKey; reason: RuleSkipReason }[];
  fired: Partial<Record<SeoRuleKey, number>>;
  lowData: boolean;
  dropped: number;
};

const RULE_ORDER: ReadonlyMap<SeoRuleKey, number> = new Map(
  SEO_RULE_KEYS.map((key, index) => [key, index]),
);

export function evaluateSeoRules(
  snapshot: RuleSnapshot,
  options: { only?: readonly SeoRuleKey[] } = {},
): SeoRulesRun {
  const lowData = snapshot.totals.impressions < LOW_DATA_IMPRESSIONS;
  const only = options.only ? new Set(options.only) : null;
  const evaluated: SeoRuleKey[] = [];
  const skipped: SeoRulesRun["skipped"] = [];
  const seen: SeoRulesRun["seen"] = [];
  const all: SeoFindingDraft[] = [];

  for (const rule of SEO_RULES) {
    if (only && !only.has(rule.key)) continue;
    if (lowData && rule.querySignal) {
      skipped.push({ ruleKey: rule.key, reason: "LOW_DATA" });
      continue;
    }
    let result;
    try {
      result = rule.evaluate(snapshot);
    } catch {
      skipped.push({ ruleKey: rule.key, reason: "ERROR" });
      continue;
    }
    if (!result.evaluable) {
      skipped.push({ ruleKey: rule.key, reason: result.reason });
      continue;
    }
    evaluated.push(rule.key);
    const subjects = new Set(result.seen);
    for (const draft of result.drafts) subjects.add(draft.subject);
    for (const subject of subjects) seen.push({ ruleKey: rule.key, subject });
    all.push(...result.drafts);
  }

  const sorted = [...all].sort(
    (a, b) =>
      b.priority - a.priority ||
      (RULE_ORDER.get(a.ruleKey) ?? 0) - (RULE_ORDER.get(b.ruleKey) ?? 0) ||
      a.subject.localeCompare(b.subject),
  );
  const drafts = sorted.slice(0, MAX_FINDINGS_PER_RUN);
  const fired: Partial<Record<SeoRuleKey, number>> = {};
  for (const draft of drafts) {
    fired[draft.ruleKey] = (fired[draft.ruleKey] ?? 0) + 1;
  }
  return {
    drafts,
    evaluated,
    seen,
    skipped,
    fired,
    lowData,
    dropped: sorted.length - drafts.length,
  };
}
