import {
  APPLY_LIMITS,
  AUDIENCE_SEGMENTS,
  BUSINESS_KINDS,
  GUARDRAILS,
  MAIN_QUESTIONS,
  QUESTIONS,
  QUESTION_IDS,
  SEED_MAX,
  SessionRecordSchema,
  TONES,
  TOTAL_MAIN_QUESTIONS,
  goalOptionId,
  isAnswered,
  isResolved,
  type ApplyPart,
  type Answer,
  type Answers,
  type GoalMode,
  type GuidedSetupSummary,
  type IdeaOptions,
  type QuestionId,
  type SessionRecord,
  type SessionStatus,
  type StepId,
} from "@/lib/guided-setup/contract";
import { PLAN_GOALS } from "@/lib/content-channels";
import { cleanUserText } from "@/lib/guided-setup/sanitize";

// The pure rules of the guided-setup session row (spec 6.3, 6.6, 9.4): no IO, no
// clock, no randomness. Every rev, editRev and token is injected, so a test can
// replay any interleaving. store.ts persists what these functions return (it
// stamps a fresh `rev` on every write, so the `rev` passed here only matters to
// callers that do not go through the store).
//
// The record is a z.looseObject: every function spreads the parsed record, so a
// key written by a newer deploy survives a read-modify-write (spec 6.1).

export type AppliedRecord = NonNullable<SessionRecord["applied"]>;

