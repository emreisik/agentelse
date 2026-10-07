// Search sayfası ajans bölümünün saf yardımcıları (SC-F9). Biçim dönüşümleri ve
// yalnız kullanıcı deneyimi için yapılan istemci denetimleri burada; sunucu her
// zaman yetkilidir. Bu dosya sunucu ya da istemci modülü içe aktarmaz.

export const PATTERN_TOKENS = ["title", "h1", "site", "year"] as const;
export type PatternToken = (typeof PATTERN_TOKENS)[number];

export type PatternSample = {
  title: string;
  h1: string;
  site: string;
  year: number;
};

export const DEFAULT_PATTERN_SAMPLE: PatternSample = {
  title: "Blue running shoes",
  h1: "Running shoes",
  site: "example.com",
  year: new Date().getUTCFullYear(),
};

export type PatternPreview = {
  ok: boolean;
  tokens: PatternToken[];
  preview: string;
  message: string | null;
};

const MAX_PATTERN_TOKENS = 3;

function isPatternToken(value: string): value is PatternToken {
  return (PATTERN_TOKENS as readonly string[]).includes(value);
}

// "{title} | {site}" gibi bir kalıbı örnek değerlerle önizler. Düzenli ifade
// kullanılmaz: kullanıcı girdisi karakter karakter taranır. Boş kalıp geçerlidir
// (alan isteğe bağlı) ve boş önizleme döner.
export function parsePatternPreview(
  pattern: string,
  sample: PatternSample = DEFAULT_PATTERN_SAMPLE,
  max = 160,
): PatternPreview {
  if (pattern.length === 0) {
    return { ok: true, tokens: [], preview: "", message: null };
  }
  const fail = (message: string, tokens: PatternToken[]): PatternPreview => ({
    ok: false,
    tokens,
    preview: "",
    message,
  });
  const tokens: PatternToken[] = [];
  let preview = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "}") return fail("Unexpected closing brace.", tokens);
    if (char !== "{") {
      preview += char;
      index += 1;
      continue;
    }
    const end = pattern.indexOf("}", index + 1);
    if (end === -1) return fail("Missing closing brace.", tokens);
    const name = pattern.slice(index + 1, end);
    if (name.includes("{"))
      return fail("Nested braces aren't allowed.", tokens);
    if (!isPatternToken(name)) {
      return fail(`Unknown token {${name}}.`, tokens);
    }
    tokens.push(name);
    if (tokens.length > MAX_PATTERN_TOKENS) {
      return fail(`Use at most ${MAX_PATTERN_TOKENS} tokens.`, tokens);
    }
    preview += name === "year" ? String(sample.year) : sample[name];
    index = end + 1;
  }
  if (pattern.length > max) {
    return fail(`Keep the pattern under ${max} characters.`, tokens);
  }
  return { ok: true, tokens, preview, message: null };
}

// 5 -> "5 GB", 1000 -> "1 TB". Seçim listeleri GB cinsindendir.
export function bytesChoiceLabel(gb: number): string {
  if (gb >= 1000 && gb % 1000 === 0) return `${gb / 1000} TB`;
  return `${gb} GB`;
}

const GIB = 1024 ** 3;

// Kayıtlı bayt değerine en yakın seçim (GB). Sunucu seçimi gb * 1024^3 olarak
// saklar; eski ya da elle değişmiş değerler yine bir seçime oturur.
export function choiceForBytes(
  bytes: number,
  choices: readonly number[],
): number {
  const gb = bytes / GIB;
  let best = choices[0] ?? 0;
  for (const choice of choices) {
    if (Math.abs(choice - gb) < Math.abs(best - gb)) best = choice;
  }
  return best;
}

// Aylık kullanım çubuğu: 0..100 tam sayı yüzde.
export function usagePercent(used: number, budget: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
});

// "2026-10-07" ya da ISO zaman damgası -> "Oct 7, 2026" (UTC; saat dilimi yok).
export function formatDay(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "-";
  return dayFormat.format(date);
}

export type SplitFormValues = {
  projectId: string;
  linkId: string;
  name: string;
  changeKind: string;
  description: string;
  pageGroups: readonly string[];
  titlePattern: string;
  metaPattern: string;
  schemaType: string;
  note: string;
};

