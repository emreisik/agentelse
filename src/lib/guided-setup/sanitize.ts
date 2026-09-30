// Text sanitizer of the guided setup (spec appendix A).
// Pure, isomorphic. Every rule has an id so a test can pin it and a per-rule
// counter can report drops without ever logging the text.

import {
  AI_TEXT_CAPS,
  SEED_MAX,
  type AiTextKind,
} from "@/lib/guided-setup/contract";

export type RejectRule =
  | "empty"
  | "too_long"
  | "marker"
  | "charset"
  | "url"
  | "role"
  | "marks"
  | "mixed_script"
  | "instruction"
  | "numbers";

export type Sanitized =
  | { ok: true; text: string }
  | { ok: false; rule: RejectRule };

// Kinds where an invented claim is the risk: two or more digits in a row are
// rejected there. Audience labels legitimately carry ages ("25 to 40").
const NUMBER_KINDS: ReadonlySet<AiTextKind> = new Set(["identity", "angle"]);

const LINE_BREAKS = /[\t\n\r\u000b\u000c\u0085\p{Zl}\p{Zp}]/gu;
// Invisible payload carriers, removed (never repaired around): control and
// format characters (bidi, zero width), UNPAIRED surrogates (with the u flag
// \p{Cs} matches only a lone surrogate, a valid pair is one astral code point,
// so emoji are never split) and every default-ignorable code point (variation
// selectors, tag characters, soft hyphen, fillers).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
const BRACKETS = /[[\]{}<>`|\\^~*_#=@]/u;
// Letters, marks, digits, space and the punctuation of the 14 supported
// languages: Arabic comma, semicolon and question mark, guillemets, low quotes.
const CHARSET = /^[\p{L}\p{M}\p{N} .,;:!?&+/()'’‘"“”„‚«»‹›–—‐…·،؛؟-]+$/u;
// Five or more stacked combining marks are a payload carrier, never a word
// (fully vocalized Arabic stacks at most three).
const MARK_RUN = /\p{M}{5,}/u;

// NFKC already folds the fullwidth full stop; the ideographic (U+3002) and the
// halfwidth ideographic (U+FF61) full stops are NOT folded, so they are listed.
// A bare IPv4 address is a link too.
const URL_DIRECT =
  /(?:\b(?:https?|ftp|file|data|javascript):|\/\/|\bwww\.)|[\p{L}\p{N}-][.\u3002\uFF61][\p{L}]{2,}|(?<![\p{L}\p{N}.])\d{1,3}(?:[.\u3002\uFF61]\d{1,3}){3}(?![\p{L}\p{N}])/iu;
// "acme . com", "acme dot com", "acme (dot) com": links written to dodge
// URL_DIRECT. Deviates from spec Appendix A on purpose (stricter): the trailing
// boundary is a Unicode lookahead, not the ASCII-only \b ("acme . ком"), and the
// "(dot)" spelling is covered with or without spaces.
const URL_SPELLED =
  /[\p{L}\p{N}-]\s[.\u3002\uFF61]\s?[\p{L}]{2,}(?![\p{L}\p{N}])|[\p{L}\p{N}]\s(?:dot|nokta|pika|точка|тачка|tačka|tacka)\s(?:com|net|org|io|co|info|app|shop|tr|mk|al|rs|bg|gr|de|fr|it|es|uk|ru)(?![\p{L}\p{N}])|[\p{L}\p{N}]\s?[([]\s?dot\s?[)\]]\s?(?:com|net|org|io|co|info|app|shop|tr|mk|al|rs|bg|gr|de|fr|it|es|uk|ru)(?![\p{L}\p{N}])/iu;
const URL_SHAPE = new RegExp(`${URL_DIRECT.source}|${URL_SPELLED.source}`, "iu");

// A whole-word check, linear in the text: split into letter runs and look at
// the scripts inside each run. A run that mixes two scripts of the list below is
// a homoglyph disguise ("Ignоre" with a Cyrillic о, an Armenian օ, a Cherokee
// Ꭵ), never a real word. The list holds the scripts that carry Latin lookalikes;
// Han, Kana and Hangul are left out because real words mix those.
const HOMOGLYPH_SCRIPTS: readonly RegExp[] = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Coptic}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Cherokee}/u,
  /\p{Script=Georgian}/u,
];
function hasMixedScriptWord(text: string): boolean {
  for (const run of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
    let scripts = 0;
    for (const script of HOMOGLYPH_SCRIPTS) {
      if (script.test(run) && ++scripts >= 2) return true;
    }
  }
  return false;
}

// Lengths are in code points (never UTF-16 units) and a clip cannot split a
// surrogate pair: a lone surrogate serializes to JSON as an escape that
// PostgreSQL jsonb rejects, which would fail every write of that answer.
function exceedsCodePoints(text: string, max: number): boolean {
  if (text.length <= max) return false; // every code point is at least one unit
  if (text.length > max * 2) return true; // ... and at most two
  return Array.from(text).length > max;
}
export function clipCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length > max ? points.slice(0, max).join("").trimEnd() : text;
}

const ROLE_PREFIX =
  /^\s*(?:system|assistant|developer|user|human|ai|tool|sistem|asistan|sistemi|системa?|asistent|përdorues|sistemi)\s*[:>]/iu;
// Strips EVERY leading role label ("user: tool: x" -> "x") so the cleaners are
// idempotent: the same text is cleaned at Review, at save and again at Approve,
// and a single-pass strip would expose a second label on the next pass.
function stripRolePrefixes(input: string): string {
  let text = input;
  while (ROLE_PREFIX.test(text)) text = text.replace(ROLE_PREFIX, "");
  return text.replace(/\s+/gu, " ").trim();
}
const ROLE_ANYWHERE = /\b(?:system|assistant|developer|sistem)\s*:/iu;

// One entry per language of SUPPORTED_LANGUAGES (src/lib/locales.ts), because
// the locale directive forces model output into project.language. Each family
// covers: ignore-previous, always-say / recommend, from-now-on, system prompt.
// Heuristic by nature: a false positive costs one option, a false negative is
// covered by the other controls (closed sinks, nothing pre-selected, exact
// string in Review, id-only apply).
export const INSTRUCTION_FAMILIES: Record<string, RegExp[]> = {
  en: [
    /\b(?:ignore|disregard|forget|override|bypass|skip)\b[^.!?]{0,40}\b(?:previous|prior|above|earlier|all|any|every|instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|system)\b/iu,
    /\b(?:you (?:must|should|will|shall|need to|have to)|always\b[^.!?]{0,30}\b(?:say|mention|write|answer|reply|recommend|include|link|promote|suggest|tell)|never\b[^.!?]{0,20}\b(?:say|mention|reveal|tell|disclose)|do not (?:tell|mention|reveal)|from now on|starting now|new instructions?|updated instructions?|system prompt|developer message|act as|pretend (?:to be|you)|you are now|jailbreak|as an ai|respond only|reply only)\b/iu,
  ],
  tr: [
    /(?:talimat|komut|y[öo]nerge|istem|kural)\w*\s+(?:yok\s+say|unut|g[öo]rmezden\s+gel|dikkate\s+alma|ge[çc]ersiz)/iu,
    /(?:yok\s+say|unut|g[öo]rmezden\s+gel)\w*\s+[^.!?]{0,30}(?:talimat|komut|y[öo]nerge|istem|kural)/iu,
    /(?:[öo]nceki|yukar[ıi]daki)\s+(?:talimat|komut|y[öo]nerge|istem|kural)/iu,
    /\bsistem\s+(?:istem|prompt|mesaj)\w*/iu,
    /\bher\s+zaman\b[^.!?]{0,40}(?<![\p{L}\p{N}])(?:s[öo]yle|belirt|[öo]ner|yaz|yan[ıi]tla|tavsiye|bahset)\w*/iu,
    /\b(?:hi[çc]bir\s+zaman|asla)\s+(?:s[öo]yleme|belirtme|bahsetme)\w*/iu,
    /(?<![\p{L}\p{N}])[şs]u\s+andan\s+itibaren|\bbundan\s+sonra\s+(?:her|sadece|yaln[ıi]zca)\b|\byeni\s+talimat/iu,
    /\bgibi\s+davran\b|\brol[üu]n[üu]\s+(?:yap|oyna)/iu,
  ],
  sq: [
    /\binjoro\w*\s+[^.!?]{0,30}(?:udh[eë]zim|urdh[eë]r|rregull)\w*/iu,
    /(?:udh[eë]zimet|urdh[eë]rat)\s+e\s+m[eë]parshme/iu,
    /\bgjithmon[eë](?![\p{L}\p{N}])[^.!?]{0,40}(?:thuaj|p[eë]rmend|rekomando|shkruaj|p[eë]rdor)\w*/iu,
    /\bnga\s+tani\s+e\s+tutje\b/iu,
    /\budh[eë]zimet\s+e\s+sistemit\b|\bsystem\s+prompt\b/iu,
  ],
  mk: [
    /игнорирај\w*\s+[^.!?]{0,30}(?:упатств|инструкц|правил)\w*/iu,
    /(?:претходн\w*|сите)\s+(?:упатств|инструкц)\w*/iu,
    /секогаш[^.!?]{0,40}(?:кажи|спомни|препорач|пиши|користи)\w*/iu,
    /од\s+сега(?:\s+па\s+натаму)?/iu,
    /(?:системск\w*|нови)\s+(?:промпт|упатств|инструкц|порака)\w*/iu,
  ],
  sr: [
    /\b(?:zanemari|ignori[sš]i)\w*\s+[^.!?]{0,30}(?:uputstv|instrukcij|pravil)\w*/iu,
    /\bprethodn\w*\s+(?:uputstv|instrukcij)\w*/iu,
    /\buvek\b[^.!?]{0,40}(?:reci|spomeni|preporu[cč]i|pi[sš]i|koristi)\w*/iu,
    /\bod\s+sada(?![\p{L}\p{N}])/iu,
    /\bsistemsk\w*\s+(?:prompt|zahtev|uputstv)\w*/iu,
    /занемари\w*\s+[^.!?]{0,30}(?:упутств|инструкц|правил)\w*/iu,
    /увек[^.!?]{0,40}(?:реци|спомени|препоручи|пиши|користи)\w*/iu,
    /од\s+сада/iu,
  ],
  bg: [
    /игнорирай\w*\s+[^.!?]{0,30}(?:инструкц|указани|правил)\w*/iu,
    /предишни\w*\s+(?:инструкц|указани)\w*/iu,
    /винаги[^.!?]{0,40}(?:казвай|споменавай|препоръчвай|пиши|използвай)\w*/iu,
    /от\s+сега\s+нататък/iu,
    /системн\w*\s+(?:промпт|инструкц)\w*/iu,
  ],
  ru: [
    /игнорируй\w*\s+[^.!?]{0,30}(?:инструкц|указани|правил)\w*/iu,
    /(?:предыдущ\w*|прежн\w*)\s+(?:инструкц|указани)\w*/iu,
    /всегда[^.!?]{0,40}(?:говори|упоминай|рекомендуй|пиши|используй)\w*/iu,
    /с\s+этого\s+момента/iu,
    /системн\w*\s+(?:промпт|инструкц)\w*/iu,
  ],
  el: [
    /αγνόησε\s+[^.!?]{0,30}(?:οδηγίες|εντολές|κανόνες)/iu,
    /(?:προηγούμενες|παραπάνω)\s+(?:οδηγίες|εντολές)/iu,
    /πάντα[^.!?]{0,40}(?:λέγε|αναφέρε|πρότεινε|γράφε|χρησιμοποίησε)/iu,
    /από\s+τώρα\s+και\s+στο\s+εξής/iu,
    /οδηγίες\s+συστήματος/iu,
  ],
  de: [
    /\b(?:ignorier\w*|missachte\w*|vergiss)\b[^.!?]{0,40}\b(?:vorherigen|früheren|fruheren|alle|anweisungen|regeln|instruktionen)\b/iu,
    /\bimmer\b[^.!?]{0,40}\b(?:sag\w*|erwähn\w*|erwaehn\w*|empfiehl\w*|schreib\w*|nutz\w*)/iu,
    /\bab\s+jetzt\b|\bneue\s+anweisungen\b|\bsystem-?prompt\b/iu,
  ],
  fr: [
    /\b(?:ignore[rz]?|oublie[rz]?)\b[^.!?]{0,40}\b(?:instructions?|consignes?|r[èe]gles?)\b/iu,
    /\btoujours\b[^.!?]{0,40}(?<![\p{L}\p{N}])(?:dire|dis|mentionne\w*|recommande\w*|[ée]cri\w*|utilise\w*)/iu,
    /\bdésormais\b|\bdesormais\b|(?<![\p{L}\p{N}])à\s+partir\s+de\s+maintenant(?![\p{L}\p{N}])|\binvite\s+syst[èe]me\b|\bsystem\s+prompt\b/iu,
  ],
  es: [
    /\b(?:ignora|ignore|olvida)\w*\b[^.!?]{0,40}\b(?:instrucciones|reglas|indicaciones)\b/iu,
    /\bsiempre\b[^.!?]{0,40}\b(?:di|dile|menciona|recomienda|escribe|usa)\w*/iu,
    /\ba\s+partir\s+de\s+ahora\b|\bnuevas\s+instrucciones\b|\bprompt\s+del\s+sistema\b/iu,
  ],
  it: [
    /\b(?:ignora|dimentica)\w*\b[^.!?]{0,40}\b(?:istruzioni|regole|indicazioni)\b/iu,
    /\bsempre\b[^.!?]{0,40}(?:di|dì|menziona|raccomanda|scrivi|usa)\w*/iu,
    /\bd['’]ora\s+in\s+poi\b|\bnuove\s+istruzioni\b|\bprompt\s+di\s+sistema\b/iu,
  ],
  nl: [
    /\b(?:negeer|vergeet)\b[^.!?]{0,40}\b(?:instructies|regels|opdrachten)\b/iu,
    /\baltijd\b[^.!?]{0,40}\b(?:zeg|noem|beveel|schrijf|gebruik)\w*/iu,
    /\bvanaf\s+nu\b|\bnieuwe\s+instructies\b|\bsysteemprompt\b/iu,
  ],
  ar: [
    /تجاهل\s+[^.!?]{0,30}(?:التعليمات|الأوامر|القواعد)/u,
    /(?:التعليمات|الأوامر)\s+السابقة/u,
    /دائمًا\s+(?:قل|اذكر|أوصِ|اكتب|استخدم)|دائما\s+(?:قل|اذكر|اكتب|استخدم)/u,
    /من\s+الآن\s+فصاعدًا|من\s+الان\s+فصاعدا|تعليمات\s+النظام/u,
  ],
};

const ALL_INSTRUCTION_PATTERNS = Object.values(INSTRUCTION_FAMILIES).flat();

// Accents, dots and per-letter combining marks must not hide a trigger word
// ("Ignóre", "İgnore", "I\u0301gnore"): the patterns also run on a folded copy
// (NFKD, marks removed, dotless/dotted i to plain i). Punctuation is untouched,
// so the sentence-bounded gaps ([^.!?]) still mean the same thing.
function foldAccents(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[ıİ]/gu, "i");
}

export function looksInstructionShaped(text: string): boolean {
  const folded = foldAccents(text);
  return ALL_INSTRUCTION_PATTERNS.some(
    (pattern) => pattern.test(text) || (folded !== text && pattern.test(folded)),
  );
}

// Flatten to one clean line: NFKC, line breaks to spaces, invisible characters
// removed (controls, bidi, zero width, lone surrogates, default-ignorables),
// whitespace collapsed. Shared by every text entry point. The result is always
// well-formed UTF-16.
export function flatten(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(LINE_BREAKS, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// The rules of cleanOptionText, in the order they run. Each entry says
// "reject" when test() is true. Exported so a test can remove one rule at a
// time and prove what it was worth; the ids double as telemetry counters (never
// the text). Cheap checks first: an over-long candidate never reaches a regex.
export type RuleDef = {
  id: Exclude<RejectRule, "empty">;
  test: (text: string, kind: AiTextKind) => boolean;
};
export const RULES: readonly RuleDef[] = [
  { id: "too_long", test: (t, k) => exceedsCodePoints(t, AI_TEXT_CAPS[k]) },
  { id: "marker", test: (t) => BRACKETS.test(t) },
  { id: "charset", test: (t) => !CHARSET.test(t) },
  { id: "url", test: (t) => URL_SHAPE.test(t) },
  { id: "role", test: (t) => ROLE_PREFIX.test(t) || ROLE_ANYWHERE.test(t) },
  { id: "marks", test: (t) => MARK_RUN.test(t) },
  { id: "mixed_script", test: (t) => hasMixedScriptWord(t) },
  { id: "instruction", test: (t) => looksInstructionShaped(t) },
  {
    id: "numbers",
    test: (t, k) => NUMBER_KINDS.has(k) && /\d{2,}/u.test(t),
  },
];

export function applyRules(
  raw: unknown,
  kind: AiTextKind,
  rules: readonly RuleDef[] = RULES,
): Sanitized {
  if (typeof raw !== "string") return { ok: false, rule: "empty" };
  const text = flatten(raw);
  if (!text) return { ok: false, rule: "empty" };
  for (const rule of rules) {
    if (rule.test(text, kind)) return { ok: false, rule: rule.id };
  }
  return { ok: true, text };
}

// AI-authored option text. REJECTS, never repairs or truncates.
export function cleanOptionText(raw: unknown, kind: AiTextKind): Sanitized {
  return applyRules(raw, kind, RULES);
}

// The content-neutral half of the rules: does this text have the SHAPE of a
// link, a marker, a role line, a homoglyph disguise or an instruction? No
// charset, no length, no digits: used for long free text (the Quick Discovery
// payload scrub, display previews) where those rules would drop honest prose.
export type HostileRule =
  | "marker"
  | "url"
  | "role"
  | "marks"
  | "mixed_script"
  | "instruction";
const HOSTILE_IDS: ReadonlySet<string> = new Set<HostileRule>([
  "marker",
  "url",
  "role",
  "marks",
  "mixed_script",
  "instruction",
]);
export function hostileShape(text: string): HostileRule | null {
  const hit = RULES.find(
    (rule) => HOSTILE_IDS.has(rule.id) && rule.test(text, "audience"),
  );
  return (hit?.id as HostileRule | undefined) ?? null;
}

// The client's own typed words (stored as the answer). Made harmless, not judged.
export function cleanUserText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  let text = flatten(raw).replace(/[[\]{}<>`]/gu, " ");
  text = stripRolePrefixes(text);
  if (!text) return null;
  return clipCodePoints(text, max);
}

