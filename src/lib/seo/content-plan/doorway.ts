import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import { PLACE_NAMES } from "@/lib/seo/places";
import { meaningfulTokens } from "@/lib/seo/tokens";
import { tokenizeFolded } from "@/lib/text-fold";

import type { PlanCandidate, PlanFiltered, PlanRejectReason } from "./types";

// Kapı sayfası (doorway) bekçisi (SC-F7): aynı şablonun yer adı ya da sözcük
// değiştirilmiş kopyaları, mevcut içeriği tekrarlayan ve birbirine çok yakın
// konular plana girmez. Google'ın "çok sayıda benzer sayfa" ilkesine karşı
// ucuz, belirleyici ve saf bir önlemdir. Girdi asla değiştirilmez.

export const NEAR_DUPLICATE_JACCARD = 0.6;
export const TITLE_NEAR_DUPLICATE_JACCARD = 0.7;
export const EXISTING_COVERAGE = 0.8;
export const TEMPLATE_REPEAT_MAX = 2;
// Havuz fikrinin yeniden kullanılma eşiği (candidates.ts REUSE_JACCARD ile aynı).
export const REUSE_JACCARD = 0.8;

// Katlanmış anlamlı sözcüklerin sıralı, tekil, boşlukla birleşmiş anahtarı.
export function keywordKey(text: string): string {
  return [...new Set(meaningfulTokens(text))].sort().join(" ");
}

function tokenSet(text: string): Set<string> {
  return new Set(meaningfulTokens(text));
}

function jaccardOfSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function tokenJaccard(a: string, b: string): number {
  return jaccardOfSets(tokenSet(a), tokenSet(b));
}

// `tokens`ın kaçta kaçı `other` içinde (0..1); boş `tokens` 0.
export function tokenCoverageOf(
  tokens: ReadonlySet<string>,
  other: ReadonlySet<string>,
): number {
  if (tokens.size === 0) return 0;
  let found = 0;
  for (const token of tokens) if (other.has(token)) found += 1;
  return found / tokens.size;
}