// Bölünmüş test formu -> FormData. pageGroups tekrarlanan alan olarak gider;
// boş isteğe bağlı alanlar hiç eklenmez.
export function splitFormToFormData(values: SplitFormValues): FormData {
  const data = new FormData();
  data.set("projectId", values.projectId);
  data.set("linkId", values.linkId);
  data.set("name", values.name.trim());
  data.set("changeKind", values.changeKind);
  for (const group of values.pageGroups) data.append("pageGroups", group);
  const optional: [string, string][] = [
    ["description", values.description],
    ["titlePattern", values.titlePattern],
    ["metaPattern", values.metaPattern],
    ["schemaType", values.schemaType],
    ["note", values.note],
  ];
  for (const [key, value] of optional) {
    const trimmed = value.trim();
    if (trimmed) data.set(key, trimmed);
  }
  return data;
}

export type EditableRule = {
  key: string;
  group: string;
  match: string;
  pattern: string;
};

export const MAX_EDITABLE_RULES = 40;

export function isEmptyRule(rule: Pick<EditableRule, "group" | "pattern">) {
  return rule.group.trim() === "" && rule.pattern.trim() === "";
}

// Düzenleyici satırları -> sunucuya giden kural listesi. Tamamen boş satırlar
// atılır, en çok 40 kural gönderilir; geçerlilik kararı sunucudadır.
// Yalnız kullanıcı deneyimi için hızlı satır denetimi; sunucu yetkilidir.
export function ruleProblem(
  rule: Pick<EditableRule, "group" | "match" | "pattern">,
): string | null {
  if (isEmptyRule(rule)) return null;
  const group = rule.group.trim();
  const pattern = rule.pattern.trim();
  if (!group.startsWith("/")) return "Group names start with / (for example /blog).";
  if (group.length > 60) return "Group names can be up to 60 characters.";
  if (group !== group.toLowerCase()) return "Group names are lowercase.";
  if (!pattern.startsWith("/")) return "Patterns start with / (for example /blog/).";
  if (pattern.length > 200) return "Patterns can be up to 200 characters.";
  if (rule.match !== "GLOB" && pattern.includes("*")) {
    return "Only the pattern match type accepts * and **.";
  }
  return null;
}

export function buildRulePayload(
  rows: readonly EditableRule[],
): { group: string; match: string; pattern: string }[] {
  return rows
    .filter((row) => !isEmptyRule(row))
    .slice(0, MAX_EDITABLE_RULES)
    .map((row) => ({
      group: row.group.trim(),
      match: row.match,
      pattern: row.pattern.trim(),
    }));
}

export function buildRulesJson(rows: readonly EditableRule[]): string {
  return JSON.stringify(buildRulePayload(rows));
}

let rowCounter = 0;

// Satır kimlikleri çizimde görünmez; yalnız React anahtarı ve satır taşıma için.
export function newRowKey(): string {
  rowCounter += 1;
  return `rule-${rowCounter}`;
}

export type HealthTone = "ok" | "warn" | "bad" | "idle";

const BAD_HEALTH = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

// Bağlantı sağlığı -> nokta rengi. Renk tek başına anlam taşımaz: yanında
// metin etiketi de çizilir (healthLabel).
export function healthTone(health: string): HealthTone {
  if (BAD_HEALTH.has(health)) return "bad";
  if (health === "DEGRADED") return "warn";
  if (health === "OK" || health === "HEALTHY") return "ok";
  return "idle";
}

const HEALTH_LABEL: Record<HealthTone, string> = {
  ok: "Syncing",
  warn: "Updates failing",
  bad: "Needs attention",
  idle: "Not checked yet",
};

export function healthLabel(health: string): string {
  return HEALTH_LABEL[healthTone(health)];
}

// Sayfa adresine ?site= ve diğer parametreleri ekler. Birincil site için
// "site" parametresi yazılmaz.
export function siteHref(
  base: string,
  linkId: string | null,
  keep: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  if (linkId) params.set("site", linkId);
  for (const [key, value] of Object.entries(keep)) {
    if (value !== "" && key !== "site") params.set(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

// Kartların ortak sınıfları (search-reports/search-opportunities ile aynı dil).
export const DETAILS_CLASS =
  "group rounded-xl ring-1 ring-foreground/10 [&_summary::-webkit-details-marker]:hidden";
export const SUMMARY_CLASS =
  "flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-xl p-4 text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
export const BODY_CLASS = "space-y-4 border-t border-foreground/10 p-4";
export const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
export const INPUT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
export const HINT_CLASS = "text-xs text-muted-foreground";
export const ADMIN_HINT = "Ask a workspace admin to change this.";
