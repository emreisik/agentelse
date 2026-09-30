// Guided setup: the ideas record (spec 6.2, 6.3, 8.2, 8.10).
// Pure: no IO, no clock, no random. Every state change is a function that takes
// the record it read and returns the next one in the shape the store's
// `modifyIdeas` wants, so the service stays a thin caller and every rule here
// is testable without a database. Nothing mock is ever a source or displayed.
import { createHash } from "node:crypto";

import {
  CURRENT_MAX,
  DISCOVERY_LIMITS,
  IdeasRecordSchema,
  MAX_AI_OPTIONS,
  MAX_DISCOVERY_ATTEMPTS,
  type AiTextKind,
  type CurrentValues,
  type IdeaOptions,
  type IdeasReason,
  type IdeasRecord,
  type IdeasView,
  type Option,
} from "@/lib/guided-setup/contract";
import {
  cleanDisplayText,
  cleanOptionText,
  firstSentence,
  foldLabel,
} from "@/lib/guided-setup/sanitize";
import {
  BrandConstitutionPayloadSchema,
  type BrandConstitutionPayload,
} from "@/server/agency/constitution/constitution-schema";
import { isGuidedOnly } from "@/server/brand/constitution-merge";
import type { Change } from "@/server/guided-setup/store";

type IdeaQuestion = keyof Pick<IdeaOptions, "business" | "audience" | "angle">;
// Fresh arrays every time: the contract's constant must never be mutated through a view.
const emptyOptions = (): IdeaOptions => ({
  business: [],
  audience: [],
  angle: [],
});

const IDEA_QUESTIONS: readonly IdeaQuestion[] = [
  "business",
  "audience",
  "angle",
];

// -----------------------------------------------------------------------------
// Option ids and the option builder
// -----------------------------------------------------------------------------

// "o_" + 10 hex of sha256(kind NUL foldLabel(label)): the same text on the
// same question always gets the same id, so a regeneration never invalidates
// an id a person already picked.
export function optionIdFor(kind: AiTextKind, label: string): string {
  const digest = createHash("sha256")
    .update(`${kind}\u0000${foldLabel(label)}`)
    .digest("hex");
  return `o_${digest.slice(0, 10)}`;
}

export type BuiltIdeas = {
  options: IdeaOptions;
  stats: { kept: number; dropped: number };
};

// Candidate texts of one question, in priority order. A group is used only when
// it yields at least one accepted option, otherwise the next group is tried
// (angle: differentiators, then the value proposition).
type CandidateGroup = readonly string[];

function build(
  kind: AiTextKind,
  groups: readonly CandidateGroup[],
  counters: { dropped: number },
): Option[] {
  const max = MAX_AI_OPTIONS[kind];
  for (const group of groups) {
    const kept: Option[] = [];
    const seenLabels = new Set<string>();
    const seenIds = new Set<string>();
    for (const candidate of group) {
      if (kept.length >= max) break;
      const cleaned = cleanOptionText(candidate, kind);
      if (!cleaned.ok) {
        counters.dropped += 1;
        continue;
      }
      const folded = foldLabel(cleaned.text);
      const id = optionIdFor(kind, cleaned.text);
      // A punctuation-only label folds to "" and would share one id.
      // 40-bit ids can collide: the later option is dropped, never re-keyed.
      if (!folded || seenLabels.has(folded) || seenIds.has(id)) {
        counters.dropped += 1;
        continue;
      }
      seenLabels.add(folded);
      seenIds.add(id);
      kept.push({ id, label: cleaned.text, ai: true });
    }
    if (kept.length > 0) return kept;
  }
  return [];
}

const strings = (list: readonly string[] | null | undefined): string[] =>
  (list ?? []).filter((item): item is string => typeof item === "string");