// Yer adı sözcük dizileri (çok sözcüklü olanlar önce eşleşir).
const PLACE_PHRASES: ReadonlyMap<string, readonly (readonly string[])[]> = (() => {
  const byFirst = new Map<string, string[][]>();
  for (const place of PLACE_NAMES) {
    const parts = place.split(" ").filter(Boolean);
    if (parts.length === 0) continue;
    const list = byFirst.get(parts[0]!) ?? [];
    list.push(parts);
    byFirst.set(parts[0]!, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.length - a.length);
  return byFirst;
})();

// Yer adları "{place}" ile maskelenmiş katlanmış metin; yer adı yoksa null.
// ("dental implant istanbul" ve "dental implant ankara" aynı şablondur.)
export function locationTemplate(text: string): string | null {
  const tokens = tokenizeFolded(text);
  const out: string[] = [];
  let found = false;
  for (let i = 0; i < tokens.length; ) {
    const phrases = PLACE_PHRASES.get(tokens[i]!);
    const hit = phrases?.find((parts) =>
      parts.every((part, offset) => tokens[i + offset] === part),
    );
    if (hit) {
      out.push("{place}");
      i += hit.length;
      found = true;
    } else {
      out.push(tokens[i]!);
      i += 1;
    }
  }
  return found ? out.join(" ") : null;
}

export type GuardContext = {
  existingTitles: readonly string[];
  existingKeywords: readonly string[];
  rejectedKeys: readonly string[];
  brandTerms: readonly string[];
};

export type GuardCandidatesResult = {
  kept: PlanCandidate[];
  rejected: PlanFiltered[];
};

function compareCandidates(a: PlanCandidate, b: PlanCandidate): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Kontrol sırası (adaylar skor azalan): REJECTED_BEFORE, BRAND_QUERY,
// EXISTING_PAGE, NEAR_DUPLICATE, LOCATION_TEMPLATE, TEMPLATE_REPEAT.
// Not: yerel niyetli sorgular zaten adaylıktan önce elenir; LOCATION_TEMPLATE
// burada derinlemesine savunmadır, pratikte asıl guardTitles'ta (model
// başlıkları) tetiklenir.
export function guardCandidates(
  candidates: readonly PlanCandidate[],
  context: GuardContext,
): GuardCandidatesResult {
  const ordered = [...candidates].sort(compareCandidates);
  const rejectedSet = new Set(context.rejectedKeys);
  const titleSets = context.existingTitles
    .map(tokenSet)
    .filter((set) => set.size > 0);
  const existingKeywordSets = context.existingKeywords
    .map(tokenSet)
    .filter((set) => set.size > 0);

  const kept: PlanCandidate[] = [];
  const rejected: PlanFiltered[] = [];
  const keptSets = new Map<string, Set<string>>();
  const keptTemplates = new Map<string, string>();
  const poisonedTemplates = new Set<string>();
  const keptFolded = new Map<string, string[]>();

  const reject = (candidate: PlanCandidate, reason: PlanRejectReason) => {
    rejected.push({ candidateId: candidate.id, reason });
  };

  for (const candidate of ordered) {
    const tokens = tokenSet(candidate.keyword);
    if (rejectedSet.has(keywordKey(candidate.keyword))) {
      reject(candidate, "REJECTED_BEFORE");
      continue;
    }
    if (isFuzzyBrandQuery(candidate.keyword, context.brandTerms)) {
      reject(candidate, "BRAND_QUERY");
      continue;
    }
    // Havuzdaki bir fikri yeniden kullanacak aday (reuseIdeaId) o fikrin kendi
    // anahtar kelimesiyle çakışmaz: ona >= 0,8 yakın mevcut anahtarlar yok
    // sayılır (yeniden kullanım eşiğiyle aynı).
    const keywordSets = candidate.reuseIdeaId
      ? existingKeywordSets.filter(
          (set) => jaccardOfSets(tokens, set) < REUSE_JACCARD,
        )
      : existingKeywordSets;
    const existingSets = [...titleSets, ...keywordSets];
    if (
      tokens.size > 0 &&
      existingSets.some((set) => tokenCoverageOf(tokens, set) >= EXISTING_COVERAGE)
    ) {
      reject(candidate, "EXISTING_PAGE");
      continue;
    }
    const nearKept = kept.some(
      (other) => jaccardOfSets(tokens, keptSets.get(other.id)!) >= NEAR_DUPLICATE_JACCARD,
    );
    const nearExisting = keywordSets.some(
      (set) => jaccardOfSets(tokens, set) >= NEAR_DUPLICATE_JACCARD,
    );
    if (nearKept || nearExisting) {
      reject(candidate, "NEAR_DUPLICATE");
      continue;
    }
    const template = locationTemplate(candidate.keyword);
    if (template !== null) {
      if (poisonedTemplates.has(template)) {
        reject(candidate, "LOCATION_TEMPLATE");
        continue;
      }
      const owner = keptTemplates.get(template);
      if (owner !== undefined) {
        // Aynı şablonun ikinci örneği: grubun HİÇBİRİ kalmaz.
        poisonedTemplates.add(template);
        keptTemplates.delete(template);
        const index = kept.findIndex((item) => item.id === owner);
        if (index >= 0) {
          const [dropped] = kept.splice(index, 1);
          keptSets.delete(owner);
          keptFolded.delete(owner);
          reject(dropped!, "LOCATION_TEMPLATE");
        }
        reject(candidate, "LOCATION_TEMPLATE");
        continue;
      }
    }
    const folded = tokenizeFolded(candidate.keyword);
    if (folded.length >= 3) {
      const prefix = folded.slice(0, 2).join(" ");
      const suffix = folded.slice(-2).join(" ");
      let samePrefix = 0;
      let sameSuffix = 0;
      for (const words of keptFolded.values()) {
        if (words.length < 3) continue;
        if (words.slice(0, 2).join(" ") === prefix) samePrefix += 1;
        if (words.slice(-2).join(" ") === suffix) sameSuffix += 1;
      }
      if (samePrefix >= TEMPLATE_REPEAT_MAX || sameSuffix >= TEMPLATE_REPEAT_MAX) {
        reject(candidate, "TEMPLATE_REPEAT");
        continue;
      }
    }
    kept.push(candidate);
    keptSets.set(candidate.id, tokens);
    keptFolded.set(candidate.id, folded);
    if (template !== null) keptTemplates.set(template, candidate.id);
  }
  return { kept, rejected };
}

export type TitleItem = { id: string; title: string };

export type GuardTitlesResult = {
  ok: TitleItem[];
  rejected: { id: string; reason: "NEAR_DUPLICATE" | "LOCATION_TEMPLATE" }[];
};

// Model başlıkları için bekçi: mevcut başlıklara ya da önceki kabul edilmiş
// başlığa Jaccard >= 0,7 → NEAR_DUPLICATE; aynı yer adı şablonu →
// LOCATION_TEMPLATE. Reddedilen başlığın yerine çağıran temel başlığı koyar.
export function guardTitles(
  titles: readonly TitleItem[],
  context: { existingTitles: readonly string[] },
): GuardTitlesResult {
  const ok: TitleItem[] = [];
  const rejected: GuardTitlesResult["rejected"] = [];
  const seenSets: Set<string>[] = context.existingTitles
    .map(tokenSet)
    .filter((set) => set.size > 0);
  const templates = new Set<string>();
  for (const title of context.existingTitles) {
    const template = locationTemplate(title);
    if (template !== null) templates.add(template);
  }
  for (const item of titles) {
    const tokens = tokenSet(item.title);
    if (seenSets.some((set) => jaccardOfSets(tokens, set) >= TITLE_NEAR_DUPLICATE_JACCARD)) {
      rejected.push({ id: item.id, reason: "NEAR_DUPLICATE" });
      continue;
    }
    const template = locationTemplate(item.title);
    if (template !== null && templates.has(template)) {
      rejected.push({ id: item.id, reason: "LOCATION_TEMPLATE" });
      continue;
    }
    ok.push(item);
    if (tokens.size > 0) seenSets.push(tokens);
    if (template !== null) templates.add(template);
  }
  return { ok, rejected };
}
