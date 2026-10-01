import type { BrandConstitutionPayload } from "@/server/agency/constitution/constitution-schema";

import {
  DISCOVERY_CAPS,
  TIER_LIMITS,
  type Candidate,
  type FieldId,
  type Row,
  type Tier,
} from "./contract";

// Confidence tiers (pure): the model reports a score and where the evidence
// came from; the server caps the score by the evidence, then sorts every
// descriptive field into accepted / assumed / unknown. No Date, no random.

export const EVIDENCE = ["site", "web", "both", "inferred"] as const;
export type Evidence = (typeof EVIDENCE)[number];

// A guess can never reach auto-accept; one source tops out at 90.
const EVIDENCE_CAPS: Record<Evidence, number> = {
  inferred: 70,
  site: 90,
  web: 90,
  both: 100,
};

export type FieldConfidence = { score: number; evidence: Evidence };

type TextField =
  | "identity"
  | "businessModel"
  | "positioning"
  | "valueProposition"
  | "toneOfVoice";
type ListField = "products" | "markets" | "audiences" | "competitors";
export type ConfidenceField = TextField | ListField;
export type ConfidenceMap = Partial<Record<ConfidenceField, FieldConfidence>>;

const TEXT_FIELDS: readonly TextField[] = [
  "identity",
  "businessModel",
  "positioning",
  "valueProposition",
  "toneOfVoice",
];
const LIST_FIELDS: readonly ListField[] = [
  "products",
  "markets",
  "audiences",
  "competitors",
];

const LABELS: Record<ConfidenceField, string> = {
  identity: "About",
  businessModel: "Business model",
  products: "Products",
  markets: "Markets",
  audiences: "Audience",
  positioning: "Positioning",
  valueProposition: "Value proposition",
  toneOfVoice: "Voice",
  competitors: "Competitors",
};

// Which screen row a constitution field feeds; the others only get tiered.
const ROW_OF: Partial<Record<ConfidenceField, FieldId>> = {
  identity: "about",
  audiences: "audience",
  products: "products",
  markets: "markets",
  toneOfVoice: "voice",
  positioning: "positioning",
  competitors: "competitors",
};
const ROW_ORDER: readonly ConfidenceField[] = [
  "identity",
  "audiences",
  "products",
  "markets",
  "toneOfVoice",
  "positioning",
  "competitors",
];

const ASSUMPTION_VALUE_MAX = 120;

export function finalScore(score: number, evidence: Evidence): number {
  if (!Number.isFinite(score)) return 0;
  const cap = EVIDENCE_CAPS[evidence] ?? EVIDENCE_CAPS.inferred;
  return Math.round(Math.min(Math.max(score, 0), 100, cap));
}

export function tierOf(score: number): Tier {
  if (score >= TIER_LIMITS.accepted) return "accepted";
  if (score >= TIER_LIMITS.assumed) return "assumed";
  return "unknown";
}

// Cuts by code points so an emoji or a surrogate pair is never split.
function cut(text: string, max: number): string {
  const points = Array.from(text.trim());
  return points.length > max ? points.slice(0, max).join("") : points.join("");
}

// Stable server-side candidate id from field + text (two FNV-1a rounds, 40
// bits): the same value always maps to the same id, which keeps this module
// free of randomness and makes a re-run idempotent.
export function candidateIdFor(field: FieldId, text: string): string {
  const input = `${field}\u0000${text}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return `c_${(hex(a) + hex(b)).slice(0, 10)}`;
}

function cleanList(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = cut(item, DISCOVERY_CAPS.textMax);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function candidatesOf(
  field: FieldId,
  items: readonly string[],
  score: number,
): Candidate[] {
  return cleanList(items)
    .slice(0, DISCOVERY_CAPS.maxCandidatesPerRow)
    .map((text) => ({
      id: candidateIdFor(field, text),
      text,
      score,
      added: false,
    }));
}

export type AppliedTiers = {
  payload: BrandConstitutionPayload;
  dossierPayload: BrandConstitutionPayload;
  rows: Row[];
};

export function applyTiers(
  payload: BrandConstitutionPayload,
  confidence: ConfidenceMap,
): AppliedTiers {
  const next: BrandConstitutionPayload = { ...payload };
  const dossier: BrandConstitutionPayload = { ...payload };
  const assumptions = [...payload.assumptions];
  const openQuestions = [...payload.openQuestions];
  const rowByField = new Map<ConfidenceField, Row>();

  const settle = (field: ConfidenceField, items: string[]) => {
    const given = confidence[field];
    const score = given ? finalScore(given.score, given.evidence) : 0;
    // An empty value is "not found" whatever the model claimed for it.
    const tier: Tier = items.length === 0 ? "unknown" : tierOf(score);
    const label = LABELS[field];
    const rowField = ROW_OF[field];
    let saved: string[] = [];
    let candidates: Candidate[] = [];
    if (tier === "accepted") {
      saved = cleanList(items);
    } else if (tier === "assumed") {
      const value = cut(items.join(", "), ASSUMPTION_VALUE_MAX);
      assumptions.push(`${label}: ${value} (assumed, ${score}%)`);
      if (rowField) candidates = candidatesOf(rowField, items, score);
    } else {
      openQuestions.push(`${label}: not found with enough confidence`);
    }
    if (rowField) {
      rowByField.set(field, { field: rowField, tier, score, saved, candidates });
    }
    return tier;
  };

  for (const field of TEXT_FIELDS) {
    const value = payload[field];
    const text = value.trim();
    const tier = settle(field, text ? [text] : []);
    if (tier === "unknown") next[field] = "";
    if (tier !== "accepted") dossier[field] = "";
  }
  for (const field of LIST_FIELDS) {
    const items = payload[field].filter((item) => item.trim());
    const tier = settle(field, items);
    if (tier === "unknown") next[field] = [];
    if (tier !== "accepted") dossier[field] = [];
  }

  // Owner rule: nothing web-derived ever becomes an approved claim.
  next.assumptions = assumptions;
  next.openQuestions = openQuestions;
  next.approvedClaims = [];
  dossier.assumptions = assumptions;
  dossier.openQuestions = openQuestions;
  dossier.approvedClaims = [];

  const rows: Row[] = [];
  for (const field of ROW_ORDER) {
    const row = rowByField.get(field);
    if (row) rows.push(row);
  }
  return { payload: next, dossierPayload: dossier, rows };
}
