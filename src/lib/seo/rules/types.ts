import type {
  RuleSnapshot,
  SeoFindingDraft,
  SeoRuleKey,
} from "@/lib/seo/opportunity-types";

// SEO fırsat kurallarının (SO1–SO16) ortak sözleşmesi
// (docs/search-opportunities.md "Kurallar"). Her kural saf bir fonksiyondur:
// tek anlık görüntüden taslak bulgu üretir ya da neden değerlendirilemediğini
// söyler.

export type RuleSkipReason =
  | "LOW_DATA"
  | "LOW_HISTORY"
  | "NO_CRAWL"
  | "NO_CLUSTERS"
  | "NO_BRAND_SPLIT"
  | "ERROR";

// seen: kuralın KENDİ sınırından (Max N) önce koşulu sağlayan bütün konular;
// taslakların konularını da kapsar. Yaşam döngüsü bir açık bulguyu yalnız
// konusu seen'de yoksa çözer, böylece sınır yüzünden listeye giremeyen bir
// fırsat "çözüldü" sayılmaz.
export type RuleResult =
  | { evaluable: true; drafts: SeoFindingDraft[]; seen: string[] }
  | { evaluable: false; reason: RuleSkipReason };

// querySignal: kural sorgu verisine dayanır; az veri modunda (LOW_DATA)
// atlanır.
export type SeoRule = {
  key: SeoRuleKey;
  version: number;
  querySignal: boolean;
  evaluate(snapshot: RuleSnapshot): RuleResult;
};
