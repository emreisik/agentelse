// =============================================================================
// Guided setup: the shared contract (Increment A, revision 2).
//
// Lands in the repo as src/lib/guided-setup/contract.ts. Isomorphic on purpose:
// no "server-only", no React, no Node built-ins, no Prisma. Both the Route
// Handler / Server Action side and the client sheet import THIS file, so an id,
// a limit or a request shape can never mean two things.
//
// What lives here: identifiers, closed vocabularies (every static option a
// person can tap), text limits, the two stored row shapes, the API shapes, the
// apply plan shape, the chat card shape, limits, audit names and the two tiny
// pure parsers for the operator environment variables.
// What does NOT live here: the sanitizer (src/lib/guided-setup/sanitize.ts),
// step ordering (steps.ts), the plan builder (plan.ts), anything with IO.
//
// zod is v4 (4.4.3): z.record(z.enum(...)) is EXHAUSTIVE there, so partial maps
// use z.partialRecord. Nothing here reaches z.toJSONSchema (no ReasoningDef in
// Increment A); if Increment B adds pass schemas, a .transform() must end in
// .pipe() (see src/server/reasoning/prompts/constitution-synthesis.ts).
//
// Strict vs loose: REQUEST schemas are strict (an unknown key is a 400). The two
// STORED row schemas are loose (z.looseObject): a row written by a newer deploy
// keeps its unknown keys through a read-modify-write and still parses on an older
// instance after a rollback. A row that cannot be parsed at all is REPLACED by
// `start` (spec 6.1), so evolution can never strand a project.
// =============================================================================

import { z } from "zod";

import {
  CHANNEL_KEYS,
  PLAN_GOALS,
  type ChannelKey,
  type PlanGoal,
} from "@/lib/content-channels";

// -----------------------------------------------------------------------------
// 1. Identifiers, flags, URL contract
// -----------------------------------------------------------------------------

// Server-only env flags (parsed in src/lib/env.ts: GUIDED_SETUP is the literal
// string "true" or off; GUIDED_SETUP_DISCOVERY is kept as a raw string because it
// may also list workspace ids, see parseDiscoveryScope; never NEXT_PUBLIC_).
export const GUIDED_SETUP_ENV = "GUIDED_SETUP" as const; // master: every surface
export const GUIDED_SETUP_DISCOVERY_ENV = "GUIDED_SETUP_DISCOVERY" as const; // the paid "Get ideas" run
export const GUIDED_SETUP_DISCOVERY_CAPS_ENV =
  "GUIDED_SETUP_DISCOVERY_CAPS" as const; // "user,workspace,global" per 24 h, can only LOWER the defaults

// ?guide=setup is an ENTRY signal only. It opens the sheet once and is stripped
// with history.replaceState. Any other value is ignored. Never combined with
// ?panel= / ?entity= (those swap the chat out, page.tsx).
export const GUIDE_PARAM = "guide" as const;
export const GUIDE_VALUE = "setup" as const;

// Free-string Command.topic values (Command.topic is a free string on purpose,
// prisma/schema.prisma Command). Every chat feed filters topic: null, so these
// rows never render as messages.
export const SESSION_TOPIC = "GUIDED_SETUP" as const;
export const IDEAS_TOPIC = "GUIDED_SETUP_IDEAS" as const;

// One row of each per project, ids derived on the server from the projectId
// (never supplied by a client). Create = primary-key insert, P2002 = "exists".
export const sessionRowId = (projectId: string) => `gs_${projectId}`;
export const ideasRowId = (projectId: string) => `gi_${projectId}`;

// Marker inside a thin, guided-only constitution payload. QuickDiscovery uses
// it to tell "the sheet wrote this from a few taps" from a researched profile
// (its claim gate and its late-landing merge, spec section 8.5).
export const GUIDED_ONLY_OPEN_QUESTION =
  "Business model, products and value proposition have not been confirmed yet." as const;

// Audit trail: action names. Metadata carries counts, ids of steps and reason
// codes ONLY, never free text and never URLs. The discovery rows (started,
// refused, finished) are WORKSPACE-LEVEL: they carry no projectId and no
// brandId, because project deletion removes every row that has a projectId
// column and the durable caps count these rows (spec 8.3).
export const AUDIT = {
  discoveryStarted: "guided_setup.discovery.started",
  discoveryRefused: "guided_setup.discovery.refused",
  discoveryFinished: "guided_setup.discovery.finished",
  applied: "guided_setup.applied",
  applyFailed: "guided_setup.apply_failed",
  firstPlanRequested: "guided_setup.first_plan_requested",
  // A stored row that could not be parsed was replaced by `start`.
  sessionReset: "guided_setup.session_reset",
} as const;
export type AuditAction = (typeof AUDIT)[keyof typeof AUDIT];

// -----------------------------------------------------------------------------
// 2. Questions and steps
// -----------------------------------------------------------------------------

export const QUESTION_IDS = [
  "goal",
  "channels",
  "business",
  "audience",
  "tone",
  "angle",
  "guardrails",
] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