// Stored strings are validated by zod in UTF-16 units, the product caps count
// code points: an all-emoji answer would pass the cap and then fail to parse
// back, stranding the project. These mirror the contract's stored maxima.
const OTHER_UNITS = 200;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Accepts a Command row (`{ parsedIntent }`) or the parsedIntent itself. A row
// that does not parse reads as absent (`start` replaces it, spec 6.1).
export function parseSession(raw: unknown): SessionRecord | null {
  const intent =
    isRecord(raw) && "parsedIntent" in raw ? raw.parsedIntent : raw;
  if (!isRecord(intent)) return null;
  const parsed = SessionRecordSchema.safeParse(intent.guidedSetup);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Flags decided once, when the row is created
// ---------------------------------------------------------------------------

// No website and nothing researched to adopt: "business" comes first, because its
// answer is what a paid run needs.
export function seedFirstFor(input: {
  domain: string | null | undefined;
  hasResearchedProfile: boolean;
}): boolean {
  return !input.hasResearchedProfile && !input.domain?.trim();
}

// A paid run can happen, so the research-fed questions go last. NOT `hasInput`:
// a seedFirst project gets its input from question 1.
export function staticFirstFor(input: {
  gates: { enabled: boolean; mock: boolean; providerOk: boolean };
  hasResearchedProfile: boolean;
}): boolean {
  const { gates } = input;
  return (
    gates.enabled &&
    !gates.mock &&
    gates.providerOk &&
    !input.hasResearchedProfile
  );
}

// The first question in every order (spec 3.4).
const firstStepOf = (seedFirst: boolean): StepId =>
  seedFirst ? "business" : "goal";

// Clip to `max` UTF-16 units without ever leaving half of a surrogate pair.
function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

export function newSession(input: {
  rev: string;
  editRev: string;
  nowMs: number;
  userId: string;
  seedFirst: boolean;
  staticFirst: boolean;
  seedText?: string | null;
}): SessionRecord {
  const seed = input.seedText ? clipUnits(input.seedText, SEED_MAX) : "";
  return {
    v: 1,
    rev: input.rev,
    editRev: input.editRev,
    status: "OPEN",
    step: firstStepOf(input.seedFirst),
    more: false,
    seedFirst: input.seedFirst,
    staticFirst: input.staticFirst,
    answers: {},
    seed: seed ? { text: seed } : null,
    applyingSinceMs: null,
    applyToken: null,
    goalId: null,
    applied: null,
    lastFailure: null,
    createdAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    updatedByUserId: input.userId,
  };
}

// ---------------------------------------------------------------------------
// Answers (spec 6.6)
// ---------------------------------------------------------------------------

export type NormalizeContext = {
  // Option ids of the channel rows the sheet offers (channelOptionId of CHANNEL_KEYS).
  channelIds: readonly string[];
  // The stored, already sanitized AI options: the only source of "o_..." ids.
  ideas: IdeaOptions;
};

const ids = (options: readonly { id: string }[]): string[] =>
  options.map((option) => option.id);

function allowedIds(question: QuestionId, ctx: NormalizeContext): Set<string> {
  switch (question) {
    case "goal":
      return new Set(PLAN_GOALS.map(goalOptionId));
    case "channels":
      return new Set(ctx.channelIds);
    case "business":
      return new Set([...ids(BUSINESS_KINDS), ...ids(ctx.ideas.business)]);
    case "audience":
      return new Set([...ids(AUDIENCE_SEGMENTS), ...ids(ctx.ideas.audience)]);
    case "tone":
      return new Set(ids(TONES));
    case "angle":
      return new Set(ids(ctx.ideas.angle));
    case "guardrails":
      return new Set(ids(GUARDRAILS));
  }
}

function normalizeOne(
  question: QuestionId,
  answer: Answer,
  ctx: NormalizeContext,
): Answer | null {
  const spec = QUESTIONS[question];
  const allowed = allowedIds(question, ctx);

  // Only ids the server knows survive, once each, in tap order. A label or any
  // other client text is never read: labels come from the catalogs and the
  // stored options.
  const picked: string[] = [];
  const rawPicked: unknown = answer.picked;
  if (Array.isArray(rawPicked)) {
    for (const id of rawPicked as unknown[]) {
      if (typeof id !== "string" || !allowed.has(id) || picked.includes(id)) {
        continue;
      }
      picked.push(id);
      if (picked.length >= spec.max) break;
    }
  }

  let other: string | null = null;
  if (spec.other > 0) {
    const cleaned = cleanUserText(answer.other, spec.other);
    other = cleaned ? clipUnits(cleaned, OTHER_UNITS) || null : null;
  }

  if (other) {
    if (spec.mode === "single") {
      // A typed answer wins over a tap (the reducer never sends both).
      picked.length = 0;
    } else {
      // A typed entry counts as one pick: trailing picks go first, then it.
      while (picked.length + 1 > spec.max && picked.length > 0) picked.pop();
      if (picked.length + 1 > spec.max) other = null;
    }
  }

  const empty = picked.length === 0 && !other;
  const normalized: Answer = { picked };
  if (other) normalized.other = other;
  // Skipped and deferred describe an EMPTY question and exclude each other; the
  // final decision (skipped) wins over "skip for now".
  if (empty && answer.skipped === true) normalized.skipped = true;
  else if (empty && spec.ideas && answer.deferred === true) {
    normalized.deferred = true;
  }
  const hasFlag = normalized.skipped === true || normalized.deferred === true;
  return empty && !hasFlag ? null : normalized;
}

// Runs on every save and again inside the saga. Keys are built in QUESTION_IDS
// order so the result is canonical (and compares by its JSON).
export function normalizeAnswers(
  input: Answers,
  ctx: NormalizeContext,
): Answers {
  const out: Answers = {};
  for (const question of QUESTION_IDS) {
    const answer = input[question];
    if (!isRecord(answer)) continue;
    const normalized = normalizeOne(question, answer as Answer, ctx);
    if (normalized) out[question] = normalized;
  }
  return out;
}

// Answers as they compare: only the four known fields, fixed order.
function canonicalAnswers(answers: SessionRecord["answers"]): string {
  const out: Record<string, unknown> = {};
  for (const question of QUESTION_IDS) {
    const answer = answers[question];
    if (!answer) continue;
    out[question] = [
      answer.picked,
      answer.other ?? null,
      answer.skipped === true,
      answer.deferred === true,
    ];
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// An APPLYING claim older than the limit is a crashed (or very slow) apply and
// reads as OPEN: parts are idempotent, so a re-run is safe.
export function effectiveStatus(
  record: SessionRecord,
  nowMs: number,
): SessionStatus {
  if (record.status !== "APPLYING") return record.status;
  const since = record.applyingSinceMs;
  if (since === null) return "OPEN";
  return nowMs - since > APPLY_LIMITS.staleApplyingMs ? "OPEN" : "APPLYING";
}

export function isApplied(record: SessionRecord): boolean {
  return record.applied != null;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

// A save. The whole answer set arrives every time (latest wins). editRev changes
// only when the answers themselves change, so moving between steps never makes
// an Approve in another tab look stale.
export function withAnswers(
  record: SessionRecord,
  input: {
    step: StepId;
    more: boolean;
    answers: Answers;
    nowMs: number;
    userId: string;
    ctx: NormalizeContext;
    rev: string;
    editRev: string;
  },
): { next: SessionRecord } | { error: "BUSY" } {
  if (effectiveStatus(record, input.nowMs) === "APPLYING") {
    return { error: "BUSY" };
  }
  const answers = normalizeAnswers(input.answers, input.ctx);
  const changed =
    canonicalAnswers(answers) !== canonicalAnswers(record.answers);
  return {
    next: {
      ...record,
      rev: input.rev,
      editRev: changed ? input.editRev : record.editRev,
      // DONE becomes OPEN when the answers changed (`applied` stays, so the
      // person can edit); a navigation-only save (same answers) leaves DONE, so
      // "Update your setup" does not turn into "Continue setup". A stale
      // APPLYING is dropped together with its token, so the abandoned run can
      // never finish over these answers.
      status: record.status === "DONE" && !changed ? "DONE" : "OPEN",
      applyingSinceMs: null,
      applyToken: null,
      step: input.step,
      more: input.more,
      answers,
      updatedAtMs: input.nowMs,
      updatedByUserId: input.userId,
    },
  };
}

// ---------------------------------------------------------------------------
// Apply: claim, token, finish (spec 6.3, 9.4)
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { outcome: "CLAIMED"; next: SessionRecord }
  | { outcome: "ALREADY_APPLIED"; applied: AppliedRecord }
  | { outcome: "BUSY" }
  | { outcome: "STALE" };

// Checked in THIS order, so a double click gets BUSY and never STALE: the claim
// itself does not change editRev, but a retry after DONE must be the free no-op.
export function claimApply(
  record: SessionRecord,
  expectedRev: string,
  nowMs: number,
  token: string,
  rev?: string,
): ClaimResult {
  if (
    record.status === "DONE" &&
    record.applied &&
    record.applied.editRev === expectedRev
  ) {
    return { outcome: "ALREADY_APPLIED", applied: record.applied };
  }
  if (effectiveStatus(record, nowMs) === "APPLYING") return { outcome: "BUSY" };
  if (record.editRev !== expectedRev) return { outcome: "STALE" };
  return {
    outcome: "CLAIMED",
    next: {
      ...record,
      ...(rev ? { rev } : {}),
      status: "APPLYING",
      applyingSinceMs: nowMs,
      // Also the takeover of a stale claim: the previous run's token is gone.
      applyToken: token,
    },
  };
}

// Does this run still own the session? False after a takeover, a save during a
// stale claim, or a finish. Every saga part checks it, and so do the two writers
// below.
export function holdsToken(record: SessionRecord, token: string): boolean {
  return (
    token.length > 0 &&
    record.status === "APPLYING" &&
    record.applyToken === token
  );
}

export type FinishInput = { nowMs: number } & (
  | {
      status: "DONE";
      parts: ApplyPart[];
      goalMode: GoalMode | null;
      // null when every part reported UNCHANGED and no receipt ever existed.
      receiptId: string | null;
    }
  // Not applied: failed parts (retry), or nothing to do at all (empty plan).
  | { status: "OPEN"; failed?: ApplyPart[] }
);

export function finishApply(
  record: SessionRecord,
  token: string,
  input: FinishInput,
  rev?: string,
): { next: SessionRecord } | { error: "LOST" } {
  if (!holdsToken(record, token)) return { error: "LOST" };
  const settled = {
    ...record,
    ...(rev ? { rev } : {}),
    applyingSinceMs: null,
    applyToken: null,
    updatedAtMs: input.nowMs,
  };
  if (input.status === "DONE") {
    return {
      next: {
        ...settled,
        status: "DONE",
        // The claim only succeeds for the current editRev and a save during a
        // live claim is refused, so the record's editRev is what was applied.
        applied: {
          atMs: input.nowMs,
          editRev: record.editRev,
          parts: input.parts,
          goalMode: input.goalMode,
          receiptId: input.receiptId,
        },
        lastFailure: null,
      },
    };
  }
  return {
    next: {
      ...settled,
      status: "OPEN",
      lastFailure: input.failed?.length ? { failed: input.failed } : null,
    },
  };
}

// Written the moment the goal exists, before any later part can fail, so a goal
// created by a run that then failed is archived when the answer changes on retry.
export function recordGoalId(
  record: SessionRecord,
  token: string,
  goalId: string,
  rev?: string,
): { next: SessionRecord } | { error: "LOST" } {
  if (!holdsToken(record, token)) return { error: "LOST" };
  return { next: { ...record, ...(rev ? { rev } : {}), goalId } };
}

// ---------------------------------------------------------------------------
// Summary (what the page hands the client)
// ---------------------------------------------------------------------------

export function summaryOf(
  record: SessionRecord | null,
  input: { hasProfile: boolean; discoveryRunExists: boolean },
): GuidedSetupSummary {
  const total = TOTAL_MAIN_QUESTIONS;
  if (!record) {
    return {
      status: "NONE",
      answered: 0,
      total,
      position: 1,
      started: input.discoveryRunExists,
      hasProfile: input.hasProfile,
    };
  }
  const answered = MAIN_QUESTIONS.filter((q) =>
    isAnswered(record.answers[q]),
  ).length;
  const resolved = MAIN_QUESTIONS.filter((q) =>
    isResolved(record.answers[q]),
  ).length;
  const pastFirstStep =
    record.step !== null && record.step !== firstStepOf(record.seedFirst);
  return {
    status: record.status === "DONE" ? "DONE" : "OPEN",
    answered,
    total,
    position: Math.min(Math.max(resolved + 1, 1), total),
    started: pastFirstStep || input.discoveryRunExists,
    hasProfile: input.hasProfile || isApplied(record),
  };
}
