import {
  foldForMatch,
  foldedTokensWithRange,
  tokenizeFolded,
  type FoldedToken,
} from "@/lib/text-fold";
import {
  ABSOLUTE_TERMS,
  FIGURE_PATTERNS,
  PRESET_DETECTORS,
  PRESET_IDS,
  PRESET_RULE_LABELS,
  type PresetId,
  type Severity,
} from "@/lib/works/brand-rule-lexicons";

// Deterministic brand-rule checker (spec 3.7). Pure: no IO, no Prisma.
//
// NEVER run rule texts, approved claims or competitor names through
// safeModelText / cleanPromptText: its instruction filter drops "Never mention
// ..." shaped text, i.e. exactly the rules. Where a model must be shown a rule,
// use flattenRuleText (flatten + clip) of the clean-text lib.
//
// What it can check: literal terms, six preset detectors, unapproved figures
// and absolute wording. What it cannot: tone, visual rules, semantic rules
// ("do not misrepresent pricing") and negation ("we give no guarantees"
// contains the term). Hence only literal-term hits and tight preset hits block.

export type BrandRuleOrigin =
  "forbidden-claim" | "negative-brief" | "client-rule" | "memory";

export type BrandRule = { text: string; origin: BrandRuleOrigin };

export type BrandRuleSet = {
  language: string;
  never: BrandRule[];
  approvedClaims: string[];
  competitors: string[];
};

export type BrandFlagKind = "never-term" | "preset" | "figure" | "absolute";

export type BrandFlag = {
  kind: BrandFlagKind;
  severity: Severity;
  matched: string;
  rule?: string;
};

export type ItemFlag = {
  index: number;
  field: "topic" | "captionIdea";
  flag: BrandFlag;
};

export type BrandCheckState =
  { state: "checked"; rules: number } | { state: "skipped" };

export type PlanTextItem = {
  topic?: string | null;
  captionIdea?: string | null;
};

export const MAX_RULE_ECHO = 120;
const MAX_REPAIR_LINES = 5;
const MAX_TERM_TOKENS = 8;

// ---------------------------------------------------------------------------
// Rule texts -> terms
// ---------------------------------------------------------------------------

// A sentence that starts with one of these is a rule ABOUT behaviour, not a
// list of words (folded; compared token by token).
const RULE_VERBS = new Set(
  [
    "never",
    "avoid",
    "dont",
    "asla",
    "hiç",
    "nemoj",
    "ne",
    "nie",
    "nigdy",
    "nunca",
    "jamais",
    "niemals",
    "nikad",
    "nikada",
    "не",
    "никогда",
  ].map(foldForMatch),
);

function startsWithRuleVerb(text: string): boolean {
  const tokens = tokenizeFolded(text);
  if (tokens.length === 0) return false;
  if (RULE_VERBS.has(tokens[0] ?? "")) return true;
  // "do not ..." and "don't ..." (the apostrophe splits into "don", "t")
  if (tokens[0] === "do" && tokens[1] === "not") return true;
  return tokens[0] === "don" && tokens[1] === "t";
}

// "..." '...' «...» „...“ “...” ‘...’. A single quote only opens after a
// non-letter and closes before one, so the apostrophe of "don't" is not a span.
const QUOTED_SPANS = [
  /"([^"\n]{1,80})"/gu,
  /“([^”\n]{1,80})”/gu,
  /«([^»\n]{1,80})»/gu,
  /„([^“”"\n]{1,80})[“”"]/gu,
  /(?<![\p{L}\p{N}])'([^'\n]{1,80}?)'(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])‘([^’\n]{1,80}?)’(?![\p{L}\p{N}])/gu,
];

function quotedSpansOf(text: string): string[] {
  const spans: string[] = [];
  for (const re of QUOTED_SPANS) {
    for (const match of text.matchAll(re)) {
      if (match[1]) spans.push(match[1]);
    }
  }
  return spans;
}

