// Scrub for Quick Discovery output on guided runs (spec 8.5, Appendix B2).
// Pure: no IO, no server-only. Applied by QuickDiscoveryService.run ONLY when the
// target is a guided run (target.guided), after the schema parse and before
// publishVersion. The model output is built from untrusted page text and search
// results and publishVersion promotes it into BrandFact / NegativeBriefRule rows
// and hands the payload to worker prompts, so what survives is what looks like
// plain honest prose. DROP, never repair: a field that fails is emptied, a list
// item that fails is removed.
import {
  BrandConstitutionPayloadSchema,
  type BrandConstitutionPayload,
} from "@/server/agency/constitution/constitution-schema";
import { GUIDED_ONLY_OPEN_QUESTION } from "@/lib/guided-setup/contract";
import {
  flatten,
  foldLabel,
  hostileShape,
  looksInstructionShaped,
} from "@/lib/guided-setup/sanitize";

export const SCRUB_LIMITS = {
  stringMax: 600, // a longer string field is emptied
  itemMax: 240, // a longer list item is dropped
  listMax: 8, // items kept per list
  longListMax: 12, // products, markets, competitors
  sourceMax: 200, // the URL inside "[source: ...]"
} as const;

export const SCRUB_STRING_FIELDS = [
  "identity",
  "businessModel",
  "positioning",
  "valueProposition",
  "personality",
  "toneOfVoice",
  "visualIdentity",
] as const satisfies readonly (keyof BrandConstitutionPayload)[];

export const SCRUB_LIST_FIELDS = [
  "products",
  "markets",
  "audiences",
  "forbiddenClaims",
  "negativeBrief",
  "customerProblems",
  "customerObjections",
  "competitors",
  "differentiators",
  "legalRestrictions",
  "knownFacts",
  "assumptions",
  "openQuestions",
] as const satisfies readonly (keyof BrandConstitutionPayload)[];

const LONG_LISTS: ReadonlySet<string> = new Set([
  "products",
  "markets",
  "competitors",
]);

// The marker of a thin guided-only profile (constitution-merge.ts isGuidedOnly).
// Only the sheet may write it: a page-steered model must not be able to turn a
// researched profile back into a "guided-only" one.
const GUIDED_ONLY_FOLDED = foldLabel(GUIDED_ONLY_OPEN_QUESTION);

const overLimit = (text: string, max: number) =>
  text.length > max && Array.from(text).length > max;

// The prompt asks the model to end every knownFacts entry with
// " [source: <url>]". That ONE trailing marker is kept, and only when the URL is
// plain http(s), has no credentials, is short, and its path does not read as an
// instruction once the separators are turned into spaces.
const SOURCE_SUFFIX = /^(.*\S)\s\[source:\s*([^\s\]]+)\]$/u;

function safeSourceUrl(raw: string): boolean {
  if (raw.length > SCRUB_LIMITS.sourceMax) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  let readable: string;
  try {
    readable = decodeURIComponent(`${url.pathname} ${url.search}`);
  } catch {
    return false;
  }
  return !looksInstructionShaped(readable.replace(/[-_/+.=&]+/gu, " "));
}

function cleanItem(raw: string, isFact: boolean): string | null {
  const text = flatten(raw);
  if (text === "" || overLimit(text, SCRUB_LIMITS.itemMax)) return null;
  if (isFact) {
    const match = SOURCE_SUFFIX.exec(text);
    if (match) {
      const [, fact, source] = match;
      if (!fact || !source || !safeSourceUrl(source)) return null;
      if (hostileShape(fact) !== null) return null;
      return `${fact} [source: ${source}]`;
    }
  }
  return hostileShape(text) === null ? text : null;
}

export function scrubDiscoveredPayload(payload: BrandConstitutionPayload): {
  payload: BrandConstitutionPayload;
  dropped: number;
} {
  let dropped = 0;
  const next: Record<string, unknown> = { ...payload };

  for (const field of SCRUB_STRING_FIELDS) {
    const text = flatten(payload[field]);
    if (
      text === "" ||
      overLimit(text, SCRUB_LIMITS.stringMax) ||
      hostileShape(text) !== null
    ) {
      if (payload[field].trim() !== "") dropped += 1;
      next[field] = "";
    } else {
      next[field] = text;
    }
  }

  for (const field of SCRUB_LIST_FIELDS) {
    const cleaned: string[] = [];
    for (const raw of payload[field]) {
      const item = cleanItem(raw, field === "knownFacts");
      if (
        item === null ||
        (field === "openQuestions" && foldLabel(item) === GUIDED_ONLY_FOLDED)
      )
        dropped += 1;
      else cleaned.push(item);
    }
    const max = LONG_LISTS.has(field)
      ? SCRUB_LIMITS.longListMax
      : SCRUB_LIMITS.listMax;
    dropped += Math.max(0, cleaned.length - max);
    next[field] = cleaned.slice(0, max);
  }

  // A claim is the client's to approve; nothing read from a page becomes one.
  if (payload.approvedClaims.length > 0)
    dropped += payload.approvedClaims.length;
  next.approvedClaims = [];

  return { payload: BrandConstitutionPayloadSchema.parse(next), dropped };
}