// Deterministic sentence cut for model paragraphs: never a mid-word cut.
export function firstSentence(raw: string): string {
  const text = flatten(raw);
  const match = /^(.+?[.!?…])(?:\s|$)/u.exec(text);
  return (match?.[1] ?? text).replace(/[.!…]+$/u, "").trim();
}

export function foldLabel(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ı/gu, "i")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Anything that enters a PAID, search-enabled model prompt (the client's opening
// words, the typed business answer). Stricter than cleanUserText because a link
// in the prompt lets a hostile page steer what gets persisted and a spelled-out
// domain is still a link: markup characters are replaced, URL-shaped TOKENS are
// dropped (an "@handle" is kept), and the whole text is refused (null) when
// what remains still reads as a spelled-out link, an instruction, a homoglyph
// disguise or a payload of combining marks. Work is bounded (3 x max code
// points) before any regex runs. It cannot stop a benign-looking steer ("search
// 30 times"); that needs the prompt's own cap and per-call bounds (spec 8.6).
const PROMPT_MARKUP = /[[\]{}<>`|\\^~*_#=]/gu;
const URL_TOKEN =
  /^(?:(?:https?|ftp|file|data|javascript|vbscript|mailto|tel|sms|wss?):|\/\/|www\.)|[\p{L}\p{N}-][.\u3002\uFF61][\p{L}]{2,}|^\d{1,3}(?:[.\u3002\uFF61]\d{1,3}){3}(?![\p{L}\p{N}])/iu;
export function cleanPromptText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const working = clipCodePoints(flatten(raw), max * 3);
  let text = working
    .replace(PROMPT_MARKUP, " ")
    .split(" ")
    .filter((token) => token && !URL_TOKEN.test(token))
    .join(" ");
  text = stripRolePrefixes(text);
  if (
    !text ||
    URL_SPELLED.test(text) ||
    MARK_RUN.test(text) ||
    hasMixedScriptWord(text) ||
    looksInstructionShaped(text)
  ) {
    return null;
  }
  return clipCodePoints(text, max);
}

// The client's own opening words (a chat message) as "What the client told us".
export function cleanSeedText(raw: unknown): string | null {
  return cleanPromptText(raw, SEED_MAX);
}

// Display-only text ("Current: ..."): never stored. Anything that could pass as
// a link, a marker or an instruction is dropped; a long value is clipped at a
// word boundary with an ellipsis (it is a preview, not a claim). Only the first
// 4 x max code points are inspected.
export function cleanDisplayText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = flatten(raw);
  if (!text) return null;
  if (hostileShape(clipCodePoints(text, max * 4)) !== null) return null;
  if (!exceedsCodePoints(text, max)) return text;
  const cut = Array.from(text).slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