function splitList(text: string): string[] {
  return text
    .split(/[,;\n|]/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

// A rule is a TERM LIST when it has <= 4 words and does not start with a rule
// verb ("kesin garanti", "cheap, free"); otherwise only its quoted spans
// count ("Never say 'cheap'"). Memory rules are chat-stated sentences, so they
// only ever contribute quoted spans.
export function ruleTermsOf(rule: BrandRule): string[] {
  const text = (rule.text ?? "").trim();
  if (!text) return [];
  const quoted = quotedSpansOf(text).flatMap(splitList);
  if (rule.origin === "memory") return quoted;
  const words = text.split(/\s+/u).filter(Boolean).length;
  if (words <= 4 && !startsWithRuleVerb(text)) {
    return quoted.length > 0 ? quoted : splitList(text);
  }
  return quoted;
}

// ---------------------------------------------------------------------------
// Term matching
// ---------------------------------------------------------------------------

// How a plan word may continue after a rule word. "chain" (Turkish and English
// projects, and every lexicon term): the rest must be a chain of known
// inflection suffixes, so "hasta" matches "hastalar" and "hastaya" but NOT
// "hastane". "prefix" (other languages, non-Latin scripts): any continuation.
type Mode = "chain" | "prefix";

type CompiledTerm =
  | {
      kind: "tokens";
      raw: string;
      tokens: string[];
      mode: Mode;
      stemLast: boolean;
    }
  | { kind: "substring"; raw: string; needle: string }
  | { kind: "symbol"; raw: string; re: RegExp };

// Scripts written without spaces between words (or with unreliable ones):
// match by substring after the fold.
const SUBSTRING_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const NON_WORD_SYMBOL = /[^\p{L}\p{N}\s'’-]/u;

// Folded Turkish and English inflection morphs (ü -> u, ı -> i, ö -> o).
// Bare "n" and "m" are left out on purpose: they would make "hasta" + "n" + "e"
// read as "hastane".
const SUFFIXES = new Set([
  // Turkish
  "lar",
  "ler",
  "i",
  "u",
  "yi",
  "yu",
  "in",
  "un",
  "nin",
  "nun",
  "a",
  "e",
  "ya",
  "ye",
  "da",
  "de",
  "ta",
  "te",
  "dan",
  "den",
  "tan",
  "ten",
  "nda",
  "nde",
  "ndan",
  "nden",
  "la",
  "le",
  "yla",
  "yle",
  "ca",
  "ce",
  "ci",
  "cu",
  "li",
  "lu",
  "siz",
  "suz",
  "lik",
  "luk",
  "ki",
  "si",
  "su",
  "im",
  "iz",
  "imiz",
  "iniz",
  "miz",
  "niz",
  "ina",
  "ine",
  "una",
  "une",
  "sina",
  "sine",
  "suna",
  "sune",
  "ini",
  "unu",
  "dir",
  "tir",
  "di",
  "ti",
  // English
  "s",
  "es",
  "d",
  "ed",
  "ing",
  "ings",
  "ly",
  "er",
  "ers",
  "ness",
  "ment",
  "ments",
  "al",
  "ion",
  "ions",
]);
const MAX_SUFFIX_TAIL = 14;

const suffixCache = new Map<string, boolean>();

function isSuffixChain(rest: string): boolean {
  if (rest === "") return true;
  if (rest.length > MAX_SUFFIX_TAIL) return false;
  const cached = suffixCache.get(rest);
  if (cached !== undefined) return cached;
  let ok = false;
  for (let cut = 1; cut <= rest.length && !ok; cut++) {
    if (SUFFIXES.has(rest.slice(0, cut)) && isSuffixChain(rest.slice(cut))) {
      ok = true;
    }
  }
  suffixCache.set(rest, ok);
  return ok;
}

// Turkish final-consonant softening before a vowel suffix: kitap -> kitabı,
// çocuk -> çocuğu (folded: kitab, cocug), ağaç -> ağacı (invisible once folded).
const SOFTENED: Record<string, string> = { p: "b", t: "d", k: "g" };

function stemsOf(term: string): string[] {
  const letters = [...term];
  const last = letters[letters.length - 1] ?? "";
  const soft = SOFTENED[last];
  if (letters.length >= 5 && soft) {
    return [term, letters.slice(0, -1).join("") + soft];
  }
  return [term];
}

function tokenMatches(plan: string, term: string, mode: Mode): boolean {
  if (plan === term) return true;
  // Under 4 letters a prefix proves nothing ("tek" vs "tekrar"): exact only.
  if ([...term].length < 4) return false;
  if (mode === "prefix") return plan.startsWith(term);
  for (const stem of stemsOf(term)) {
    if (plan.length > stem.length && plan.startsWith(stem)) {
      if (isSuffixChain(plan.slice(stem.length))) return true;
    }
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileTerm(raw: string, defaultMode: Mode): CompiledTerm | null {
  const trimmed = raw.trim();
  const stemLast = trimmed.endsWith("*");
  const body = stemLast ? trimmed.slice(0, -1) : trimmed;
  const folded = foldForMatch(body).trim();
  if (!folded) return null;
  if (SUBSTRING_SCRIPT.test(folded)) {
    return { kind: "substring", raw: body.trim(), needle: folded };
  }
  if (NON_WORD_SYMBOL.test(folded)) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(folded)}(?![\\p{L}\\p{N}])`,
      "u",
    );
    return { kind: "symbol", raw: body.trim(), re };
  }
  const tokens = tokenizeFolded(folded);
  if (tokens.length === 0 || tokens.length > MAX_TERM_TOKENS) return null;
  const latin = tokens.every((token) =>
    /^[\p{Script=Latin}\p{N}]+$/u.test(token),
  );
  return {
    kind: "tokens",
    raw: body.trim(),
    tokens,
    mode: latin ? defaultMode : "prefix",
    stemLast,
  };
}

type Ctx = { text: string; folded: string; tokens: FoldedToken[] };

function makeCtx(text: string): Ctx {
  return {
    text,
    folded: foldForMatch(text),
    tokens: foldedTokensWithRange(text),
  };
}

// The matched wording as the person wrote it, or null.
function findTerm(term: CompiledTerm, ctx: Ctx): string | null {
  if (term.kind === "substring") {
    return ctx.folded.includes(term.needle) ? term.raw : null;
  }
  if (term.kind === "symbol") {
    return term.re.test(ctx.folded) ? term.raw : null;
  }
  const size = term.tokens.length;
  for (let i = 0; i + size <= ctx.tokens.length; i++) {
    let all = true;
    for (let j = 0; j < size && all; j++) {
      const mode: Mode = term.stemLast && j === size - 1 ? "prefix" : term.mode;
      const planToken = ctx.tokens[i + j];
      const termToken = term.tokens[j];
      all =
        planToken !== undefined &&
        termToken !== undefined &&
        tokenMatches(planToken.token, termToken, mode);
    }
    const first = ctx.tokens[i];
    const last = ctx.tokens[i + size - 1];
    if (all && first && last) return ctx.text.slice(first.start, last.end);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compiled rule set
// ---------------------------------------------------------------------------

function languageOf(language: string | undefined): string {
  return (language ?? "").toLowerCase().split(/[-_]/u)[0] ?? "";
}

type LexiconCache = {
  presets: Record<PresetId, CompiledTerm[]>;
  absolute: CompiledTerm[];
};

const lexiconCache = new Map<boolean, LexiconCache>();

function compileList(terms: string[]): CompiledTerm[] {
  const out: CompiledTerm[] = [];
  for (const term of terms) {
    const compiled = compileTerm(term, "chain");
    if (compiled) out.push(compiled);
  }
  return out;
}

// Turkish projects get the Turkish and the English lexicon; every other
// language gets the English one (plus its own literal terms).
function lexiconFor(turkish: boolean): LexiconCache {
  const hit = lexiconCache.get(turkish);
  if (hit) return hit;
  const presets = {} as Record<PresetId, CompiledTerm[]>;
  for (const id of PRESET_IDS) {
    const { tr, en } = PRESET_DETECTORS[id].terms;
    presets[id] = compileList(turkish ? [...tr, ...en] : en);
  }
  const absolute = compileList(
    turkish ? [...ABSOLUTE_TERMS.tr, ...ABSOLUTE_TERMS.en] : ABSOLUTE_TERMS.en,
  );
  const built = { presets, absolute };
  lexiconCache.set(turkish, built);
  return built;
}

type Compiled = {
  literals: { term: CompiledTerm; rule: string }[];
  presets: { id: PresetId; rule: string; terms: CompiledTerm[] }[];
  absolute: CompiledTerm[];
  approvedNumbers: Set<string>;
};

const NUMBER = /\d{1,3}(?:[.,\s ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;

// 1.000 / 1,000 / 1 000 -> 1000; 2,5 -> 2.5.
function normaliseNumber(raw: string): string {
  const compact = raw.replace(/[\s ]/gu, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(compact)) {
    return compact.replace(/[.,]/gu, "");
  }
  return compact.replace(",", ".");
}

function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((match) => normaliseNumber(match[0]));
}

const PRESET_BY_LABEL = new Map<string, PresetId>(
  PRESET_IDS.map((id) => [
    tokenizeFolded(PRESET_RULE_LABELS[id]).join(" "),
    id,
  ]),
);

function compileRules(rules: BrandRuleSet): Compiled {
  const turkish = languageOf(rules.language) === "tr";
  const ownMode: Mode =
    turkish || languageOf(rules.language) === "en" ? "chain" : "prefix";
  const lexicon = lexiconFor(turkish);
  const literals: Compiled["literals"] = [];
  const presets: Compiled["presets"] = [];
  const seenPresets = new Set<PresetId>();

  for (const rule of rules.never) {
    const text = (rule?.text ?? "").trim();
    if (!text) continue;
    const presetId = PRESET_BY_LABEL.get(tokenizeFolded(text).join(" "));
    if (presetId) {
      if (seenPresets.has(presetId)) continue;
      seenPresets.add(presetId);
      const terms =
        presetId === "no_competitors"
          ? (rules.competitors ?? [])
              .map((name) => compileTerm(name, ownMode))
              .filter((term): term is CompiledTerm => term !== null)
          : lexicon.presets[presetId];
      presets.push({ id: presetId, rule: text, terms });
      continue;
    }
    for (const raw of ruleTermsOf(rule)) {
      const term = compileTerm(raw, ownMode);
      if (term) literals.push({ term, rule: text });
    }
  }

  const approvedNumbers = new Set<string>();
  for (const claim of rules.approvedClaims ?? []) {
    for (const value of numbersIn(claim)) approvedNumbers.add(value);
  }
  return { literals, presets, absolute: lexicon.absolute, approvedNumbers };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function globalOf(re: RegExp): RegExp {
  return new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
}

function checkWith(text: string, compiled: Compiled): BrandFlag[] {
  if (!text.trim()) return [];
  const ctx = makeCtx(text);
  const flags: BrandFlag[] = [];
  const seen = new Set<string>();
  const push = (flag: BrandFlag) => {
    const key = `${flag.kind}|${foldForMatch(flag.matched)}|${flag.rule ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(flag);
  };

  // 1. Literal terms of the client's own rules: always block.
  for (const { term, rule } of compiled.literals) {
    const matched = findTerm(term, ctx);
    if (matched) push({ kind: "never-term", severity: "block", matched, rule });
  }

  // 2. Preset detectors (active only when the matching rule exists).
  let pricesFlagged = false;
  for (const preset of compiled.presets) {
    const detector = PRESET_DETECTORS[preset.id];
    const before = flags.length;
    for (const term of preset.terms) {
      const matched = findTerm(term, ctx);
      if (matched) {
        push({
          kind: "preset",
          severity: detector.severity,
          matched,
          rule: preset.rule,
        });
      }
    }
    for (const pattern of detector.patterns ?? []) {
      const hit = pattern.exec(text);
      if (hit && hit[0].trim()) {
        push({
          kind: "preset",
          severity: detector.patternSeverity ?? detector.severity,
          matched: hit[0].trim(),
          rule: preset.rule,
        });
      }
    }
    if (preset.id === "no_prices" && flags.length > before)
      pricesFlagged = true;
  }

  // 3. Unapproved figures: a warning only, and not twice when the no_prices
  // preset already flagged the text.
  if (!pricesFlagged) {
    for (const pattern of FIGURE_PATTERNS) {
      for (const hit of text.matchAll(globalOf(pattern))) {
        const matched = hit[0].trim();
        const numbers = numbersIn(matched);
        if (numbers.length === 0) continue;
        if (numbers.every((value) => compiled.approvedNumbers.has(value))) {
          continue;
        }
        push({ kind: "figure", severity: "warn", matched });
      }
    }
  }

  // 4. Absolute wording: a warning only.
  for (const term of compiled.absolute) {
    const matched = findTerm(term, ctx);
    if (matched) push({ kind: "absolute", severity: "warn", matched });
  }

  return flags;
}

export function checkText(
  text: string,
  rules: BrandRuleSet | null | undefined,
): BrandFlag[] {
  // Fail open: nothing to check against means nothing to flag.
  if (!rules || !Array.isArray(rules.never) || rules.never.length === 0) {
    return [];
  }
  if (typeof text !== "string") return [];
  return checkWith(text, compileRules(rules));
}

const ITEM_FIELDS = ["topic", "captionIdea"] as const;

export function checkItems(
  items: readonly PlanTextItem[] | null | undefined,
  rules: BrandRuleSet | null | undefined,
): ItemFlag[] {
  if (!rules || !Array.isArray(rules.never) || rules.never.length === 0) {
    return [];
  }
  if (!items) return [];
  const compiled = compileRules(rules);
  const out: ItemFlag[] = [];
  items.forEach((item, index) => {
    for (const field of ITEM_FIELDS) {
      const value = item?.[field];
      if (typeof value !== "string") continue;
      for (const flag of checkWith(value, compiled)) {
        out.push({ index, field, flag });
      }
    }
  });
  return out;
}

function severityOf(entry: BrandFlag | ItemFlag): Severity {
  return "flag" in entry ? entry.flag.severity : entry.severity;
}

export function blocksOf<T extends BrandFlag | ItemFlag>(
  flags: readonly T[] | null | undefined,
): T[] {
  return (flags ?? []).filter((entry) => severityOf(entry) === "block");
}

// The flags of one item, one per kind + wording (a topic and a caption that
// repeat the same word show one chip line).
export function flagsForItem(
  all: readonly ItemFlag[] | null | undefined,
  index: number,
): BrandFlag[] {
  const seen = new Set<string>();
  const out: BrandFlag[] = [];
  for (const entry of all ?? []) {
    if (entry.index !== index) continue;
    const key = `${entry.flag.kind}|${foldForMatch(entry.flag.matched)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry.flag);
  }
  return out;
}

// A failed rule load must be VISIBLE on the card, not read as "all fine". A
// set that loaded but holds no rules is a real check (the preset, figure and
// absolute-claim checks still ran), reported as zero rules, not as skipped.
export function brandCheckOf(
  rules: BrandRuleSet | null | undefined,
): BrandCheckState {
  if (!rules || !Array.isArray(rules.never)) return { state: "skipped" };
  return { state: "checked", rules: rules.never.length };
}

// ---------------------------------------------------------------------------
// Repair message (model-facing)
// ---------------------------------------------------------------------------

// One line, no quotes, no control characters: rule texts and matched wording
// are untrusted and must not break out of the message layout.
function echo(text: string, max: number): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
    .replace(/"/g, "'")
    .trim();
  const chars = [...flat];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : flat;
}

const DEFAULT_CLOSING = (toolName: string) =>
  `Rewrite only those fields without the flagged wording (keep date, time, channel and formatKey of every item), then call ${toolName} again with the FULL plan. If the client themselves asked for this wording, do not repeat the plan: tell them the brand rule blocks it and ask whether to change the rule.`;

// null without a block (a warning never costs a model round). `describe` names
// the item, e.g. "Item 3 (2026-10-05, instagram.post)", because buildPlanCard
// sorts and a bare number would be ambiguous. `options.closing` REPLACES the
// whole closing instruction (slot-first rewrites one piece, not a plan).
export function brandRepairMessage(
  hits: readonly ItemFlag[],
  describe: (index: number) => string,
  toolName: string,
  options?: { closing?: string },
): string | null {
  const blocks = blocksOf(hits);
  if (blocks.length === 0) return null;

  const lines: string[] = [];
  const lineKeys = new Set<string>();
  const brokenRules = new Set<string>();
  for (const { index, field, flag } of blocks) {
    const matched = echo(flag.matched, MAX_RULE_ECHO);
    const against = flag.rule
      ? `against the brand rule "${echo(flag.rule, MAX_RULE_ECHO)}"`
      : "against a brand rule";
    const line = `- ${echo(describe(index), MAX_RULE_ECHO)}, ${field}: contains "${matched}", ${against}.`;
    if (lineKeys.has(line)) continue;
    lineKeys.add(line);
    lines.push(line);
    brokenRules.add(foldForMatch(flag.rule ?? flag.matched));
  }

  const count = brokenRules.size;
  const header = `Brand rules: the plan breaks ${count} ${count === 1 ? "rule" : "rules"}.`;
  const closing = options?.closing ?? DEFAULT_CLOSING(toolName);
  return [header, ...lines.slice(0, MAX_REPAIR_LINES), closing].join("\n");
}
