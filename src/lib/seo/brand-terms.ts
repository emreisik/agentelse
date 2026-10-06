import { normalizeDomain } from "@/lib/domain";
import { foldForMatch, tokenizeFolded } from "@/lib/text-fold";

// Marka terimleri v1 (docs/google-search-console-plan.md SK8 (a), LLM'siz):
// marka adı, proje adı ve alan adının kök etiketi otomatik; kullanıcı ekler ya
// da çıkarır. Aynı terimler iki yerde eşleşir: bizde sorgu sözlüğü
// (isBrandQuery → GscQuery.isBrand) ve Google'da günlük marka serisi
// (brandTermsRegex → includingRegex). İkisi aynı kuralı izler: 4+ karakterli
// terimler ayraçsız alt dize, kısa terimler Unicode sözcük sınırlarıyla.
// Saf ve izomorfik: form, sunucu ve senkron paylaşır.

export const BRAND_TERMS_MAX = 20;
export const BRAND_TERM_MAX_LENGTH = 60;
const AUTO_MIN_COMPACT = 3;
const INPUT_MIN_COMPACT = 2;
const SUBSTRING_MIN_COMPACT = 4;
const REGEX_MAX_LENGTH = 4000;

export type BrandTermsConfig = {
  v: 1;
  auto: string[];
  user: string[];
  removed: string[];
  updatedAt: string | null;
};

export const EMPTY_BRAND_TERMS: BrandTermsConfig = {
  v: 1,
  auto: [],
  user: [],
  removed: [],
  updatedAt: null,
};

const GENERIC_NAMES = new Set([
  "default",
  "untitled",
  "my project",
  "new project",
]);

// Kök etiketten önce atılan iki parçalı genel sonekler; listede yoksa yalnız
// son etiket atılır.
const PUBLIC_SUFFIXES = new Set([
  "com.tr",
  "org.tr",
  "net.tr",
  "gen.tr",
  "com.mk",
  "co.uk",
  "org.uk",
  "com.au",
  "com.br",
  "co.jp",
]);

const SEPARATORS = /[\s\-_.'’]+/g;

// Katlanmış, boşlukları tekleştirilmiş terim: "  ACME  Shop " → "acme shop".
function foldTerm(value: string): string {
  return foldForMatch(value).replace(/\s+/g, " ").trim();
}

// Karşılaştırma anahtarı: katlanmış ve ayraçsız ("Acme-Shop" → "acmeshop").
export function compactBrandTerm(value: string): string {
  return foldForMatch(value).replace(SEPARATORS, "");
}

// Sıra korunarak ayraçsız biçime göre tekilleştirir ve sınırda keser.
function dedupe(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = compactBrandTerm(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= BRAND_TERMS_MAX) break;
  }
  return out;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(foldTerm)
    .filter((term) => term.length > 0 && term.length <= BRAND_TERM_MAX_LENGTH);
}

export function parseBrandTermsConfig(value: unknown): BrandTermsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_BRAND_TERMS };
  }
  const record = value as Record<string, unknown>;
  return {
    v: 1,
    auto: dedupe(stringList(record.auto)),
    user: dedupe(stringList(record.user)),
    removed: dedupe(stringList(record.removed)),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function nameTerm(value: string | null): string | null {
  if (!value) return null;
  const term = foldTerm(value);
  if (term.length > BRAND_TERM_MAX_LENGTH) return null;
  if (compactBrandTerm(term).length < AUTO_MIN_COMPACT) return null;
  if (GENERIC_NAMES.has(term)) return null;
  return term;
}

// "sc-domain:blog.example.co.uk" ve "https://www.example.com/" → ana makine.
function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (/^sc-domain:/i.test(trimmed)) {
    return normalizeDomain(trimmed.replace(/^sc-domain:/i, "")) || null;
  }
  try {
    return normalizeDomain(new URL(trimmed).host) || null;
  } catch {
    return normalizeDomain(trimmed) || null;
  }
}