// The default path: five questions. This is the DEFAULT order (a project with a
// website or a profile, or with nothing to research). steps.ts derives the other
// two orders from two flags stored ONCE on the session row:
//   seedFirst   (no website, no researched profile): "business" moves to the front,
//               because its answer is what a paid run needs;
//   staticFirst (a paid run can happen): the research-fed questions ("business",
//               "audience") move to the END, so the run has the whole flow to land.
// The step order never changes under a person who already answered.
export const MAIN_QUESTIONS = [
  "goal",
  "channels",
  "business",
  "audience",
  "tone",
] as const satisfies readonly QuestionId[];
export const TOTAL_MAIN_QUESTIONS = MAIN_QUESTIONS.length; // "Question n of 5"

// Only after the person taps "Add more detail" at the checkpoint.
export const DETAIL_QUESTIONS = [
  "angle",
  "guardrails",
] as const satisfies readonly QuestionId[];

export const STEP_IDS = [...QUESTION_IDS, "checkpoint", "review"] as const;
export type StepId = (typeof STEP_IDS)[number];

export type QuestionSpec = {
  id: QuestionId;
  group: "main" | "detail";
  mode: "single" | "multi";
  // Most picks allowed. A typed "Something else" counts as one pick.
  max: number;
  // Max characters of the typed "Something else" text; 0 = no such row.
  other: number;
  // The footer Skip button reads "Not sure, you decide" instead of "Skip", and
  // Review shows "You decide" for the skipped question. Both persist nothing:
  // there is no separate row and no separate stored flag.
  delegate: boolean;
  // Whether options can come from the ideas record (profile or discovery) on
  // top of the static catalog. "angle" has no static catalog: with no ideas the
  // step is simply absent from the flow.
  ideas: boolean;
};

export const QUESTIONS: Record<QuestionId, QuestionSpec> = {
  goal: {
    id: "goal",
    group: "main",
    mode: "single",
    max: 1,
    other: 0,
    delegate: false,
    ideas: false,
  },
  channels: {
    id: "channels",
    group: "main",
    mode: "multi",
    max: 3,
    other: 0,
    delegate: false,
    ideas: false,
  },
  business: {
    id: "business",
    group: "main",
    mode: "single",
    max: 1,
    other: 140,
    delegate: false,
    ideas: true,
  },
  audience: {
    id: "audience",
    group: "main",
    mode: "multi",
    max: 2,
    other: 80,
    delegate: true,
    ideas: true,
  },
  tone: {
    id: "tone",
    group: "main",
    mode: "single",
    max: 1,
    other: 100,
    delegate: true,
    ideas: false,
  },
  angle: {
    id: "angle",
    group: "detail",
    mode: "single",
    max: 1,
    other: 100,
    delegate: true,
    ideas: true,
  },
  guardrails: {
    id: "guardrails",
    group: "detail",
    mode: "multi",
    max: 4,
    other: 100,
    delegate: false,
    ideas: false,
  },
};

// -----------------------------------------------------------------------------
// 3. Closed vocabularies: every static option. Labels are English chrome.
//    The string on the row is the string that is shown in Review and, where a
//    sink stores text, the string that is stored (no hidden value field).
// -----------------------------------------------------------------------------

export type StaticOption = { id: string; label: string; hint?: string };

// No screen shows more than this many option rows (a tier switch, not a longer list).
export const MAX_VISIBLE_ROWS = 6;

// Two tiers of six behind a "More types" row: the first screen stays short, and a
// hotel, a builder, a workshop, an NGO or a creator never has to type.
export const BUSINESS_KINDS_PRIMARY: readonly StaticOption[] = [
  { id: "kind.food", label: "Restaurant, cafe or bar" },
  { id: "kind.shop", label: "Shop or online store" },
  { id: "kind.beauty", label: "Beauty, health or wellness" },
  { id: "kind.local", label: "Local service or trade" },
  { id: "kind.software", label: "Software, app or online service" },
  { id: "kind.professional", label: "Agency, consulting or education" },
];
export const BUSINESS_KINDS_MORE: readonly StaticOption[] = [
  { id: "kind.hospitality", label: "Hotel, travel or events" },
  { id: "kind.property", label: "Real estate or construction" },
  { id: "kind.auto", label: "Cars, transport or logistics" },
  { id: "kind.industry", label: "Manufacturing or wholesale" },
  { id: "kind.community", label: "Non-profit, community or public service" },
  { id: "kind.creator", label: "Creator, media or entertainment" },
];
// Every kind an answer may reference (id lookup); the UI shows one tier at a time.
export const BUSINESS_KINDS: readonly StaticOption[] = [
  ...BUSINESS_KINDS_PRIMARY,
  ...BUSINESS_KINDS_MORE,
];

export const AUDIENCE_SEGMENTS: readonly StaticOption[] = [
  { id: "audience.local", label: "People who live nearby" },
  { id: "audience.online", label: "Online shoppers" },
  { id: "audience.young", label: "Young adults" },
  { id: "audience.families", label: "Families and parents" },
  { id: "audience.business", label: "Business owners and professionals" },
  { id: "audience.visitors", label: "Tourists and visitors" },
];