// The options a researched constitution offers. A guided-only payload holds the
// person's own words, so it offers nothing (it only feeds currentValuesOf).
export function buildIdeaOptions(
  payload: BrandConstitutionPayload,
): BuiltIdeas {
  if (isGuidedOnly(payload)) {
    return {
      options: emptyOptions(),
      stats: { kept: 0, dropped: 0 },
    };
  }
  const counters = { dropped: 0 };
  // Identity and value-proposition candidates are cut at a sentence boundary
  // (never mid-word); a sentence that is still over its cap is rejected.
  const business = build(
    "identity",
    [
      [firstSentence(payload.identity ?? "")].filter(Boolean),
      [firstSentence(payload.businessModel ?? "")].filter(Boolean),
    ],
    counters,
  );
  const audience = build("audience", [strings(payload.audiences)], counters);
  const angle = build(
    "angle",
    [
      strings(payload.differentiators),
      [firstSentence(payload.valueProposition ?? "")].filter(Boolean),
    ],
    counters,
  );
  return {
    options: { business, audience, angle },
    stats: {
      kept: business.length + audience.length + angle.length,
      dropped: counters.dropped,
    },
  };
}

// -----------------------------------------------------------------------------
// "Current" lines (display only, never stored, never selectable)
// -----------------------------------------------------------------------------

export function currentValuesOf(
  active: { isMock: boolean; payload: unknown } | null,
  goalTitle: string | null,
): CurrentValues {
  const current: CurrentValues = {};
  // A MOCK row (seed and test runs fill the shared dev database with them)
  // contributes nothing at all: not a source, not a "Current" line.
  if (active && !active.isMock) {
    const parsed = BrandConstitutionPayloadSchema.safeParse(active.payload);
    if (parsed.success) {
      const payload = parsed.data;
      const identity = cleanDisplayText(payload.identity, CURRENT_MAX);
      if (identity) current.identity = identity;
      const audiences = strings(payload.audiences)
        .slice(0, MAX_AI_OPTIONS.audience)
        .map((text) => cleanDisplayText(text, CURRENT_MAX))
        .filter((text): text is string => text !== null);
      if (audiences.length > 0) current.audiences = audiences;
      const tone = cleanDisplayText(payload.toneOfVoice, CURRENT_MAX);
      if (tone) current.tone = tone;
    }
  }
  // The goal is the project's own row, independent of the constitution.
  const goal = goalTitle ? cleanDisplayText(goalTitle, CURRENT_MAX) : null;
  if (goal) current.goal = goal;
  return current;
}

// -----------------------------------------------------------------------------
// The record: parse, claim, finish, adopt
// -----------------------------------------------------------------------------

// Loose parse (an unknown key written by a newer deploy survives). Accepts the
// `guidedIdeas` value or the whole parsedIntent it lives in; anything that does
// not parse reads as absent.
export function parseIdeas(raw: unknown): IdeasRecord | null {
  const inner =
    typeof raw === "object" && raw !== null && "guidedIdeas" in raw
      ? (raw as { guidedIdeas: unknown }).guidedIdeas
      : raw;
  const parsed = IdeasRecordSchema.safeParse(inner);
  return parsed.success ? parsed.data : null;
}

const startedOf = (record: IdeasRecord): number =>
  record.startedAtMs ?? record.updatedAtMs;

// RUNNING for longer than the limit is a crashed or abandoned run. It is only
// ever DERIVED as FAILED(timeout) on read; nothing rewrites it.
const isStaleRunning = (record: IdeasRecord, nowMs: number): boolean =>
  record.status === "RUNNING" &&
  nowMs - startedOf(record) > DISCOVERY_LIMITS.staleRunningMs;

// "inactive" (paused or closed project) is never retried by tap.
const isRetryable = (record: IdeasRecord): boolean =>
  record.attempts < MAX_DISCOVERY_ATTEMPTS && record.reason !== "inactive";

export function newRunning(input: {
  rev: string;
  runId: string;
  nowMs: number;
  attempts: number;
  host?: string;
  // The record being replaced (a retry): keeps the keys this deploy does not know.
  base?: IdeasRecord;
}): IdeasRecord {
  const { base, host } = input;
  const next: IdeasRecord = {
    ...base,
    v: 1,
    rev: input.rev,
    status: "RUNNING",
    source: "discovery",
    runId: input.runId,
    attempts: input.attempts,
    startedAtMs: input.nowMs,
    options: emptyOptions(),
    stats: { kept: 0, dropped: 0 },
    updatedAtMs: input.nowMs,
  };
  delete next.reason;
  delete next.finishedAtMs;
  delete next.pages;
  delete next.version;
  if (host !== undefined) next.host = host;
  else delete next.host;
  return next;
}