// "webhealth.com.tr" → "webhealth", "blog.example.co.uk" → "example".
function rootLabel(host: string | null): string | null {
  if (!host) return null;
  const labels = host.replace(/:\d+$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const index = PUBLIC_SUFFIXES.has(lastTwo)
    ? labels.length - 3
    : labels.length - 2;
  const root = index >= 0 ? labels[index] : undefined;
  if (!root || root.length < AUTO_MIN_COMPACT) return null;
  return foldTerm(root);
}

export function autoBrandTerms(input: {
  brandName: string | null;
  projectName: string | null;
  domain: string | null;
  siteUrl: string | null;
}): string[] {
  const candidates = [
    nameTerm(input.brandName),
    nameTerm(input.projectName),
    rootLabel(input.domain ? hostOf(input.domain) : null),
    rootLabel(input.siteUrl ? hostOf(input.siteUrl) : null),
  ].filter((term): term is string => term !== null);
  return dedupe(candidates);
}

function allEffectiveTerms(config: BrandTermsConfig): string[] {
  const removed = new Set(config.removed.map(compactBrandTerm));
  return dedupe([
    ...config.auto.filter((term) => !removed.has(compactBrandTerm(term))),
    ...config.user,
  ]);
}

// Otomatik terimler (çıkarılanlar hariç) + kullanıcının eklediği terimler;
// Google'a gidecek düzenli ifadeye sığan baştaki kısım. Sınıflama, özet ve
// düzenli ifade hep bu listeyi kullanır: iki taraf aynı terimlerle eşleşir.
export function effectiveBrandTerms(config: BrandTermsConfig): string[] {
  return fitBrandTermsToRegex(allEffectiveTerms(config));
}

// Düzenli ifade sınırı yüzünden dışarıda kalan terim sayısı (kaydederken
// kullanıcıya söylenir).
export function brandTermsOverflow(config: BrandTermsConfig): number {
  const all = allEffectiveTerms(config);
  return all.length - fitBrandTermsToRegex(all).length;
}

// Formdaki metin: satır, virgül ya da noktalı virgülle ayrılmış terimler.
export function parseBrandTermsInput(text: string): string[] {
  return dedupe(
    text
      .split(/[\n\r,;]+/)
      .map(foldTerm)
      .filter(
        (term) =>
          term.length > 0 &&
          term.length <= BRAND_TERM_MAX_LENGTH &&
          compactBrandTerm(term).length >= INPUT_MIN_COMPACT,
      ),
  );
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

// Kısa terim: katlanmış sorguda iki yanı harf/rakam olmayan bir geçiş.
function wholeWordIn(folded: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const index = folded.indexOf(term, from);
    if (index < 0) return false;
    const before = index > 0 ? folded[index - 1]! : "";
    const after = folded[index + term.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = index + 1;
  }
}

export function isBrandQuery(query: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const compactQuery = compactBrandTerm(query);
  let tokens: string[] | null = null;
  let folded: string | null = null;
  for (const term of terms) {
    const compact = compactBrandTerm(term);
    if (!compact) continue;
    if (compact.length >= SUBSTRING_MIN_COMPACT) {
      if (compactQuery.includes(compact)) return true;
      continue;
    }
    const foldedTerm = foldTerm(term);
    if (/^[\p{L}\p{N}]+$/u.test(foldedTerm)) {
      tokens ??= tokenizeFolded(query);
      if (tokens.includes(foldedTerm)) return true;
    } else {
      folded ??= foldTerm(query);
      if (wholeWordIn(folded, foldedTerm)) return true;
    }
  }
  return false;
}

// Katlanmış harfin sorgudaki aksanlı/Türkçe karşılıkları. Google ham sorguda
// eşleştirir; foldForMatch'in attığı işaretler burada geri sınıf olur. Tablo
// elle yazılmaz, foldForMatch'ten kurulur: Latin-1, Latin Extended-A, virgül
// altlı ș/ț ve Kiril'de (ќ = к + ́) tek harfe katlanan her küçük harf ve
// Türkçe İ. Böylece isBrandQuery'nin eşlediği her aksanlı harf Google
// tarafında da eşleşir. (?i) büyük harfleri kapsar.
const ACCENT_RANGES: readonly (readonly [number, number])[] = [
  [0x00c0, 0x017f],
  [0x0218, 0x021b],
  [0x0400, 0x045f],
];

function buildAccentClasses(): Readonly<Record<string, string>> {
  const variants = new Map<string, string[]>();
  for (const [from, to] of ACCENT_RANGES) {
    for (let code = from; code <= to; code += 1) {
      const char = String.fromCodePoint(code);
      if (char !== char.toLowerCase() && char !== "İ") continue;
      const base = foldForMatch(char);
      if (base.length !== 1 || base === char) continue;
      variants.set(base, [...(variants.get(base) ?? []), char]);
    }
  }
  return Object.fromEntries(
    [...variants].map(([base, chars]) => [base, `[${base}${chars.join("")}]`]),
  );
}

const ACCENT_CLASS = buildAccentClasses();

// RE2 ve JS 'u' kipinde geçerli kaçış: yalnız sözdizimi karakterleri.
function escapeChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function classed(char: string): string {
  if (/\s/.test(char)) return "\\s";
  return ACCENT_CLASS[char] ?? escapeChar(char);
}

// \b KULLANILMAZ: RE2'de yalnız ASCII'dir, Türkçe ve Kiril kısa terimler hiç
// eşleşmezdi. Bakınma (lookaround) ve geri başvuru da yok (RE2 desteklemez).
function termPattern(term: string): string | null {
  const compact = compactBrandTerm(term);
  if (!compact) return null;
  if (compact.length >= SUBSTRING_MIN_COMPACT) {
    return Array.from(compact).map(classed).join("[\\s\\-_.'’]*");
  }
  const body = Array.from(foldTerm(term)).map(classed).join("");
  return `(?:^|[^\\p{L}\\p{N}])${body}(?:$|[^\\p{L}\\p{N}])`;
}

function regexOf(patterns: readonly string[]): string {
  return `(?i)(?:${patterns.join("|")})`;
}

// Sıra korunarak düzenli ifadeye (4000 karakter) sığan baştaki terimler.
export function fitBrandTermsToRegex(terms: readonly string[]): string[] {
  const kept: string[] = [];
  const patterns: string[] = [];
  for (const term of terms) {
    const pattern = termPattern(term);
    if (pattern === null) {
      kept.push(term);
      continue;
    }
    if (regexOf([...patterns, pattern]).length > REGEX_MAX_LENGTH) break;
    patterns.push(pattern);
    kept.push(term);
  }
  return kept;
}

export function brandTermsRegex(terms: readonly string[]): string | null {
  const patterns = terms
    .map(termPattern)
    .filter((pattern): pattern is string => pattern !== null);
  // Güvenlik ağı: effectiveBrandTerms zaten sığan listeyi verir.
  while (patterns.length > 0) {
    const regex = regexOf(patterns);
    if (regex.length <= REGEX_MAX_LENGTH) return regex;
    patterns.pop();
  }
  return null;
}

// FNV-1a 32 bit (UTF-8 baytları üzerinde), 8 haneli onaltılık.
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Sıradan bağımsız terim özeti; boş liste "none".
export function brandTermsHash(terms: readonly string[]): string {
  const folded = Array.from(
    new Set(terms.map(foldTerm).filter((term) => term.length > 0)),
  ).sort();
  if (folded.length === 0) return "none";
  return fnv1a(folded.join("\n"));
}