export const TONES: readonly StaticOption[] = [
  {
    id: "tone.friendly",
    label: "Friendly and warm",
    hint: "Like a helpful neighbour",
  },
  {
    id: "tone.professional",
    label: "Professional and clear",
    hint: "Calm, precise, trustworthy",
  },
  {
    id: "tone.playful",
    label: "Playful and bold",
    hint: "Witty, energetic, a little cheeky",
  },
  {
    id: "tone.premium",
    label: "Premium and refined",
    hint: "Understated, elegant, confident",
  },
];

// The label IS the rule text that is stored (NegativeBriefRule.rule and the
// memory line), so what the person taps is what the workers obey.
export const GUARDRAILS: readonly StaticOption[] = [
  { id: "guardrail.no_prices", label: "Never state prices or discounts" },
  {
    id: "guardrail.no_competitors",
    label: "Never mention competitors by name",
  },
  { id: "guardrail.no_health", label: "Never make health or medical claims" },
  { id: "guardrail.no_guarantees", label: "Never promise guaranteed results" },
  { id: "guardrail.no_politics", label: "Never touch politics or religion" },
  { id: "guardrail.no_slang", label: "Never use slang, swearing or emoji" },
];

// One preset per plan goal. Title and metricKey are code, never AI text.
// metricKey vocabulary: src/server/reasoning/prompts/goal-generation.ts.
export const GOAL_PRESETS: Record<
  PlanGoal,
  { title: string; metricKey: string }
> = {
  awareness: { title: "Grow brand awareness", metricKey: "brand_awareness" },
  leads: { title: "Generate leads and bookings", metricKey: "registrations" },
  sales: { title: "Increase sales", metricKey: "conversion_rate" },
  engagement: { title: "Grow engagement", metricKey: "social_engagement" },
  traffic: { title: "Drive website traffic", metricKey: "organic_traffic" },
};

// Second line of a channel row (static; the live "Connected as ..." status is
// added by the server from getChannelConnections and travels as Option.hint).
export const CHANNEL_HINTS: Record<ChannelKey, string> = {
  instagram: "Photos, Reels and Stories",
  facebook: "Posts on your Facebook Page",
  tiktok: "Short videos",
  linkedin: "Posts for professionals",
  x: "Short posts and threads",
  seo: "Blog articles you publish yourself",
  ads: "Campaign briefs that always need your approval",
};

// How hands-on the agency is for this project (AutonomyPolicy.autopilotMode).
// Closed vocabulary, mirrors the wording of the Autopilot setting (Settings >
// Autonomy); shown read-only on Review so the person knows what a saved goal can lead to.
export const HANDS_ON_MODES = [
  "REVIEW_EVERYTHING",
  "CREATE_AUTOMATICALLY",
  "AUTOPILOT",
] as const;
export type HandsOn = (typeof HANDS_ON_MODES)[number];
export const HANDS_ON_LABEL: Record<HandsOn, { name: string; note: string }> = {
  REVIEW_EVERYTHING: {
    name: "Review everything",
    note: "you approve everything, nothing is planned automatically",
  },
  CREATE_AUTOMATICALLY: {
    name: "Plan together",
    note: "we plan together, you approve",
  },
  AUTOPILOT: {
    name: "Autopilot",
    note: "creates, plans and publishes automatically within your limits",
  },
};

export const goalOptionId = (goal: PlanGoal) => `goal.${goal}`;
export const channelOptionId = (channel: ChannelKey) => `channel.${channel}`;
export const goalFromOptionId = (id: string): PlanGoal | null =>
  PLAN_GOALS.find((goal) => goalOptionId(goal) === id) ?? null;
export const channelFromOptionId = (id: string): ChannelKey | null =>
  CHANNEL_KEYS.find((channel) => channelOptionId(channel) === id) ?? null;

// Server-made ids for AI-derived options: "o_" + first 10 hex of
// sha256(kind + NUL + foldLabel(label)). The client never invents one. 40 bits
// can collide: buildIdeaOptions drops an option whose id repeats an earlier one.
export const AI_OPTION_ID = /^o_[0-9a-f]{10}$/;
export const isAiOptionId = (id: string) => AI_OPTION_ID.test(id);

// -----------------------------------------------------------------------------
// 4. Text limits
// -----------------------------------------------------------------------------

// AI-derived option text: over the cap = REJECTED, never truncated (a cut
// sentence would put half a claim on screen). Audience labels are exempt from
// the two-digit rule because they carry ages ("25 to 40"). Caps count code points.
export const AI_TEXT_CAPS = {
  identity: 160,
  audience: 80,
  angle: 100,
} as const;
export type AiTextKind = keyof typeof AI_TEXT_CAPS;

// How many AI suggestions a question may show (plus Something else). The confirm
// card for "business" shows exactly one.
export const MAX_AI_OPTIONS: Record<AiTextKind, number> = {
  identity: 1,
  audience: 4,
  angle: 3,
};

// The client's own words that opened the sheet (chat message), cleaned and clipped.
export const SEED_MAX = 500;
// Display-only "Current: ..." lines (word-boundary clip, never stored).
export const CURRENT_MAX = 120;

// -----------------------------------------------------------------------------
// 5. Options and answers
// -----------------------------------------------------------------------------

