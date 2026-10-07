// Sayfa grubu kuralları (SC-F9, docs/search-agency.md): müşteri URL desenlerini
// grup adlarına bağlar (ör. /shop/reviews). Saf modül; kullanıcı girdisinden
// RegExp üretilmez (ReDoS yok): desen eşleme doğrusal iki göstericili joker
// algoritmasıyla yapılır. İlk eşleşen kural kazanır; kural yoksa grup yolun
// ilk bölümüdür (normalizePageUrl ile aynı).

export type PageGroupMatch = "PREFIX" | "GLOB" | "EXACT";

export type PageGroupRule = {
  id: string;
  group: string;
  match: PageGroupMatch;
  pattern: string;
};

export type PageGroupRules = { v: 1; rules: PageGroupRule[] };

export const PAGE_GROUP_MAX_RULES = 40;
const GROUP_MAX_LENGTH = 60;
const PATTERN_MAX_LENGTH = 200;

export const EMPTY_PAGE_GROUP_RULES: PageGroupRules = { v: 1, rules: [] };

const MATCHES: readonly PageGroupMatch[] = ["PREFIX", "GLOB", "EXACT"];
const GROUP_PATTERN = /^\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*){0,2}$/;
const PATTERN_CHARS = /^[A-Za-z0-9/_.~%*:@+-]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