export type ClaimDecision =
  // Take the claim: `attempts` is the value to store on the RUNNING row.
  | { kind: "claim"; attempts: number }
  | { kind: "ready" }
  | { kind: "running" }
  // Three paid runs already claimed for this project, ever.
  | { kind: "exhausted" }
  // FAILED because the project was paused or closed: not retried by tap.
  | { kind: "inactive" };

// What an explicit discover tap may do with the record it just read.
export function claimable(
  record: IdeasRecord | null,
  nowMs: number,
): ClaimDecision {
  if (record === null) return { kind: "claim", attempts: 1 };
  if (record.status === "READY") return { kind: "ready" };
  if (record.status === "RUNNING" && !isStaleRunning(record, nowMs)) {
    return { kind: "running" };
  }
  if (record.attempts >= MAX_DISCOVERY_ATTEMPTS) return { kind: "exhausted" };
  if (record.reason === "inactive") return { kind: "inactive" };
  return { kind: "claim", attempts: record.attempts + 1 };
}

// Options are write-once per question: only an EMPTY list is filled, so an id
// that was ever shown stays valid and no list changes under a person.
function fillEmpty(current: IdeaOptions, incoming: IdeaOptions): IdeaOptions {
  const merged: IdeaOptions = { ...current };
  for (const question of IDEA_QUESTIONS) {
    if (current[question].length === 0) merged[question] = incoming[question];
  }
  return merged;
}

const sameOptions = (a: IdeaOptions, b: IdeaOptions): boolean =>
  IDEA_QUESTIONS.every(
    (question) =>
      a[question].length === b[question].length &&
      a[question].every((option, i) => option.id === b[question][i]?.id),
  );