// Stored inside the ideas row only (never sent by a client), so loose.
export const OptionSchema = z.looseObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  hint: z.string().max(140).optional(),
  // AI-derived text: rendered inside lang={project language} dir="auto" with a
  // neutral "Suggested" tag. Nothing here proves it was verified.
  ai: z.literal(true).optional(),
  // channels only: the live connection state at read time.
  connected: z.boolean().optional(),
});
export type Option = z.infer<typeof OptionSchema>;

const answerShape = {
  // Option ids, in the order tapped. Static ids or server-made "o_..." ids.
  picked: z.array(z.string().min(1).max(64)).max(6),
  // The typed "Something else" text (cleaned server-side, capped per question).
  other: z.string().max(200).optional(),
  // Explicit Skip: persists nothing. Review says "Skipped", or "You decide" on a
  // question whose spec has delegate (the footer button carried that label).
  skipped: z.literal(true).optional(),
  // "Skip for now" while the ideas were still loading: offered once more
  // before Review if they landed, then treated as skipped.
  deferred: z.literal(true).optional(),
};
// A REQUEST carries answers: strict, an unknown key is a 400.
export const AnswerSchema = z.strictObject(answerShape);
export type Answer = z.infer<typeof AnswerSchema>;

// z.partialRecord, not z.record: a single answered question must validate.
export const AnswersSchema = z.partialRecord(
  z.enum(QUESTION_IDS),
  AnswerSchema,
);
export type Answers = z.infer<typeof AnswersSchema>;
// The same shape as it is STORED (loose, see the header).
const StoredAnswersSchema = z.partialRecord(
  z.enum(QUESTION_IDS),
  z.looseObject(answerShape),
);

export const IdeaOptionsSchema = z.looseObject({
  business: z.array(OptionSchema).max(MAX_AI_OPTIONS.identity),
  audience: z.array(OptionSchema).max(MAX_AI_OPTIONS.audience),
  angle: z.array(OptionSchema).max(MAX_AI_OPTIONS.angle),
});
export type IdeaOptions = z.infer<typeof IdeaOptionsSchema>;
export const EMPTY_IDEA_OPTIONS: IdeaOptions = {
  business: [],
  audience: [],
  angle: [],
};

// A question counts as answered when something is picked or typed. (Skip and
// deferred are decisions but persist nothing and do not count.)
export function isAnswered(answer: Answer | undefined): boolean {
  if (!answer) return false;
  return answer.picked.length > 0 || Boolean(answer.other?.trim());
}

// A question is RESOLVED when the person has dealt with it in any way: answered,
// skipped or deferred. "Continue setup · question n of 5" counts these.
export function isResolved(answer: Answer | undefined): boolean {
  if (!answer) return false;
  return (
    isAnswered(answer) || answer.skipped === true || answer.deferred === true
  );
}

// -----------------------------------------------------------------------------
// 6. Stored rows (two Command rows per project, no migration)
//    Both are rewritten WHOLE through compare-and-swap on parsedIntent.<key>.rev
//    (the Work Session precedent, src/server/work-session/work-session-service.ts).
//    An unparseable row reads as "no session" and `start` REPLACES it (audit
//    AUDIT.sessionReset); known additive evolution rides on z.looseObject.
// -----------------------------------------------------------------------------

export const APPLY_PARTS = [
  "profile",
  "goal",
  "channels",
  "guardrails",
] as const;
export type ApplyPart = (typeof APPLY_PARTS)[number];
export const ApplyPartSchema = z.enum(APPLY_PARTS);

// How the goal is written. "active": created, approved by the USER, made ACTIVE.
// "proposed": created PROPOSED and left there (visible in Strategy, invisible to
// the Director) because approving it could start autonomous work: legacy loop on
// AND autopilot AND a connected publishing channel (spec 9.6).
export const GOAL_MODES = ["active", "proposed"] as const;
export type GoalMode = (typeof GOAL_MODES)[number];
export const GoalModeSchema = z.enum(GOAL_MODES);