function newRuleId(): string {
  return `r_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function isMatch(value: unknown): value is PageGroupMatch {
  return (
    typeof value === "string" && (MATCHES as readonly string[]).includes(value)
  );
}

function normalizeGroup(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Hata mesajı ya da null.
function groupError(group: string): string | null {
  if (group.length === 0) return "Enter a group name like /shop/reviews.";
  if (group.length > GROUP_MAX_LENGTH) {
    return `Group names can have up to ${GROUP_MAX_LENGTH} characters.`;
  }
  if (!GROUP_PATTERN.test(group)) {
    return "Use a path-like name with up to 3 parts: lowercase letters, digits, - or _ (like /shop/reviews).";
  }
  return null;
}

function patternError(match: PageGroupMatch, pattern: string): string | null {
  if (pattern.length === 0) return "Enter a path pattern.";
  if (pattern.length > PATTERN_MAX_LENGTH) {
    return `Patterns can have up to ${PATTERN_MAX_LENGTH} characters.`;
  }
  if (!pattern.startsWith("/")) return "A pattern must start with /.";
  if (!PATTERN_CHARS.test(pattern)) {
    return "A pattern can only use letters, digits and / _ . ~ % * : @ + -.";
  }
  if (match !== "GLOB") {
    return pattern.includes("*")
      ? "Only the pattern type accepts * and **."
      : null;
  }
  const segments = pattern.split("/").slice(1);
  for (let at = 0; at < segments.length; at += 1) {
    const segment = segments[at] ?? "";
    if (!segment.includes("**")) continue;
    if (segment !== "**") return "Use ** as a whole segment only.";
    if (at !== segments.length - 1)
      return "** is allowed only as the last segment.";
  }
  return null;
}

// Okuma yönü hoşgörülü: bozuk kural düşer, 40'ta kesilir, kimlikler onarılır.
export function parsePageGroupRules(raw: unknown): PageGroupRules {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { rules?: unknown }).rules)
      ? (raw as { rules: unknown[] }).rules
      : [];
  const rules: PageGroupRule[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (rules.length >= PAGE_GROUP_MAX_RULES) break;
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const group = normalizeGroup(entry.group);
    const pattern =
      typeof entry.pattern === "string" ? entry.pattern.trim() : "";
    if (!isMatch(entry.match)) continue;
    if (groupError(group) || patternError(entry.match, pattern)) continue;
    let id =
      typeof entry.id === "string" && ID_PATTERN.test(entry.id) ? entry.id : "";
    if (!id || seen.has(id)) id = newRuleId();
    seen.add(id);
    rules.push({ id, group, match: entry.match, pattern });
  }
  return { v: 1, rules };
}

export type PageGroupRuleError = {
  index: number;
  field: "group" | "match" | "pattern";
  message: string;
};

// Kaydetme yönü katı: bütün hatalar indeks ve alanla döner.
export function validatePageGroupRules(
  input: unknown,
):
  | { ok: true; rules: PageGroupRules }
  | { ok: false; errors: PageGroupRuleError[] } {
  const list = Array.isArray(input)
    ? input
    : input &&
        typeof input === "object" &&
        Array.isArray((input as { rules?: unknown }).rules)
      ? (input as { rules: unknown[] }).rules
      : null;
  if (!list) {
    return {
      ok: false,
      errors: [{ index: 0, field: "group", message: "Rules must be a list." }],
    };
  }
  const errors: PageGroupRuleError[] = [];
  if (list.length > PAGE_GROUP_MAX_RULES) {
    errors.push({
      index: PAGE_GROUP_MAX_RULES,
      field: "group",
      message: `Use at most ${PAGE_GROUP_MAX_RULES} rules.`,
    });
  }
  const rules: PageGroupRule[] = [];
  const seen = new Set<string>();
  list.slice(0, PAGE_GROUP_MAX_RULES).forEach((item, index) => {
    const entry =
      item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const group = normalizeGroup(entry.group);
    const pattern =
      typeof entry.pattern === "string" ? entry.pattern.trim() : "";
    const issueGroup = groupError(group);
    if (issueGroup) errors.push({ index, field: "group", message: issueGroup });
    if (!isMatch(entry.match)) {
      errors.push({
        index,
        field: "match",
        message: "Choose how the pattern matches.",
      });
      return;
    }
    const issuePattern = patternError(entry.match, pattern);
    if (issuePattern)
      errors.push({ index, field: "pattern", message: issuePattern });
    if (issueGroup || issuePattern) return;
    let id =
      typeof entry.id === "string" && ID_PATTERN.test(entry.id) ? entry.id : "";
    if (!id || seen.has(id)) id = newRuleId();
    seen.add(id);
    rules.push({ id, group, match: entry.match, pattern });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rules: { v: 1, rules } };
}

// Küçük harf, sondaki "/" atılır ("/" tek başına boş yol olur).
function normalizePath(value: string): string {
  const lower = value.toLowerCase();
  return lower.length > 1 && lower.endsWith("/")
    ? lower.slice(0, -1)
    : lower === "/"
      ? ""
      : lower;
}

function segmentsOf(normalized: string): string[] {
  return normalized === "" ? [] : normalized.slice(1).split("/");
}

// "*" = herhangi bir karakter dizisi (bölüm içinde). Doğrusal iki göstericili
// algoritma: son yıldızın konumu hatırlanır, geri dönüş tek göstericiyle
// sınırlıdır (üstel patlama yok).
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

export function matchPattern(
  match: PageGroupMatch,
  pattern: string,
  path: string,
): boolean {
  const want = normalizePath(pattern);
  const have = normalizePath(path);
  if (match === "EXACT") return want === have;
  if (match === "PREFIX") {
    return want === "" || have === want || have.startsWith(`${want}/`);
  }
  const patternSegments = segmentsOf(want);
  const pathSegments = segmentsOf(have);
  const tail = patternSegments[patternSegments.length - 1] === "**";
  const fixed = tail ? patternSegments.slice(0, -1) : patternSegments;
  if (
    tail
      ? pathSegments.length < fixed.length
      : pathSegments.length !== fixed.length
  ) {
    return false;
  }
  return fixed.every((segment, at) => wildcardMatch(segment, pathSegments[at] ?? ""));
}

// Varsayılan grup: ilk yol bölümü ("/" + ilk, yoksa "/").
export function defaultGroupOf(path: string): string {
  const first = path.split("/").find(Boolean);
  return first ? `/${first}` : "/";
}

export function groupFor(rules: PageGroupRules, path: string): string {
  for (const rule of rules.rules) {
    if (matchPattern(rule.match, rule.pattern, path)) return rule.group;
  }
  return defaultGroupOf(path);
}

export type PageGroupPreview = {
  groups: { group: string; pages: number; samples: string[] }[];
  changed: number;
  unmatched: number;
  sampled: number;
};

const PREVIEW_SAMPLES = 3;

// Kurallar altında örnek sayfaların dağılımı: grup başına sayfa sayısı ve en
// çok 3 örnek yol; `changed` mevcut gruptan farklı olanlar, `unmatched` hiçbir
// kurala uymayıp varsayılan gruba düşenler.
export function previewGroups(
  rules: PageGroupRules,
  pages: readonly { path: string; currentGroup: string | null }[],
): PageGroupPreview {
  const groups = new Map<string, { pages: number; samples: string[] }>();
  let changed = 0;
  let unmatched = 0;
  for (const page of pages) {
    const rule = rules.rules.find((candidate) =>
      matchPattern(candidate.match, candidate.pattern, page.path),
    );
    const group = rule ? rule.group : defaultGroupOf(page.path);
    if (!rule) unmatched += 1;
    if (group !== page.currentGroup) changed += 1;
    const entry = groups.get(group) ?? { pages: 0, samples: [] };
    entry.pages += 1;
    if (entry.samples.length < PREVIEW_SAMPLES) entry.samples.push(page.path);
    groups.set(group, entry);
  }
  return {
    groups: [...groups.entries()]
      .map(([group, entry]) => ({ group, ...entry }))
      .sort((a, b) => b.pages - a.pages || a.group.localeCompare(b.group)),
    changed,
    unmatched,
    sampled: pages.length,
  };
}
