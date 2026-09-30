// Guided setup: merges the sheet's picks into the Brand Core constitution.
// Pure: no IO, no server-only. Depends only on the payload schema and the marker.
import {
  BrandConstitutionPayloadSchema,
  type BrandConstitutionPayload,
} from "@/server/agency/constitution/constitution-schema";
import { GUIDED_ONLY_OPEN_QUESTION } from "@/lib/guided-setup/contract";

export type ConstitutionPatch = {
  identity?: string;
  positioning?: string;
  toneOfVoice?: string;
  audiences?: string[];
};
export type ProjectLocale = { language: string; country: string };
// What the project already says about itself (BrandDossier), used ONLY to seed a
// thin first version so the identity/positioning/tone the workers were reading
// through getBrandContext's dossier fallback do not vanish behind an empty v1.
export type ThinSeed = {
  identity?: string | null;
  positioning?: string | null;
  toneOfVoice?: string | null;
  audiences?: readonly string[] | null;
};

// The ONLY payload fields the sheet may change. Everything else is copied.
export const PATCHABLE_FIELDS = [
  "identity",
  "positioning",
  "toneOfVoice",
  "audiences",
] as const satisfies readonly (keyof BrandConstitutionPayload)[];

const text = (value: string | null | undefined) =>
  typeof value === "string" ? value.trim() : "";

export function thinConstitution(
  locale: ProjectLocale,
  seed: ThinSeed = {},
): BrandConstitutionPayload {
  return BrandConstitutionPayloadSchema.parse({
    language: locale.language,
    country: locale.country,
    identity: text(seed.identity),
    businessModel: "",
    products: [],
    markets: [],
    audiences: (seed.audiences ?? []).map(text).filter(Boolean),
    positioning: text(seed.positioning),
    valueProposition: "",
    personality: "",
    toneOfVoice: text(seed.toneOfVoice),
    visualIdentity: "",
    approvedClaims: [],
    forbiddenClaims: [],
    negativeBrief: [],
    customerProblems: [],
    customerObjections: [],
    competitors: [],
    differentiators: [],
    legalRestrictions: [],
    knownFacts: [],
    assumptions: [],
    // Brand Core reports this as an unverified claim, so the agent knows the
    // profile is partial (BrandTwin turns assumptions + openQuestions into
    // unverifiedClaims).
    openQuestions: [GUIDED_ONLY_OPEN_QUESTION],
    logoAssetIds: [],
  });
}

// "The sheet wrote this from a few taps and nothing researched it": the marker
// is still there and the researched sections are still empty.
export function isGuidedOnly(payload: BrandConstitutionPayload): boolean {
  return (
    payload.openQuestions.includes(GUIDED_ONLY_OPEN_QUESTION) &&
    payload.businessModel.trim() === "" &&
    payload.valueProposition.trim() === "" &&
    payload.knownFacts.length === 0
  );
}

// For callers holding a raw DB payload (QuickDiscovery's claim gate).
export function isGuidedOnlyRaw(raw: unknown): boolean {
  const parsed = BrandConstitutionPayloadSchema.safeParse(raw);
  return parsed.success && isGuidedOnly(parsed.data);
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

// What the merge starts from, decided in ONE place. A MOCK active row (seed and
// test runs write them into the shared development database) is treated as
// ABSENT: its text must never be copied into a real version, the new version
// simply supersedes it. A row whose payload no longer parses is "unreadable":
// the caller FAILS the part instead of publishing a thin version over it.
export type ActiveRow = { isMock: boolean; payload: unknown } | null;
export type BaseResult =
  | { kind: "absent" }
  | { kind: "base"; payload: BrandConstitutionPayload }
  | { kind: "unreadable" };
export function baseOf(active: ActiveRow): BaseResult {
  if (active === null || active.isMock) return { kind: "absent" };
  const parsed = BrandConstitutionPayloadSchema.safeParse(active.payload);
  return parsed.success
    ? { kind: "base", payload: parsed.data }
    : { kind: "unreadable" };
}

// Apply the person's picks onto the ACTIVE payload. User fields win; every
// other field is byte-identical to the base, in particular approvedClaims,
// forbiddenClaims, negativeBrief, knownFacts, assumptions, openQuestions and
// legalRestrictions. language/country always come from the project.
export function mergeConstitution(
  base: BrandConstitutionPayload | null,
  patch: ConstitutionPatch,
  locale: ProjectLocale,
  seed: ThinSeed = {},
): { payload: BrandConstitutionPayload; changed: boolean } {
  const start = base ?? thinConstitution(locale, seed);
  const next: BrandConstitutionPayload = {
    ...start,
    language: locale.language,
    country: locale.country,
  };
  if (patch.identity !== undefined) next.identity = patch.identity;
  if (patch.positioning !== undefined) next.positioning = patch.positioning;
  if (patch.toneOfVoice !== undefined) next.toneOfVoice = patch.toneOfVoice;
  if (patch.audiences !== undefined) next.audiences = [...patch.audiences];
  const payload = BrandConstitutionPayloadSchema.parse(next);
  return { payload, changed: base === null || !same(base, payload) };
}

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

// A researched payload landing on top of what is already ACTIVE (Quick
// Discovery finishing after the person's Approve). Fill-empty: a non-empty
// field of the active payload always wins. approvedClaims never come from
// research. The guided-only marker is dropped once research replaces it.
export function fillEmptyConstitution(
  active: BrandConstitutionPayload,
  discovered: BrandConstitutionPayload,
): { payload: BrandConstitutionPayload; changed: boolean } {
  const guided = isGuidedOnly(active);
  const next: Record<string, unknown> = { ...active };
  const keep = new Set([
    "language",
    "country",
    "approvedClaims",
    "logoAssetIds",
  ]);
  for (const key of Object.keys(
    discovered,
  ) as (keyof BrandConstitutionPayload)[]) {
    if (keep.has(key)) continue;
    if (key === "openQuestions" && guided) {
      next[key] = discovered[key];
      continue;
    }
    if (isEmpty(next[key])) next[key] = discovered[key];
  }
  const payload = BrandConstitutionPayloadSchema.parse(next);
  return { payload, changed: !same(active, payload) };
}