export const SessionStatusSchema = z.enum(["OPEN", "APPLYING", "DONE"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

// Row 1: gs_<projectId>, topic GUIDED_SETUP, parsedIntent = { guidedSetup: SessionRecord }.
// Written by user actions (start, save, apply) only. The paid run NEVER writes
// here, so a research result can never make an Approve look stale.
// Two tokens on purpose: `rev` is the compare-and-swap token and changes on
// EVERY write (including the apply claim and finish); `editRev` changes only
// when the person's answers change. Approve compares `editRev`, so the apply
// transitions themselves never make a retry look stale. A third token,
// `applyToken`, belongs to ONE apply run: every part and the finish check it, so
// a run that was taken over after going stale stops silently instead of
// finishing over newer answers.
export const SessionRecordSchema = z.looseObject({
  v: z.literal(1),
  rev: z.string().min(6).max(32),
  editRev: z.string().min(6).max(32),
  status: SessionStatusSchema,
  step: z.enum(STEP_IDS).nullable(),
  // The person tapped "Add more detail" (the optional group is in the flow).
  more: z.boolean(),
  // Both decided ONCE when the row is created and stored so the step order never
  // changes under a person who already answered (see MAIN_QUESTIONS):
  // seedFirst = no website and no researched profile; staticFirst = a paid run can
  // happen (gates on, provider ok, input possible, no profile to adopt).
  seedFirst: z.boolean(),
  staticFirst: z.boolean(),
  answers: StoredAnswersSchema,
  // The client's own words that opened the sheet (cleaned), if any.
  seed: z.looseObject({ text: z.string().max(SEED_MAX) }).nullable(),
  applyingSinceMs: z.number().int().nullable(),
  applyToken: z.string().min(6).max(32).nullable(),
  // The goal this setup created or reused, written the moment it exists (before
  // any later part can fail) so a changed goal answer on retry can archive it.
  goalId: z.string().max(64).nullable(),
  applied: z
    .looseObject({
      atMs: z.number().int(),
      // The editRev that was applied: a second Approve with the same editRev is a no-op.
      editRev: z.string(),
      parts: z.array(ApplyPartSchema),
      goalMode: GoalModeSchema.nullable(),
      // null when nothing ever changed (no receipt was written).
      receiptId: z.string().nullable(),
    })
    .nullable(),
  lastFailure: z.looseObject({ failed: z.array(ApplyPartSchema) }).nullable(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  updatedByUserId: z.string(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

// Paid runs a project may ever claim (lifetime). Used by IdeasRecordSchema and
// DISCOVERY_LIMITS so the two can never drift apart.
export const MAX_DISCOVERY_ATTEMPTS = 3 as const;

export const IDEAS_REASONS = [
  "off", // GUIDED_SETUP_DISCOVERY is off (or not enabled for this workspace)
  "mock", // mock reasoning mode: nothing AI-made may reach a real Brand Core
  "provider", // hosted web search only exists on the OpenAI provider
  "no_input", // no website and no words: nothing to look for
  "limit", // a spend cap said no (per user, per workspace or global) or the provider budget gate did
  "timeout", // RUNNING for longer than DISCOVERY_LIMITS.staleRunningMs
  "failed", // Quick Discovery returned FAILED
  "busy", // Quick Discovery declined: another scan started in the last 10 minutes
  "inactive", // the project is paused or closed (never "created": start activates it)
] as const;
export type IdeasReason = (typeof IDEAS_REASONS)[number];

// Row 2: gi_<projectId>, topic GUIDED_SETUP_IDEAS, parsedIntent = { guidedIdeas: IdeasRecord }.
// Exists only once there is something to say: a paid run was claimed (RUNNING),
// or options were materialized from an existing profile (READY, source
// "profile", no paid call). Options are WRITE-ONCE per question: an id that was
// ever shown stays valid, and the list a person saw never changes under them.
export const IdeasRecordSchema = z.looseObject({
  v: z.literal(1),
  rev: z.string().min(6).max(32),
  status: z.enum(["RUNNING", "READY", "FAILED"]),
  source: z.enum(["profile", "discovery"]),
  reason: z.enum(IDEAS_REASONS).optional(),
  runId: z.string().max(32).optional(),
  // Paid runs claimed so far (lifetime, capped by DISCOVERY_LIMITS.maxAttemptsPerProject).
  attempts: z.number().int().min(0).max(MAX_DISCOVERY_ATTEMPTS),
  startedAtMs: z.number().int().optional(),
  finishedAtMs: z.number().int().optional(),
  host: z.string().max(253).optional(),
  pages: z.number().int().min(0).max(50).optional(),
  // BrandConstitution.version the options were built from.
  version: z.number().int().optional(),
  options: IdeaOptionsSchema,
  stats: z.looseObject({ kept: z.number().int(), dropped: z.number().int() }),
  updatedAtMs: z.number().int(),
});
export type IdeasRecord = z.infer<typeof IdeasRecordSchema>;

// -----------------------------------------------------------------------------
// 7. API shapes
//    GET/POST /api/projects/[projectId]/guided-setup  (Route Handler)
//    applyGuidedSetupAction(projectId, expectedRev)    (the ONLY Server Action, DB only)
// -----------------------------------------------------------------------------

export type IdeasStatus =
  "UNAVAILABLE" | "IDLE" | "RUNNING" | "READY" | "FAILED";

export type IdeasView = {
  status: IdeasStatus;
  // Set for UNAVAILABLE and FAILED (and for a refused start: "limit").
  reason?: IdeasReason;
  // Where READY options came from: an existing profile or the run just done.
  source: "none" | "profile" | "discovery";
  // Server clock: seconds since the paid run started (the client never reads
  // Date.now() during render).
  ageSec?: number;
  attempts: number;
  // A paid run can be started by an explicit tap right now.
  canStart: boolean;
  // FAILED (or timed out) with attempts left: an explicit tap may try again.
  canRetry: boolean;
  // Facts the server can state: the site it read and how many pages it got.
  host?: string;
  pages?: number;
  options: IdeaOptions;
};

// "Current" values shown under a question and on Review, never pre-selected. AI
// text may be present (from an existing profile), so the panel wraps it like any
// AI text.
export type CurrentValues = {
  identity?: string;
  audiences?: string[];
  tone?: string;
  goal?: string;
};

export type BrandInfo = {
  name: string;
  // Bare host of Project.domain, or null.
  host: string | null;
  // Project.language code: the language of every AI-derived string.
  languageCode: string;
};

export type GuidedSetupView = {
  // The session's editRev: changes only when the person's answers change.
  // Approve sends it back as expectedRev.
  rev: string;
  status: SessionStatus;
  step: StepId | null;
  more: boolean;
  answers: Answers;
  // The person's own opening words, clipped for the help line ("You mentioned ...").
  seed?: string;
  brand: BrandInfo;
  current: CurrentValues;
  // No website and no profile: the business question comes first.
  seedFirst: boolean;
  // A paid run can happen: the research-fed questions come last.
  staticFirst: boolean;
  // An ACTIVE, non-mock constitution exists.
  hasProfile: boolean;
  // The project is ACTIVE (start tries to activate a CREATED one). False only for
  // PAUSED or CLOSED: answering works, approving needs it active.
  projectActive: boolean;
  // How Approve would write the goal right now (spec 9.6); Review words it.
  goalMode: GoalMode;
  // AutonomyPolicy.autopilotMode, read-only, for the Review line. null = unknown.
  handsOn: HandsOn | null;
  // Six channel rows with live connection state.
  channels: Option[];
  ideas: IdeasView;
  // ISO time of the last successful apply, if any.
  appliedAt?: string;
};

// What the poll returns while a run is in flight: two primary-key reads.
export type GuidedSetupPoll = Pick<GuidedSetupView, "rev" | "status" | "ideas">;
// A save also returns the ideas view: saving the business answer is what makes a
// paid run possible, and the offer must follow without a reload.
export type SaveResponse = Pick<GuidedSetupView, "rev" | "status" | "ideas">;

export type DiscoverOutcome =
  | "STARTED"
  | "ALREADY_RUNNING"
  | "READY"
  | "LIMIT"
  | "UNAVAILABLE"
  | "BUSY"
  | "EXHAUSTED";
export type DiscoverResponse = { outcome: DiscoverOutcome; ideas: IdeasView };

export const GuidedSetupRequestSchema = z.discriminatedUnion("action", [
  // Creates the session row if absent. NEVER starts a paid run. Idempotent.
  z.strictObject({
    action: z.literal("start"),
    // The chat message that asked for setup (agent tool card). The server reads
    // ITS rawText from the Command row; a model can never supply the words.
    seedCommandId: z.string().min(1).max(64).optional(),
  }),
  // Whole answers each time (latest write wins across tabs).
  z.strictObject({
    action: z.literal("save"),
    step: z.enum(STEP_IDS),
    more: z.boolean(),
    answers: AnswersSchema,
  }),
  // The explicit tap on "Get ideas" (also the explicit retry after a failure).
  z.strictObject({ action: z.literal("discover") }),
  // The receipt's "Draft my first plan" (agent engine only, checked on the
  // server). Read-only: answers the plan-brief message the card then sends.
  z.strictObject({ action: z.literal("draft_plan") }),
]);
export type GuidedSetupRequest = z.infer<typeof GuidedSetupRequestSchema>;

export type ApiErrorCode =
  | "SESSION" // signed out (the client also maps a redirect / an OK non-JSON answer here)
  | "NOT_FOUND"
  | "RATE"
  | "INVALID" // zod failure, wrong content type or a body over REQUEST_LIMITS.maxBodyBytes
  | "BUSY" // the session is APPLYING
  | "DISABLED" // GUIDED_SETUP is off
  | "FAILED"; // an unexpected server error; the JSON body never carries its message
export type ApiError = { error: string; code: ApiErrorCode };

export type ApplyResult =
  | {
      ok: true;
      parts: ApplyPart[];
      // Every part reported UNCHANGED: nothing was written and no receipt exists.
      unchanged: boolean;
      // The mode the goal was actually written in (null: no goal answered).
      goalMode: GoalMode | null;
      // Social channels the person picked that have no connected account, for the
      // done view's "Connect accounts" button. Best-effort: [] when unknown or
      // when nothing changed (no receipt was written).
      unconnected: ChannelKey[];
    }
  | {
      ok: false;
      code:
        | "STALE"
        | "BUSY"
        | "ON_HOLD"
        | "NOTHING"
        | "PARTIAL"
        | "FAILED"
        | "RATE" // APPLY_LIMITS.perProjectPer24h reached
        | "DISABLED";
      message: string;
      saved: ApplyPart[];
      failed: ApplyPart[];
    };

export type DraftPlanResult =
  | { ok: true; message: string }
  | {
      ok: false;
      code: "LEGACY_ENGINE" | "NOT_APPLIED" | "NO_PLAN";
      message: string;
    };

// -----------------------------------------------------------------------------
// 8. The apply plan: ONE object feeds the Review screen and the writers, so
//    the Review cannot promise something the saga does not do (plan.ts).
// -----------------------------------------------------------------------------

export type PlanProfile = {
  identity?: string;
  positioning?: string;
  toneOfVoice?: string;
  audiences?: string[];
};
export type PlanRule = { text: string; source: "preset" | "typed" };
export type PlanLine = { part: ApplyPart; text: string };

export type ApplyPlan = {
  profile: PlanProfile | null;
  goal: {
    key: PlanGoal;
    title: string;
    metricKey: string;
    mode: GoalMode;
  } | null;
  channels: { keys: ChannelKey[]; memoryLine: string } | null;
  guardrails: { rules: PlanRule[]; memoryLine: string | null } | null;
  // Plain-words lines for "What approving does" (closed vocabulary plus the
  // person's own picks; never model prose).
  lines: PlanLine[];
  // Nothing would be written: Approve says why and does nothing.
  empty: boolean;
};

export type ReviewChip = { text: string; ai?: true };
export type ReviewRow = {
  question: QuestionId;
  // "delegated" = skipped on a question whose spec has delegate ("You decide");
  // "current" = not answered here, but the profile already holds a value.
  state: "answered" | "skipped" | "delegated" | "unanswered" | "current";
  chips: ReviewChip[];
};

// Closed-vocabulary receipt words (the receipt is agent-visible history).
export const RECEIPT_PART_LABELS: Record<ApplyPart, string> = {
  profile: "Brand profile",
  goal: "Goal",
  channels: "Channel focus",
  guardrails: "Rules",
};

// -----------------------------------------------------------------------------
// 9. Entry state (server summary for the page, chip and menu rules)
// -----------------------------------------------------------------------------

export type GuidedSetupSummary = {
  status: "NONE" | "OPEN" | "DONE";
  // Main questions answered so far.
  answered: number;
  total: number;
  // 1-based position for "Continue setup · question n of 5": resolved main
  // questions + 1, clamped to total. Order-independent on purpose.
  position: number;
  // A session was opened past its first step, or a paid run exists: setup was
  // really begun even if nothing is answered yet (a paid run publishes a profile
  // and flips hasProfile, which must not hide the way back).
  started: boolean;
  // An ACTIVE, non-mock constitution exists or a setup was applied.
  hasProfile: boolean;
};

// What the project page (server) hands ProjectChat (client) when GUIDED_SETUP is
// on. Undefined when the flag is off (or entry() threw: loadGuidedHost never
// throws): no provider value, no sheet, no chip.
export type GuidedSetupHost = {
  summary: GuidedSetupSummary;
  seedFirst: boolean;
  languageCode: string;
  // ?guide=setup was present on this request (entry only: auto-open once).
  requested: boolean;
};

export type GuidedEntry = {
  kind: "start" | "continue" | "update";
  label: string;
  // The Welcome card (empty chat) shows for start / continue only.
  welcome: boolean;
  // Eligible for the persistent chip row. The chip itself additionally needs a
  // NON-empty thread (the Welcome card is its twin on an empty one) and no
  // per-project "Not now" (client-side).
  chip: boolean;
};

export function entryOf(summary: GuidedSetupSummary): GuidedEntry {
  if (summary.status === "OPEN" && (summary.answered > 0 || summary.started)) {
    const n = Math.min(Math.max(summary.position, 1), summary.total);
    return {
      kind: "continue",
      label: `Continue setup · question ${n} of ${summary.total}`,
      welcome: true,
      chip: true,
    };
  }
  if (summary.status !== "DONE" && !summary.hasProfile) {
    return {
      kind: "start",
      label: "Set up your brand",
      welcome: true,
      chip: true,
    };
  }
  return {
    kind: "update",
    label: "Update your setup",
    welcome: false,
    chip: false,
  };
}

// -----------------------------------------------------------------------------
// 10. The chat card (registered in src/types/idea-event-card.ts, four places)
// -----------------------------------------------------------------------------

export type GuidedSetupCardData = {
  kind: "guided-setup";
  projectId: string;
  ideaId?: string;
  // "open": the launcher an agent tool returns. "done": the receipt.
  state: "open" | "done";
  // open only: the chat message that asked for setup. The server reads the
  // words from that Command row, never from the model.
  sourceCommandId?: string;
  summary?: {
    goal?: string;
    // The goal was saved as a proposal that waits for approval in Strategy.
    goalProposed?: boolean;
    channels?: string[];
    unconnected?: ChannelKey[];
    // Values of RECEIPT_PART_LABELS.
    saved: string[];
    // A goal and at least one non-ads channel were picked: the agent engine
    // may offer "Draft my first plan" (a separate, explicit button).
    canDraftPlan?: boolean;
  };
};

// The optional first-plan draft (agent engine only, a separate explicit button
// on the receipt, never part of Approve). Closed vocabulary only: no theme, no
// text from anyone.
export const FIRST_PLAN = {
  perWeek: 3,
  weeks: 2,
  // Ads are spend-adjacent: never part of an auto-built brief.
  excludedChannels: ["ads"] as readonly ChannelKey[],
} as const;

// -----------------------------------------------------------------------------
// 11. Limits
// -----------------------------------------------------------------------------

// The paid run is one existing QuickDiscoveryService.run (site + a little web
// search). Its own retry ladder is not changed in Increment A (a max_output_tokens
// cut re-runs with a doubled budget, up to 3 paid calls: openai-search-client.ts),
// so the caps below bound the COUNT of runs, not the dollars: a fully truncated run
// is about $1.0 [estimate]. Increment B1 adds the per-call options that bound the
// cost, and GUIDED_SETUP_DISCOVERY stays off until it ships (spec 8.6, 15.4).
export const DISCOVERY_LIMITS = {
  // Paid runs claimed per project, lifetime. Retry only by explicit tap.
  maxAttemptsPerProject: MAX_DISCOVERY_ATTEMPTS,
  // Started runs in the trailing window (workspace-level audit rows, insert-then-count).
  // These are CEILINGS: GUIDED_SETUP_DISCOVERY_CAPS can only lower them.
  perUserPer24h: 5,
  perWorkspacePer24h: 10,
  globalPer24h: 20,
  windowMs: 24 * 60 * 60 * 1000,
  // RUNNING longer than this reads as FAILED (reason "timeout"); a retry is explicit.
  staleRunningMs: 240_000,
  // The runner stops waiting for Quick Discovery after this and records FAILED.
  runDeadlineMs: 150_000,
  // A cap refusal is logged (console.error) at most this often per scope.
  capLogIntervalMs: 60 * 60 * 1000,
  // The Quick Discovery prompt tells the model to run at most this many web
  // searches when it carries the client's own words (a soft cap; B1 is the hard one).
  promptMaxWebSearches: 3,
} as const;

export type DiscoveryCaps = {
  perUserPer24h: number;
  perWorkspacePer24h: number;
  globalPer24h: number;
};

// GUIDED_SETUP_DISCOVERY_CAPS="5,10,20" (user, workspace, global per 24 h). Any
// parse problem falls back to the ceilings (spec decision 46), and a value above
// a ceiling is clamped to it: the variable can only LOWER a cap (an incident
// switch that needs a restart, not a deploy). "0,0,0" pauses ideas without
// turning the flag off. Commas, semicolons and plain spaces all separate the
// three numbers, so a pause typed as "0;0;0" or "0 0 0" still pauses.
export function parseDiscoveryCaps(
  raw: string | null | undefined,
): DiscoveryCaps {
  const ceilings: DiscoveryCaps = {
    perUserPer24h: DISCOVERY_LIMITS.perUserPer24h,
    perWorkspacePer24h: DISCOVERY_LIMITS.perWorkspacePer24h,
    globalPer24h: DISCOVERY_LIMITS.globalPer24h,
  };
  if (!raw) return ceilings;
  const parts = raw.trim().split(/\s*[,;]\s*|\s+/u);
  if (parts.length !== 3 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return ceilings;
  }
  const [user, workspace, global] = parts.map(Number) as [
    number,
    number,
    number,
  ];
  return {
    perUserPer24h: Math.min(user, ceilings.perUserPer24h),
    perWorkspacePer24h: Math.min(workspace, ceilings.perWorkspacePer24h),
    globalPer24h: Math.min(global, ceilings.globalPer24h),
  };
}

// GUIDED_SETUP_DISCOVERY = "false" (default) | "true" (every workspace) | a
// comma-separated list of workspace ids (a canary). Anything malformed reads as
// off: one bad entry disables the whole list. GUIDED_SETUP itself is process-wide.
export type DiscoveryScope =
  | { kind: "off" }
  | { kind: "all" }
  | { kind: "workspaces"; ids: readonly string[] };
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function parseDiscoveryScope(
  raw: string | null | undefined,
): DiscoveryScope {
  const value = (raw ?? "").trim();
  if (value === "" || value === "false") return { kind: "off" };
  if (value === "true") return { kind: "all" };
  const ids = value.split(",").map((part) => part.trim());
  if (ids.some((id) => !WORKSPACE_ID.test(id))) return { kind: "off" };
  return { kind: "workspaces", ids: [...new Set(ids)] };
}
export function discoveryEnabledFor(
  scope: DiscoveryScope,
  workspaceId: string,
): boolean {
  if (scope.kind === "all") return true;
  return scope.kind === "workspaces" && scope.ids.includes(workspaceId);
}

export const POLL = {
  intervalMs: 2_000,
  // Stop polling after this, or on any terminal state, or while the tab is hidden.
  maxMs: 300_000,
  requestTimeoutMs: 15_000,
  // After this many seconds of RUNNING the strip says "Still working ...".
  slowAfterSec: 60,
  // A 429, a 5xx or a network failure while polling backs off silently: the delay
  // doubles up to maxDelayMs, and after maxConsecutiveFailures the strip gives up.
  maxDelayMs: 10_000,
  maxConsecutiveFailures: 3,
} as const;

export const APPLY_LIMITS = {
  // An APPLYING claim older than this is read as OPEN (a crashed apply).
  staleApplyingMs: 90_000,
  // Durable per-project cap on Approve, counted from AUDIT.applied rows.
  perProjectPer24h: 12,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

export const APPLY_UI = {
  // After this long in "applying" the sheet says it is taking longer and that
  // closing is safe: the shell keeps the action running.
  stalledAfterMs: 20_000,
} as const;

// Saves that fail are retried by the shell before the person is told.
export const SAVE_RETRY = {
  delaysMs: [1_000, 3_000, 8_000],
} as const;

// A JSON body larger than this is refused with 413 (code INVALID) before parsing.
export const REQUEST_LIMITS = {
  maxBodyBytes: 16_384,
} as const;

// In-memory, per instance: a runaway-client guard, NOT spend control. Keys are
// per user AND project ("guided-setup:<userId>:<projectId>") so two tabs on two
// projects do not starve each other.
export const RATE = {
  routePerMinute: 90,
  discoverPerMinute: 6,
  applyPerMinute: 6,
  draftPlanPerMinute: 3,
} as const;
