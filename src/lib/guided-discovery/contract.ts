import { z } from "zod";

// Guided discovery contract (pure, isomorphic: no node:*, no prisma, no
// server-only). One Command row per project holds the record below under
// `parsedIntent.guidedDiscovery`; the client only ever sees a DiscoveryView.

export const DISCOVERY_ENV = "GUIDED_SETUP"; // no new flag
export const DISCOVERY_ROW_TOPIC = "GUIDED_DISCOVERY";
export const discoveryRowId = (projectId: string) => `gd_${projectId}`;

export const STAGES = ["site", "identity", "research", "profile"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_STATES = [
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
] as const;
export type StageState = (typeof STAGE_STATES)[number];
export const FIELD_IDS = [
  "about",
  "audience",
  "products",
  "services",
  "markets",
  "voice",
  "positioning",
  "competitors",
  "channels",
] as const;
export type FieldId = (typeof FIELD_IDS)[number];
export const TIERS = ["accepted", "assumed", "unknown"] as const;
export type Tier = (typeof TIERS)[number];
// >= accepted is taken automatically, >= assumed is shown as an assumption.
export const TIER_LIMITS = { accepted: 85, assumed: 60 } as const;
export const STATUSES = ["RUNNING", "READY", "FAILED", "CONFIRMED"] as const;
export type DiscoveryStatus = (typeof STATUSES)[number];
export const FAIL_REASONS = [
  "limit",
  "busy",
  "timeout",
  "error",
  "unavailable",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];
export const DISCOVERY_CAPS = {
  maxAttempts: 3,
  staleRunningMs: 240_000,
  runDeadlineMs: 150_000,
  maxCandidatesPerRow: 8,
  textMax: 140,
  maxRows: 9,
} as const;

export type Candidate = {
  id: string; // "c_" + 10 hex, server-made
  text: string;
  score: number;
  added: boolean;
};
export type Row = {
  field: FieldId;
  tier: Tier; // of the row as a whole
  score: number; // 0-100
  saved: string[]; // what is saved for it now (a text row has 0 or 1 item)
  candidates: Candidate[]; // found but NOT saved yet; tapping adds one
};
export type IdentitySummary = {
  logo: boolean;
  colors: number;
  fonts: number;
  style: boolean;
} | null;
export type DiscoveryRecord = {
  v: 1;
  rev: string; // 12 hex, changes on every write
  status: DiscoveryStatus;
  stages: Record<Stage, StageState>;
  attempts: number; // paid research attempts claimed (<= maxAttempts)
  runId: string | null;
  host: string | null; // the typed website, for display
  identity: IdentitySummary;
  rows: Row[];
  failure: FailReason | null;
  startedAtMs: number;
  updatedAtMs: number;
  confirmedAtMs: number | null;
};

const CANDIDATE_ID = /^c_[0-9a-f]{10}$/;
export const isCandidateId = (value: unknown): value is string =>
  typeof value === "string" && CANDIDATE_ID.test(value);

const CandidateSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  score: z.number(),
  added: z.boolean(),
});
const RowSchema = z.looseObject({
  field: z.enum(FIELD_IDS),
  tier: z.enum(TIERS),
  score: z.number(),
  saved: z.array(z.string()),
  candidates: z.array(CandidateSchema),
});
const IdentitySummarySchema = z
  .looseObject({
    logo: z.boolean(),
    colors: z.number(),
    fonts: z.number(),
    style: z.boolean(),
  })
  .nullable();
const StageStateSchema = z.enum(STAGE_STATES);

// Loose on purpose: a row written by a newer build stays readable after a
// rollback, unknown keys are simply carried along.
export const DiscoveryRecordSchema = z.looseObject({
  v: z.literal(1),
  rev: z.string(),
  status: z.enum(STATUSES),
  stages: z.looseObject({
    site: StageStateSchema,
    identity: StageStateSchema,
    research: StageStateSchema,
    profile: StageStateSchema,
  }),
  attempts: z.number(),
  runId: z.string().nullable(),
  host: z.string().nullable(),
  identity: IdentitySummarySchema,
  rows: z.array(RowSchema),
  failure: z.enum(FAIL_REASONS).nullable(),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
  confirmedAtMs: z.number().nullable(),
});

// Reads `parsedIntent.guidedDiscovery`; anything unparseable reads as absent.
export function parseDiscoveryRecord(raw: unknown): DiscoveryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const source = (raw as { guidedDiscovery?: unknown }).guidedDiscovery;
  const parsed = DiscoveryRecordSchema.safeParse(source);
  return parsed.success ? parsed.data : null;
}

// Route request bodies: strict, ids only, unknown keys refused.
export const DiscoveryRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("add"),
    candidateId: z.string().regex(CANDIDATE_ID),
  }),
  z.strictObject({ action: z.literal("confirm") }),
  z.strictObject({ action: z.literal("retry") }),
]);
export type DiscoveryRequest = z.infer<typeof DiscoveryRequestSchema>;

export type DiscoveryView = {
  rev: string;
  status: DiscoveryStatus;
  stages: Record<Stage, StageState>;
  identity: IdentitySummary;
  rows: Row[];
  host: string | null;
  failure: FailReason | null;
  canRetry: boolean;
  brandName: string;
};

// What the client sees. A RUNNING row older than the stale window reads as
// FAILED/timeout (a crashed job must not spin forever); this is derived, never
// written by a read. The input is not mutated.
export function viewOf(
  record: DiscoveryRecord,
  nowMs: number,
  brandName: string,
): DiscoveryView {
  const stale =
    record.status === "RUNNING" &&
    nowMs - record.updatedAtMs > DISCOVERY_CAPS.staleRunningMs;
  const status: DiscoveryStatus = stale ? "FAILED" : record.status;
  const failure: FailReason | null = stale ? "timeout" : record.failure;
  return {
    rev: record.rev,
    status,
    stages: { ...record.stages },
    identity: record.identity ? { ...record.identity } : null,
    rows: record.rows.map((row) => ({
      field: row.field,
      tier: row.tier,
      score: row.score,
      saved: [...row.saved],
      candidates: row.candidates.map((c) => ({
        id: c.id,
        text: c.text,
        score: c.score,
        added: c.added,
      })),
    })),
    host: record.host,
    failure,
    canRetry: status === "FAILED" && record.attempts < DISCOVERY_CAPS.maxAttempts,
    brandName,
  };
}

export function emptyRecord(input: {
  rev: string;
  nowMs: number;
  host: string | null;
  stages: Record<Stage, StageState>;
}): DiscoveryRecord {
  return {
    v: 1,
    rev: input.rev,
    status: "RUNNING",
    stages: { ...input.stages },
    attempts: 0,
    runId: null,
    host: input.host,
    identity: null,
    rows: [],
    failure: null,
    startedAtMs: input.nowMs,
    updatedAtMs: input.nowMs,
    confirmedAtMs: null,
  };
}