// The runner's final write. Ignored (an error, nothing changes) unless the row
// is still the RUNNING claim of THIS runId: an older runner cannot overwrite a
// newer attempt or an adopted profile.
export function finishReady(
  record: IdeasRecord,
  runId: string,
  input: BuiltIdeas & {
    nowMs: number;
    pages?: number;
    version?: number;
    host?: string;
  },
): Change<IdeasRecord, { options: IdeaOptions }> {
  if (record.status !== "RUNNING" || record.runId !== runId) {
    return { error: "stale" };
  }
  const options = fillEmpty(record.options, input.options);
  const next: IdeasRecord = {
    ...record,
    status: "READY",
    source: "discovery",
    options,
    stats: input.stats,
    finishedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
  delete next.reason;
  if (input.pages !== undefined) next.pages = input.pages;
  if (input.version !== undefined) next.version = input.version;
  if (input.host !== undefined) next.host = input.host;
  return { next, value: { options } };
}

// `refund`: the claim never cost a paid call (busy, inactive, schedule failed),
// so the attempt is given back.
export function finishFailed(
  record: IdeasRecord,
  runId: string,
  reason: IdeasReason,
  opts: { nowMs: number; refund?: boolean },
): Change<IdeasRecord, { attempts: number }> {
  if (record.status !== "RUNNING" || record.runId !== runId) {
    return { error: "stale" };
  }
  const attempts = opts.refund
    ? Math.max(0, record.attempts - 1)
    : record.attempts;
  const next: IdeasRecord = {
    ...record,
    status: "FAILED",
    reason,
    attempts,
    finishedAtMs: opts.nowMs,
    updatedAtMs: opts.nowMs,
  };
  return { next, value: { attempts } };
}

// Free adoption of an existing researched profile: no paid call, attempts are
// left alone. From nothing, FAILED or a stale RUNNING it makes a READY row with
// source "profile"; an already READY row only gets its empty questions filled.
// A fresh RUNNING claim is left to its runner.
export function adoptProfile(
  record: IdeasRecord | null,
  input: BuiltIdeas & {
    version?: number;
    nowMs: number;
    rev: string;
  },
): Change<IdeasRecord, { created: boolean }> {
  if (input.stats.kept < 1) return { error: "no_options" };
  if (record === null) {
    const next: IdeasRecord = {
      v: 1,
      rev: input.rev,
      status: "READY",
      source: "profile",
      attempts: 0,
      options: input.options,
      stats: input.stats,
      finishedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    if (input.version !== undefined) next.version = input.version;
    return { next, value: { created: true } };
  }
  if (record.status === "READY") {
    const options = fillEmpty(record.options, input.options);
    if (sameOptions(options, record.options)) return { error: "unchanged" };
    return {
      next: { ...record, options, updatedAtMs: input.nowMs },
      value: { created: false },
    };
  }
  if (record.status === "RUNNING" && !isStaleRunning(record, input.nowMs)) {
    return { error: "running" };
  }
  const next: IdeasRecord = {
    ...record,
    status: "READY",
    source: "profile",
    options: fillEmpty(record.options, input.options),
    stats: input.stats,
    finishedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
  };
  delete next.reason;
  delete next.runId;
  if (input.version !== undefined) next.version = input.version;
  return { next, value: { created: false } };
}

// -----------------------------------------------------------------------------
// The view (spec 8.10): the single derivation of what the person sees
// -----------------------------------------------------------------------------

export type IdeasGates = {
  enabled: boolean;
  mock: boolean;
  providerOk: boolean;
};

export function viewOfIdeas(input: {
  record: IdeasRecord | null;
  nowMs: number;
  gates: IdeasGates;
  hasResearchedProfile: boolean;
  hasInput: boolean;
  host?: string | null;
}): IdeasView {
  const { record, nowMs, gates } = input;
  const attempts = record?.attempts ?? 0;
  const host = input.host ?? record?.host ?? undefined;
  const none = (
    status: IdeasView["status"],
    extra: Partial<IdeasView> = {},
  ): IdeasView => ({
    status,
    source: "none",
    attempts,
    canStart: false,
    canRetry: false,
    options: emptyOptions(),
    ...extra,
  });

  // 1. A finished record always wins.
  if (record?.status === "READY") {
    const view: IdeasView = {
      status: "READY",
      source: record.source,
      attempts,
      canStart: false,
      canRetry: false,
      options: record.options,
    };
    // Only a run the server itself performed names a site.
    if (record.source === "discovery") {
      const site = record.host ?? input.host ?? undefined;
      if (site !== undefined) view.host = site;
      if (record.pages !== undefined) view.pages = record.pages;
    }
    return view;
  }
  // 2. Nothing to fetch: a researched profile exists but produced no options.
  if (input.hasResearchedProfile) return none("IDLE");
  // 3 and 4. The gates.
  if (!gates.enabled) return none("UNAVAILABLE", { reason: "off" });
  if (gates.mock) return none("UNAVAILABLE", { reason: "mock" });
  if (!gates.providerOk) return none("UNAVAILABLE", { reason: "provider" });
  // 5 and 6. A run in flight, or one that was abandoned.
  if (record?.status === "RUNNING") {
    if (!isStaleRunning(record, nowMs)) {
      const running = none("RUNNING", {
        ageSec: Math.max(0, Math.floor((nowMs - startedOf(record)) / 1000)),
      });
      if (host !== undefined) running.host = host;
      return running;
    }
    return none("FAILED", {
      reason: "timeout",
      canRetry: record.attempts < MAX_DISCOVERY_ATTEMPTS,
    });
  }
  // 7. A recorded failure.
  if (record?.status === "FAILED") {
    return none("FAILED", {
      reason: record.reason ?? "failed",
      canRetry: isRetryable(record),
    });
  }
  // 8 and 9. No record.
  if (!input.hasInput) return none("UNAVAILABLE", { reason: "no_input" });
  return none("IDLE", { canStart: true });
}
