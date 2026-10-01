import { GUARDRAILS } from "@/lib/guided-setup/contract";

// Data for the brand-rule checker (brand-rules.ts). Pure: no IO.
//
// Terms are written FOLDED (lowercase, ASCII-ish: "ucret", not "ücret") because
// the checker folds the plan text the same way (src/lib/text-fold.ts). A term of
// 4+ letters also matches its inflected forms (see brand-rules.ts); a trailing
// "*" marks a bare STEM that matches any continuation ("iyiles*" hits
// "iyilesme", "iyilestirir").

export const PRESET_IDS = [
  "no_prices",
  "no_competitors",
  "no_health",
  "no_guarantees",
  "no_politics",
  "no_slang",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type Severity = "block" | "warn";

export type PresetDetector = {
  // Severity of a TERM hit.
  severity: Severity;
  terms: { tr: string[]; en: string[] };
  // Regexes run on the ORIGINAL text. Never global (no lastIndex state).
  patterns?: RegExp[];
  // Severity of a PATTERN hit; defaults to `severity`.
  patternSeverity?: Severity;
};

// The six guided guardrail labels are English even in a Turkish project and
// are the exact texts stored as client-rule rows, so a rule is a preset when
// its folded text equals one of these. Derived from GUARDRAILS, never retyped.
function buildPresetLabels(): Record<PresetId, string> {
  const labels = {} as Record<PresetId, string>;
  for (const id of PRESET_IDS) labels[id] = "";
  for (const option of GUARDRAILS) {
    const key = option.id.replace(/^guardrail\./, "");
    if ((PRESET_IDS as readonly string[]).includes(key)) {
      labels[key as PresetId] = option.label;
    }
  }
  return labels;
}
export const PRESET_RULE_LABELS: Record<PresetId, string> = buildPresetLabels();

// Percent and currency figures. Used by the no_prices preset and by the
// unapproved-figure warning. The "(?<![\p{L}\p{N}])" guards stand in for \b,
// which is ASCII-only.
// A number with optional thousand groups (1.000, 1,000, 1 000) and decimals.
const NUM = String.raw`\d{1,3}(?:[.,\u00A0 ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const CURRENCY_WORD = "(?:tl|try|eur|euro|usd|gbp|dolar|dollars?)";

export const FIGURE_PATTERNS: RegExp[] = [
  // Currency symbol before or after a number: ₺50, $ 5, 50€
  new RegExp(String.raw`[₺$€£]\s?(?:${NUM})`, "u"),
  new RegExp(String.raw`(?:${NUM})\s?[₺$€£]`, "u"),
  // Number next to a currency code or name: 50 TL, 20 USD, 100 lira(dan)
  new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${NUM})\s?${CURRENCY_WORD}(?![\p{L}\p{N}])`,
    "iu",
  ),
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${NUM})\s?lira[\p{L}]*`, "iu"),
  // Percent forms: %20 and 20%
  new RegExp(String.raw`%\s?(?:${NUM})`, "u"),
  new RegExp(String.raw`(?:${NUM})\s?%`, "u"),
];

const PERCENT_100 = /(?<![\d.,])100\s?%|%\s?100(?![\d.,])/u;

// ©, ® and ™ are Extended_Pictographic but are not emoji in a caption.
const EMOJI = new RegExp(
  String.raw`(?:(?![\u00A9\u00AE\u2122\u203C\u2049])\p{Extended_Pictographic}\uFE0F?)+`,
  "u",
);

export const PRESET_DETECTORS: Record<PresetId, PresetDetector> = {
  no_prices: {
    severity: "block",
    terms: {
      tr: [
        "indirim",
        "fiyat",
        "ucret",
        "ucretsiz",
        "bedava",
        "lira",
        "taksit",
        "kampanya fiyat",
      ],
      en: ["discount", "price", "prices", "pricing", "sale", "free", "cheap"],
    },
    patterns: FIGURE_PATTERNS,
  },
  // The terms of this preset are the rule set's competitors (the loader).
  no_competitors: {
    severity: "block",
    terms: { tr: [], en: [] },
  },
  no_health: {
    severity: "block",
    terms: {
      tr: [
        "tedavi",
        "iyiles*",
        "sifa",
        "kanser",
        "agrisiz",
        "ameliyatsiz",
        "ameliyat",
        "hastalik",
        "ilac",
      ],
      en: [
        "cure",
        "heal",
        "treatment",
        "cancer",
        "painless",
        "disease",
        "remedy",
      ],
    },
  },
  no_guarantees: {
    severity: "block",
    terms: {
      tr: ["garanti", "kesin sonuc", "risksiz"],
      en: ["guarantee", "guaranteed", "risk-free", "no risk"],
    },
    patterns: [PERCENT_100],
  },
  // Political and religious wording is a judgement call: warn, never block.
  no_politics: {
    severity: "warn",
    terms: {
      tr: ["siyaset", "siyasi", "secim", "cumhurbaskani"],
      en: ["politics", "political", "election", "religion"],
    },
  },
  // Emoji is unambiguous (block); swearing and slang lists are short and
  // incomplete (warn).
  no_slang: {
    severity: "warn",
    terms: {
      tr: ["amk", "aq", "salak", "gerizekali", "siktir", "ulan"],
      en: ["wtf", "damn", "shit", "fuck", "bullshit", "crap", "lol", "bro"],
    },
    patterns: [EMOJI],
    patternSeverity: "block",
  },
};

// Superlatives nobody can prove. Always a warning, never a block.
export const ABSOLUTE_TERMS: { tr: string[]; en: string[] } = {
  tr: ["en iyi", "bir numara", "tek", "essiz"],
  en: ["best", "number one", "only", "unique", "#1"],
};
