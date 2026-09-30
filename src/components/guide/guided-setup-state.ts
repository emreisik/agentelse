// Guided setup: the client model, reducer and selectors (spec 3.1, 3.4-3.6,
// 6.4, 6.5).
//
// Plain TypeScript on purpose: no React, no Date.now, no refs, no timers. Every
// decision the sheet makes (what is on screen, what Continue does, where focus
// goes, what the live region says) is a pure function of the Model, so it is
// tested without a DOM. Elapsed time comes from `ideas.ageSec` (a server fact);
// the shell owns the clock, the save queue, the poll and the in-flight action and
// reports back through actions. Step order, progress, catch-up and resume come
// from steps.ts, the plan and the Review rows from plan.ts: the same code the
// server uses, so the two can never disagree.

import {
  CHANNEL_HINTS,
  FIRST_PLAN,
  GUARDRAILS,
  HANDS_ON_LABEL,
  MAIN_QUESTIONS,
  MAX_VISIBLE_ROWS,
  BUSINESS_KINDS_MORE,
  BUSINESS_KINDS_PRIMARY,
  AUDIENCE_SEGMENTS,
  APPLY_UI,
  CURRENT_MAX,
  EMPTY_IDEA_OPTIONS,
  POLL,
  QUESTIONS,
  QUESTION_IDS,
  RECEIPT_PART_LABELS,
  TONES,
  TOTAL_MAIN_QUESTIONS,
  channelOptionId,
  goalOptionId,
  isAnswered,
  type Answer,
  type Answers,
  type ApplyPart,
  type ApplyPlan,
  type ApplyResult,
  type BrandInfo,
  type GuidedSetupHost,
  type GuidedSetupRequest,
  type GuidedSetupSummary,
  type GuidedSetupView,
  type IdeaOptions,
  type IdeasView,
  type PlanLine,
  type QuestionId,
  type ReviewChip,
  type ReviewRow,
  type SaveResponse,
  type SessionStatus,
  type StepId,
} from "@/lib/guided-setup/contract";
import {
  CHANNEL_KEYS,
  CHANNELS,
  PLAN_GOALS,
  PLAN_GOAL_LABEL,
  type ChannelKey,
} from "@/lib/content-channels";
import {
  allMainSkipped,
  bumpReached,
  businessMode,
  checkpointSuggestions,
  detailSteps,
  firstStepOf,
  mainOrder,
  nextStep,
  prevStep,
  progressOf as stepProgress,
  resumeStep,
  stepsFor,
  type FlowCtx,
  type Lists,
  type Progress,
  type Reached,
} from "@/lib/guided-setup/steps";
import {
  answeredMain,
  buildApplyPlan,
  reviewRowsOf as planReviewRows,
} from "@/lib/guided-setup/plan";
import { cleanDisplayText } from "@/lib/guided-setup/sanitize";

// -----------------------------------------------------------------------------
// Model
// -----------------------------------------------------------------------------

export type Phase =
  | "booting"
  | "ready"
  | "applying"
  | "done"
  | "bootError"
  | "expired"
  | "unavailable";

// Where the shell moves focus after a render (one effect keyed on `seq`).
export type FocusTarget = "title" | "other" | "otherRow" | "strip" | "close";
export type FocusIntent = { target: FocusTarget; seq: number };

export type InlineKind =
  | "saveFailed"
  | "stale"
  | "onHold"
  | "partial"
  | "failed"
  | "busy"
  | "rate"
  | "discover"
  | "paused"
  // A pick did not survive the switch to the suggestions list.
  | "pickCleared";
export type InlineNotice = {
  kind: InlineKind;
  retry?: true;
  saved?: ApplyPart[];
  failed?: ApplyPart[];
};

export type ReturnTo = "review" | "checkpoint";

export type DoneSummary = {
  goal?: string;
  goalProposed?: boolean;
  channels?: string[];
  saved: string[];
  unconnected?: ChannelKey[];
  canDraftPlan: boolean;
};

// A result that arrives while the sheet is closed becomes a toast (the only
// place a toast is allowed). The shell shows each `seq` once.
export type ToastIntent = {
  seq: number;
  kind: "saved" | "partial";
  text: string;
};

export type Model = {
  projectId: string;
  // The agent engine can draft a first plan (the legacy engine cannot).
  engineCanDraftPlan: boolean;
  brand: BrandInfo;
  // The project already had a session when the sheet opened: boot shows a
  // skeleton, never question 1.
  returning: boolean;
  phase: Phase;
  // The last server view: the source of rev, ideas, current, channels, flags.
  view: GuidedSetupView | null;
  seedFirst: boolean;
  staticFirst: boolean;
  // The session's editRev: what Approve sends back as expectedRev.
  rev: string | null;
  status: SessionStatus;
  // editRev at the last apply (or of a DONE session when opened).
  appliedRev: string | null;
  // Something (a pick, text or navigation) happened locally: hydration keeps it.
  touched: boolean;
  // The answers changed since the last apply.
  dirty: boolean;
  // Bumped by every change of a saved field (answers, step, more): the shell
  // enqueues a save whenever it changes.
  editSeq: number;
  step: StepId;
  cameFrom: StepId | null;
  direction: 1 | -1;
  answers: Answers;
  more: boolean;
  // Frozen at the first render of a research-fed step. Absent while its list is
  // still pending (ideas RUNNING).
  lists: Lists;
  ideas: IdeasView | null;
  reached: Reached;
  // The current step is the one-time catch-up visit of a deferred question.
  catchUp: boolean;
  kindTier: 1 | 2;
  otherOpen: boolean;
  // "Not quite" on the business confirm card: the suggestion is not offered again.
  notQuite: boolean;
  returnTo: ReturnTo | null;
  save: "idle" | "saving" | "failed";
  focus: FocusIntent;
  inline: InlineNotice | null;
  applyStalled: boolean;
  // The suggestions became ready while the person is on this step (live region).
  announceReady: boolean;
  done: DoneSummary | null;
  toast: ToastIntent | null;
};

export type ApplyFailCode = Extract<ApplyResult, { ok: false }>["code"];
type ApplyOk = Extract<ApplyResult, { ok: true }>;

export type Action =
  | { type: "hydrated"; view: GuidedSetupView; reload?: boolean }
  | { type: "bootFailed" }
  | { type: "bootRetry" }
  | { type: "unavailable" }
  | { type: "expired" }
  | {
      type: "ideasUpdated";
      ideas: IdeasView;
      from: "start" | "save" | "poll" | "discover";
    }
  | { type: "discoverFailed" }
  | { type: "pick"; id: string }
  | { type: "toggleOther" }
  | { type: "otherText"; text: string }
  | { type: "tier" }
  | { type: "confirmYes" }
  | { type: "confirmNo" }
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "goTo"; step: StepId }
  | { type: "addDetail" }
  | { type: "reviewNow" }
  | { type: "showSuggestions" }
  | { type: "look" }
  // `seq` is the model's editSeq when the saved body was taken.
  | { type: "saved"; response: SaveResponse; seq: number }
  | { type: "saveFailed" }
  | { type: "applyStarted" }
  | { type: "applyStalled" }
  | {
      type: "applyFailed";
      code: ApplyFailCode;
      saved?: ApplyPart[];
      failed?: ApplyPart[];
      closed?: boolean;
    }
  | { type: "applied"; result: ApplyOk; closed?: boolean }
  // The done view's "Edit setup": back to Review.
  | { type: "editSetup" };

export const TOAST_TEXT = {
  saved: "Setup saved",
  partial: "Some parts of your setup weren't saved. Open setup to try again.",
} as const;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

type IdeasKey = "business" | "audience" | "angle";
const isIdeasKey = (q: QuestionId): q is IdeasKey =>
  q === "business" || q === "audience" || q === "angle";

// The questions whose list can be pending on a run: "angle" has no static list
// (its step exists only when options do), so it is never pending.
const isPendingKind = (q: QuestionId): q is "business" | "audience" =>
  q === "business" || q === "audience";

function questionOf(step: StepId): QuestionId | null {
  return (QUESTION_IDS as readonly string[]).includes(step)
    ? (step as QuestionId)
    : null;
}

function hasOptions(ideas: IdeasView | null, q: QuestionId): boolean {
  return ideas !== null && isIdeasKey(q) && ideas.options[q].length > 0;
}

function optionsOf(ideas: IdeasView | null): IdeaOptions {
  return ideas?.options ?? EMPTY_IDEA_OPTIONS;
}

function interactive(m: Model): boolean {
  return m.phase === "ready" || (m.phase === "booting" && !m.returning);
}

const answerCount = (answer: Answer | undefined): number =>
  (answer?.picked.length ?? 0) + (answer?.other?.trim() ? 1 : 0);

// Drops empty optional fields; undefined when nothing is left to say.
function tidy(answer: Answer): Answer | undefined {
  const picked = [...answer.picked];
  const other = answer.other?.trim() ? answer.other : undefined;
  const out: Answer = { picked };
  if (other !== undefined) out.other = other;
  if (answer.skipped === true) out.skipped = true;
  else if (answer.deferred === true) out.deferred = true;
  return picked.length > 0 ||
    other !== undefined ||
    out.skipped === true ||
    out.deferred === true
    ? out
    : undefined;
}

function withAnswer(
  answers: Answers,
  q: QuestionId,
  answer: Answer | undefined,
): Answers {
  const next: Answers = { ...answers };
  const clean = answer ? tidy(answer) : undefined;
  if (clean) next[q] = clean;
  else delete next[q];
  return next;
}

const sameAnswers = (a: Answers, b: Answers): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function clipCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function focused(m: Model, target: FocusTarget): Model {
  return { ...m, focus: { target, seq: m.focus.seq + 1 } };
}

// A saved field changed (answers, step or more): the shell enqueues a save.
function edited(m: Model, answersChanged: boolean): Model {
  return {
    ...m,
    touched: true,
    dirty: m.dirty || answersChanged,
    editSeq: m.editSeq + 1,
    save: "saving",
  };
}

// The flow context steps.ts works with. During the one-time catch-up visit the
// step still counts as "deferred and not yet frozen", even after a pick, so
// nextStep and progressOf keep treating it as the catch-up (a pick clears the
// deferral and the freeze would otherwise turn it into an ordinary step).
function flowCtx(m: Model): FlowCtx {
  const catching = m.catchUp && questionOf(m.step) !== null;
  const q = questionOf(m.step);
  let lists = m.lists;
  let answers = m.answers;
  if (catching && q) {
    lists = { ...m.lists };
    delete lists[q];
    answers = { ...m.answers, [q]: { picked: [], deferred: true } };
  }
  return {
    seedFirst: m.seedFirst,
    staticFirst: m.staticFirst,
    more: m.more,
    answers,
    ideas: m.ideas,
    lists,
    reached: m.reached,
    cameFrom: m.cameFrom,
  };
}

export function stepsOf(m: Model): StepId[] {
  return stepsFor({
    seedFirst: m.seedFirst,
    staticFirst: m.staticFirst,
    more: m.more,
    hasAngleOptions: hasOptions(m.ideas, "angle"),
  });
}

// -----------------------------------------------------------------------------
// Frozen lists
// -----------------------------------------------------------------------------

// The list a research-fed step shows is decided ONCE, the first time it renders:
// the ideas when they are there for this question, the catalog otherwise. While
// a run is in flight and nothing is there yet it stays undecided (the step shows
// skeleton rows and remains fully usable). Never changed under the person.
function freezeFor(m: Model, q: QuestionId): Lists {
  if (!QUESTIONS[q].ideas || m.lists[q] !== undefined) return m.lists;
  if (hasOptions(m.ideas, q)) return { ...m.lists, [q]: "ideas" };
  if (!isPendingKind(q)) return m.lists;
  if (m.ideas?.status === "RUNNING") return m.lists;
  return { ...m.lists, [q]: "static" };
}

// True for a research-fed step whose list is not decided yet because a run is in
// flight: the panel shows skeleton rows, "Skip for now" defers the question.
function isPending(m: Model, q: QuestionId): boolean {
  return (
    isPendingKind(q) &&
    m.lists[q] === undefined &&
    !hasOptions(m.ideas, q) &&
    m.ideas?.status === "RUNNING"
  );
}

// "Suggestions are ready · Show": the question keeps its catalog list while
// ideas for it have landed. Not after "Not quite" on the business card.
function bannerVisible(m: Model, q: QuestionId): boolean {
  if (!isPendingKind(q) || m.lists[q] !== "static") return false;
  if (q === "business" && m.notQuite) return false;
  return hasOptions(m.ideas, q);
}

// -----------------------------------------------------------------------------
// Options (rows)
// -----------------------------------------------------------------------------

type Source = {
  id: string;
  label: string;
  hint?: string;
  ai: boolean;
  connected?: boolean;
};

const fromStatic = (
  list: readonly { id: string; label: string; hint?: string }[],
): Source[] =>
  list.slice(0, MAX_VISIBLE_ROWS).map((o) => ({
    id: o.id,
    label: o.label,
    ...(o.hint ? { hint: o.hint } : {}),
    ai: false,
  }));

const fromIdeas = (
  list: readonly { id: string; label: string; hint?: string }[],
): Source[] =>
  list.map((o) => ({
    id: o.id,
    label: o.label,
    ...(o.hint ? { hint: o.hint } : {}),
    ai: true,
  }));

function channelSources(m: Model): Source[] {
  const live = m.view?.channels ?? [];
  if (live.length > 0) {
    return live.slice(0, MAX_VISIBLE_ROWS).map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.hint ? { hint: o.hint } : {}),
      ai: false,
      ...(o.connected !== undefined ? { connected: o.connected } : {}),
    }));
  }
  return CHANNEL_KEYS.map((key) => ({
    id: channelOptionId(key),
    label: CHANNELS[key].label,
    hint: CHANNEL_HINTS[key],
    ai: false,
  }));
}

// Every option a question can show right now (business: the visible tier).
function sourcesOf(m: Model, q: QuestionId): Source[] {
  const options = optionsOf(m.ideas);
  switch (q) {
    case "goal":
      return PLAN_GOALS.map((goal) => ({
        id: goalOptionId(goal),
        label: PLAN_GOAL_LABEL[goal].label,
        hint: PLAN_GOAL_LABEL[goal].hint,
        ai: false,
      }));
    case "channels":
      return channelSources(m);
    case "business":
      if (isPending(m, q)) return [];
      if (m.lists.business === "ideas") return fromIdeas(options.business);
      return fromStatic(
        m.kindTier === 2 ? BUSINESS_KINDS_MORE : BUSINESS_KINDS_PRIMARY,
      );
    case "audience":
      if (isPending(m, q)) return [];
      return m.lists.audience === "ideas"
        ? fromIdeas(options.audience)
        : fromStatic(AUDIENCE_SEGMENTS);
    case "tone":
      return fromStatic(TONES);
    case "angle":
      return fromIdeas(options.angle);
    case "guardrails":
      return fromStatic(GUARDRAILS);
  }
}

export type RowView = {
  id: string;
  label: string;
  hint?: string;
  ai: boolean;
  selected: boolean;
  disabled: boolean;
  connected?: boolean;
};

function rowsOf(m: Model, q: QuestionId): RowView[] {
  const spec = QUESTIONS[q];
  const answer = m.answers[q];
  const full = spec.mode === "multi" && answerCount(answer) >= spec.max;
  return sourcesOf(m, q).map((s) => {
    const selected = answer?.picked.includes(s.id) === true;
    return {
      ...s,
      selected,
      disabled: full && !selected,
    };
  });
}

function isConfirm(m: Model): boolean {
  return (
    m.step === "business" &&
    businessMode({ lists: m.lists, ideas: m.ideas }) === "confirm"
  );
}

// -----------------------------------------------------------------------------
// Transitions between steps
// -----------------------------------------------------------------------------

// The tier that holds the current business pick (typed text opens tier 1).
function tierOfAnswer(answer: Answer | undefined): 1 | 2 {
  const id = answer?.picked[0];
  return id && BUSINESS_KINDS_MORE.some((k) => k.id === id) ? 2 : 1;
}

// Makes `step` current: freezes its list, works out whether it is the catch-up
// visit, folds the progress into `reached` (segments never empty) and resets the
// local UI state that belongs to a step. Focus and saving are the caller's.
function arrive(m: Model, step: StepId, direction: 1 | -1): Model {
  const q = questionOf(step);
  const probe: Model = { ...m, step, catchUp: false };
  const catchUp = stepProgress(step, flowCtx(probe)).catchUp;

  let lists = m.lists;
  if (q) {
    lists = catchUp
      ? { ...m.lists, [q]: "ideas" }
      : freezeFor({ ...m, step, lists: m.lists }, q);
  }
  const next: Model = {
    ...m,
    step,
    direction,
    lists,
    catchUp,
    announceReady: false,
    otherOpen: q !== null && Boolean(m.answers[q]?.other?.trim()),
    kindTier: q === "business" ? tierOfAnswer(m.answers.business) : m.kindTier,
    reached: bumpReached(
      m.reached,
      stepProgress(step, flowCtx({ ...m, step, lists, catchUp })),
    ),
  };
  return next;
}

// A navigation the person made: arrive, remember where Review was opened from,
// tidy leftover deferrals when Review opens, focus the title, enqueue a save.
function go(m: Model, step: StepId, direction: 1 | -1): Model {
  let base: Model = m;
  if (step === "review" && m.step !== "review") {
    base = { ...base, cameFrom: m.step };
    // A deferral whose ideas never landed is a plain skip from here on.
    let answers = base.answers;
    for (const q of QUESTION_IDS) {
      if (answers[q]?.deferred === true) {
        answers = withAnswer(answers, q, { picked: [], skipped: true });
      }
    }
    base = { ...base, answers };
  }
  const arrived = arrive(base, step, direction);
  return focused(edited(arrived, false), "title");
}

// The step after the current one, honouring the catch-up rules of steps.ts. When
// the checkpoint was skipped on the strength of the deferral stand-in, a real
// pick brings it back.
function nextOf(m: Model): StepId | null {
  const next = nextStep(m.step, flowCtx(m));
  if (
    next === "review" &&
    m.step !== "checkpoint" &&
    !allMainSkipped(m.answers)
  ) {
    const inMain = (MAIN_QUESTIONS as readonly string[]).includes(m.step);
    if (inMain) return "checkpoint";
  }
  return next;
}

function advance(m: Model): Model {
  if (m.returnTo) {
    return go({ ...m, returnTo: null }, m.returnTo, 1);
  }
  const next = nextOf(m);
  return next ? go(m, next, 1) : m;
}

// -----------------------------------------------------------------------------
// Ideas landing
// -----------------------------------------------------------------------------

function withIdeas(
  m: Model,
  ideas: IdeasView,
  from?: "start" | "save" | "poll" | "discover",
): Model {
  const beforeBanner = (q: QuestionId | null) =>
    q !== null && bannerVisible(m, q);
  const q = questionOf(m.step);
  const wasVisible = beforeBanner(q);

  // Options are write-once on the server, so a list the person already saw never
  // changes there; keep the frozen ones byte for byte regardless.
  const options: IdeaOptions = { ...ideas.options };
  for (const key of ["business", "audience", "angle"] as const) {
    if (m.lists[key] === "ideas" && m.ideas) options[key] = m.ideas.options[key];
  }
  let next: Model = { ...m, ideas: { ...ideas, options } };
  if (next.inline?.kind === "discover") next = { ...next, inline: null };
  // A pending step whose run just ended decides its list now; a decided list
  // never changes.
  if (q && interactive(next)) {
    next = { ...next, lists: freezeFor(next, q) };
  }
  if (q && !wasVisible && bannerVisible(next, q)) {
    next = { ...next, announceReady: true };
  }
  if (from === "discover") next = focused(next, "strip");
  return next;
}

// The user asked to see the ideas list on the current step ("Show"), or on the
// first step answered from the catalog ("Look"). A pick survives only when its id
// exists in the ideas list.
function swapToIdeas(m: Model, q: QuestionId): Model {
  if (!isIdeasKey(q) || !hasOptions(m.ideas, q)) return m;
  const ids = optionsOf(m.ideas)[q].map((o) => o.id);
  const answer = m.answers[q];
  let answers = m.answers;
  let inline = m.inline?.kind === "pickCleared" ? null : m.inline;
  if (answer && answer.picked.length > 0) {
    const kept = answer.picked.filter((id) => ids.includes(id));
    if (kept.length !== answer.picked.length) {
      answers = withAnswer(m.answers, q, { ...answer, picked: kept });
      inline = { kind: "pickCleared" };
    }
  }
  return {
    ...m,
    answers,
    inline,
    lists: { ...m.lists, [q]: "ideas" },
    notQuite: q === "business" ? false : m.notQuite,
    otherOpen: Boolean(answers[q]?.other?.trim()),
  };
}

// -----------------------------------------------------------------------------
// Initial model and reducer
// -----------------------------------------------------------------------------

export function initialModel(input: {
  projectId: string;
  brandName: string;
  languageCode: string;
  host: GuidedSetupHost;
  // chatEngine === "agent"
  canDraftPlan: boolean;
}): Model {
  const seedFirst = input.host.seedFirst;
  const first = firstStepOf(seedFirst);
  const model: Model = {
    projectId: input.projectId,
    engineCanDraftPlan: input.canDraftPlan,
    brand: {
      name: input.brandName,
      host: null,
      languageCode: input.languageCode,
    },
    returning: input.host.summary.status !== "NONE",
    phase: "booting",
    view: null,
    seedFirst,
    // Unknown until the server answers; the default order has the same first
    // two steps as the static-first one.
    staticFirst: false,
    rev: null,
    status: "OPEN",
    appliedRev: null,
    touched: false,
    dirty: false,
    editSeq: 0,
    step: first,
    cameFrom: null,
    direction: 1,
    answers: {},
    more: false,
    lists: {},
    ideas: null,
    reached: {},
    catchUp: false,
    kindTier: 1,
    otherOpen: false,
    notQuite: false,
    returnTo: null,
    save: "idle",
    focus: { target: "title", seq: 0 },
    inline: null,
    applyStalled: false,
    announceReady: false,
    done: null,
    toast: null,
  };
  return arrive(model, first, 1);
}

function hydrate(m: Model, view: GuidedSetupView, reload: boolean): Model {
  if (m.phase === "applying") return m;
  const keepLocal = m.touched && !reload;
  let base: Model = {
    ...m,
    phase: "ready",
    view,
    brand: view.brand,
    seedFirst: view.seedFirst,
    staticFirst: view.staticFirst,
    rev: view.rev,
    status: view.status,
    ideas: view.ideas,
    appliedRev: view.status === "DONE" ? view.rev : null,
    inline: null,
  };

  const resumeCtx = (b: Model, saved: StepId | null): StepId =>
    resumeStep(saved, {
      ...flowCtx({ ...b, catchUp: false }),
      status: view.status,
      hasProfile: view.hasProfile,
      paidRun: view.ideas.attempts > 0,
    });

  if (keepLocal) {
    // The person answered while booting: their state wins, the server's flags
    // and ideas are taken, and a save goes out so the server catches up.
    const inList = stepsOf(base).includes(base.step);
    const step = inList ? base.step : resumeCtx(base, null);
    const arrived = arrive(
      { ...base, lists: base.lists },
      step,
      base.direction,
    );
    const next = edited(arrived, false);
    return step !== m.step ? focused(next, "title") : next;
  }

  base = {
    ...base,
    answers: view.answers,
    more: view.more,
    lists: {},
    reached: {},
    touched: false,
    dirty: false,
    save: "idle",
    returnTo: null,
    cameFrom: null,
    notQuite: false,
    catchUp: false,
  };
  const step = resumeCtx(base, view.step);
  const arrived = arrive(base, step, 1);
  return step !== m.step || reload ? focused(arrived, "title") : arrived;
}

export function guidedSetupReducer(m: Model, action: Action): Model {
  switch (action.type) {
    case "hydrated":
      return hydrate(m, action.view, action.reload === true);

    case "bootFailed":
      return m.phase === "booting" ? { ...m, phase: "bootError" } : m;

    case "bootRetry":
      return m.phase === "bootError" ? { ...m, phase: "booting" } : m;

    case "unavailable":
      return { ...m, phase: "unavailable" };

    case "expired":
      return { ...m, phase: "expired" };

    case "ideasUpdated":
      return withIdeas(m, action.ideas, action.from);

    case "discoverFailed":
      return { ...m, inline: { kind: "discover", retry: true } };

    case "saved": {
      const settled = action.seq >= m.editSeq;
      const withServer: Model = {
        ...m,
        rev: action.response.rev,
        status: action.response.status,
        save: settled ? "idle" : "saving",
        inline: settled && m.inline?.kind === "saveFailed" ? null : m.inline,
      };
      return withIdeas(withServer, action.response.ideas, "save");
    }

    case "saveFailed":
      return {
        ...m,
        save: "failed",
        inline: { kind: "saveFailed", retry: true },
      };

    case "applyStarted":
      return m.phase === "ready"
        ? { ...m, phase: "applying", applyStalled: false, inline: null }
        : m;

    case "applyStalled":
      return m.phase === "applying" ? { ...m, applyStalled: true } : m;

    case "applyFailed": {
      const failedInline = inlineForFailure(action);
      const late =
        action.closed === true &&
        (action.code === "PARTIAL" || action.code === "FAILED");
      const base: Model = {
        ...m,
        phase: action.code === "DISABLED" ? "unavailable" : "ready",
        applyStalled: false,
        status: action.code === "PARTIAL" ? "OPEN" : m.status,
        inline: failedInline,
      };
      return late ? withToast(base, "partial") : base;
    }

    case "applied": {
      const plan = planOf(m);
      const done = doneSummaryOf(m, plan, action.result);
      const base: Model = {
        ...m,
        phase: "done",
        status: "DONE",
        dirty: false,
        appliedRev: m.rev,
        applyStalled: false,
        inline: null,
        done,
      };
      // The pressed Approve button unmounts with the footer: Close takes focus
      // (nothing to focus when the sheet is already closed).
      return action.closed === true
        ? withToast(base, "saved")
        : focused(base, "close");
    }

    case "editSetup":
      return m.phase === "done"
        ? focused(
            {
              ...m,
              phase: "ready",
              done: null,
              step: "review",
              returnTo: null,
            },
            "title",
          )
        : m;

    default:
      return interactive(m) ? userAction(m, action) : m;
  }
}

function withToast(m: Model, kind: ToastIntent["kind"]): Model {
  return {
    ...m,
    toast: { seq: (m.toast?.seq ?? 0) + 1, kind, text: TOAST_TEXT[kind] },
  };
}

function inlineForFailure(action: {
  code: ApplyFailCode;
  saved?: ApplyPart[];
  failed?: ApplyPart[];
}): InlineNotice | null {
  switch (action.code) {
    case "STALE":
      return { kind: "stale", retry: true };
    case "ON_HOLD":
      return { kind: "onHold" };
    case "BUSY":
      return { kind: "busy" };
    case "RATE":
      return { kind: "rate" };
    case "PARTIAL":
      return {
        kind: "partial",
        retry: true,
        saved: action.saved ?? [],
        failed: action.failed ?? [],
      };
    case "FAILED":
      return { kind: "failed", retry: true };
    // NOTHING: the Approve hint already says so. DISABLED: the phase does.
    case "NOTHING":
    case "DISABLED":
      return null;
  }
}

// -----------------------------------------------------------------------------
// User actions (only while the sheet is interactive)
// -----------------------------------------------------------------------------

function userAction(m: Model, action: Action): Model {
  const q = questionOf(m.step);
  switch (action.type) {
    case "pick": {
      if (!q || isConfirm(m)) return m;
      if (!sourcesOf(m, q).some((s) => s.id === action.id)) return m;
      const spec = QUESTIONS[q];
      const answer = m.answers[q];
      let next: Answer;
      if (spec.mode === "single") {
        if (
          answer?.picked.length === 1 &&
          answer.picked[0] === action.id &&
          !answer.other &&
          !answer.skipped &&
          !answer.deferred
        ) {
          return m;
        }
        next = { picked: [action.id] };
      } else if (answer?.picked.includes(action.id)) {
        next = {
          ...answer,
          picked: answer.picked.filter((id) => id !== action.id),
        };
      } else {
        if (answerCount(answer) >= spec.max) return m;
        next = {
          ...(answer ?? { picked: [] }),
          picked: [...(answer?.picked ?? []), action.id],
        };
      }
      delete next.skipped;
      delete next.deferred;
      return commitAnswer(m, q, next, {
        otherOpen: spec.mode === "single" ? false : m.otherOpen,
      });
    }

    case "toggleOther": {
      if (!q || QUESTIONS[q].other === 0) return m;
      const spec = QUESTIONS[q];
      const answer = m.answers[q];
      if (!m.otherOpen) {
        if (spec.mode === "multi" && answerCount(answer) >= spec.max) return m;
        // Opening Other on a single question clears the pick: one answer only.
        const next =
          spec.mode === "single" ? { picked: [] as string[] } : answer;
        const opened = commitAnswer(m, q, next, { otherOpen: true });
        return focused(opened, "other");
      }
      const closed = commitAnswer(
        m,
        q,
        answer ? { ...answer, other: undefined } : undefined,
        { otherOpen: false },
      );
      return focused(closed, "otherRow");
    }

    case "otherText": {
      if (!q || !m.otherOpen) return m;
      const spec = QUESTIONS[q];
      if (spec.other === 0) return m;
      const text = clipCodePoints(action.text, spec.other);
      const answer = m.answers[q] ?? { picked: [] };
      const next: Answer = {
        ...answer,
        picked: spec.mode === "single" ? [] : answer.picked,
        other: text,
      };
      delete next.skipped;
      delete next.deferred;
      return commitAnswer(m, q, next, { otherOpen: true });
    }

    case "tier":
      return q === "business" && !isConfirm(m)
        ? { ...m, kindTier: m.kindTier === 1 ? 2 : 1 }
        : m;

    case "confirmYes": {
      if (!isConfirm(m)) return m;
      const candidate = optionsOf(m.ideas).business[0];
      if (!candidate) return m;
      const answered = commitAnswer(
        m,
        "business",
        { picked: [candidate.id] },
        { otherOpen: false },
      );
      return advance(answered);
    }

    case "confirmNo": {
      if (!isConfirm(m)) return m;
      const answer = m.answers.business;
      const staticIds = [...BUSINESS_KINDS_PRIMARY, ...BUSINESS_KINDS_MORE].map(
        (k) => k.id,
      );
      const kept = (answer?.picked ?? []).filter((id) =>
        staticIds.includes(id),
      );
      const answers = withAnswer(
        m.answers,
        "business",
        answer ? { ...answer, picked: kept } : undefined,
      );
      const base: Model = {
        ...m,
        answers,
        lists: { ...m.lists, business: "static" },
        notQuite: true,
        kindTier: tierOfAnswer(answers.business),
      };
      return focused(edited(base, !sameAnswers(m.answers, answers)), "title");
    }

    case "next": {
      if (!q) return m;
      if (isConfirm(m) || !canContinue(m)) return m;
      return advance(m);
    }

    case "skip": {
      if (!q) return m;
      const label = skipLabelOf(m);
      const stored: Answer =
        label === "Skip for now"
          ? { picked: [], deferred: true }
          : { picked: [], skipped: true };
      const skipped = commitAnswer(m, q, stored, { otherOpen: false });
      return advance(skipped);
    }

    case "back": {
      if (m.returnTo) return go({ ...m, returnTo: null }, m.returnTo, -1);
      const prev = prevStep(m.step, flowCtx(m));
      return prev ? go(m, prev, -1) : m;
    }

    case "goTo": {
      if (!stepsOf(m).includes(action.step)) return m;
      const fromReview = m.step === "review";
      return go(
        { ...m, returnTo: fromReview ? "review" : m.returnTo },
        action.step,
        1,
      );
    }

    case "addDetail": {
      if (m.step !== "checkpoint") return m;
      const more: Model = { ...m, more: true };
      const first = detailSteps(hasOptions(more.ideas, "angle"))[0];
      return first ? go(more, first, 1) : m;
    }

    case "reviewNow":
      return m.step === "checkpoint" ? go(m, "review", 1) : m;

    case "showSuggestions": {
      if (!q || !bannerVisible(m, q)) return m;
      return focused(edited(swapToIdeas(m, q), true), "title");
    }

    case "look": {
      if (m.step !== "checkpoint" && m.step !== "review") return m;
      const target = suggestionQuestions(m)[0];
      if (!target) return m;
      const swapped = swapToIdeas(m, target);
      const returnTo: ReturnTo = m.step === "review" ? "review" : "checkpoint";
      return go({ ...swapped, returnTo }, target, 1);
    }

    default:
      return m;
  }
}

// Applies an answer change, opens or closes Other, enqueues a save.
function commitAnswer(
  m: Model,
  q: QuestionId,
  answer: Answer | undefined,
  ui: { otherOpen: boolean },
): Model {
  const answers = withAnswer(m.answers, q, answer);
  const changed = !sameAnswers(m.answers, answers);
  const inline = m.inline?.kind === "pickCleared" ? null : m.inline;
  const next: Model = { ...m, answers, otherOpen: ui.otherOpen, inline };
  return changed ? edited(next, true) : { ...next, touched: true };
}

// -----------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------

function planOf(m: Model): ApplyPlan {
  return buildApplyPlan({
    answers: m.answers,
    ideas: optionsOf(m.ideas),
    goalMode: m.view?.goalMode ?? "proposed",
  });
}

function doneSummaryOf(
  m: Model,
  plan: ApplyPlan,
  result: ApplyOk,
): DoneSummary {
  const goalKey = plan.goal?.key;
  const channelKeys = plan.channels?.keys ?? [];
  const canDraft =
    m.engineCanDraftPlan &&
    Boolean(goalKey) &&
    channelKeys.some((key) => !FIRST_PLAN.excludedChannels.includes(key));
  return {
    ...(goalKey ? { goal: PLAN_GOAL_LABEL[goalKey].label } : {}),
    ...(result.goalMode === "proposed" ? { goalProposed: true } : {}),
    ...(channelKeys.length > 0
      ? { channels: channelKeys.map((key) => CHANNELS[key].label) }
      : {}),
    saved: result.unchanged
      ? []
      : result.parts.map((part) => RECEIPT_PART_LABELS[part]),
    ...(result.unconnected.length > 0
      ? { unconnected: result.unconnected }
      : {}),
    canDraftPlan: canDraft,
  };
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

export function progressOf(m: Model): Progress {
  return stepProgress(m.step, flowCtx(m));
}

export function canContinue(m: Model): boolean {
  const q = questionOf(m.step);
  if (!q || !interactive(m) || isConfirm(m)) return false;
  return isAnswered(m.answers[q]);
}

export function skipLabelOf(
  m: Model,
): "Skip" | "Skip for now" | "Not sure, you decide" | "Clear answer" {
  const q = questionOf(m.step);
  if (!q) return "Skip";
  if (m.returnTo === "review" && isAnswered(m.answers[q]))
    return "Clear answer";
  if (isPending(m, q)) return "Skip for now";
  if (QUESTIONS[q].delegate) return "Not sure, you decide";
  return "Skip";
}

export function canBack(m: Model): boolean {
  if (!interactive(m)) return false;
  return m.returnTo !== null || prevStep(m.step, flowCtx(m)) !== null;
}

// Closing is allowed in EVERY phase, applying included: the shell owns the
// in-flight action, so a hung request can never trap a keyboard user.
export function canClose(m: Model): boolean {
  void m;
  return true;
}

// Approve is disabled ONLY when there is nothing to write, when nothing changed
// since the last apply, or while applying. Never because a save is pending or
// failed: the shell flushes the queue first.
export function canApprove(m: Model): boolean {
  return m.phase === "ready" && approveHint(m) === null;
}

export function approveHint(m: Model): "empty" | "unchanged" | null {
  if (planOf(m).empty) return "empty";
  const unchanged =
    !m.dirty &&
    (m.status === "DONE" || (m.appliedRev !== null && m.rev === m.appliedRev));
  return unchanged ? "unchanged" : null;
}

// The ready-strip questions: answered from the catalog while ideas have landed.
function suggestionQuestions(m: Model): QuestionId[] {
  return checkpointSuggestions(m.answers, m.ideas, m.lists).filter(
    (q) => !(q === "business" && m.notQuite),
  );
}

export function reviewRowsOf(m: Model): ReviewRow[] {
  return planReviewRows({
    answers: m.answers,
    ideas: optionsOf(m.ideas),
    current: m.view?.current,
    more: m.more,
  });
}

// The body of the save request: only what the person actually said.
export function saveBody(
  m: Model,
): Extract<GuidedSetupRequest, { action: "save" }> {
  const answers: Answers = {};
  for (const q of QUESTION_IDS) {
    const clean = m.answers[q] ? tidy(m.answers[q]) : undefined;
    if (clean) answers[q] = clean;
  }
  return { action: "save", step: m.step, more: m.more, answers };
}

// What the chip and the "+" menu follow after a save or an apply.
export function summaryOf(m: Model): GuidedSetupSummary {
  const total = TOTAL_MAIN_QUESTIONS;
  const resolved = MAIN_QUESTIONS.filter((q) => {
    const a = m.answers[q];
    return (
      a !== undefined &&
      (isAnswered(a) || a.skipped === true || a.deferred === true)
    );
  }).length;
  return {
    status: m.status === "DONE" ? "DONE" : "OPEN",
    answered: answeredMain(m.answers),
    total,
    position: Math.min(resolved + 1, total),
    started:
      m.step !== firstStepOf(m.seedFirst) ||
      resolved > 0 ||
      (m.ideas?.attempts ?? 0) > 0,
    hasProfile: (m.view?.hasProfile ?? false) || m.status === "DONE",
  };
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

export type SegmentState = "done" | "current" | "todo";

export type IdeasLineView =
  | { kind: "offer"; host: string | null; noSite: boolean; seed?: string }
  | { kind: "retry"; reason: "failed" | "timeout" }
  | { kind: "running"; host: string | null; slow: boolean }
  | {
      kind: "ready";
      source: "profile" | "discovery";
      host: string | null;
      empty: boolean;
    }
  | {
      kind: "note";
      note: "no_input" | "busy" | "limit" | "exhausted" | "mock";
    }
  | null;

export type HeaderView = {
  title: string;
  segments: { main: SegmentState[]; detail: SegmentState[] };
  ideasLine: IdeasLineView;
  announcement: string;
};

function segmentStates(
  total: number,
  position: number | null,
  filled: number,
): SegmentState[] {
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    if (n === position) return "current";
    return n <= filled ? "done" : "todo";
  });
}

function segmentsOf(m: Model): HeaderView["segments"] {
  const progress = progressOf(m);
  const total = TOTAL_MAIN_QUESTIONS;
  const onMain = progress.group === "main" && questionOf(m.step) !== null;
  const mainPosition = onMain
    ? mainOrder(m).indexOf(m.step as never) + 1
    : null;
  const main = segmentStates(
    total,
    mainPosition,
    progress.group === "main" ? progress.index : total,
  );

  if (!m.more) return { main, detail: [] };
  const count = detailSteps(hasOptions(m.ideas, "angle")).length;
  const onDetail = progress.group === "detail";
  const detail = segmentStates(
    count,
    onDetail ? Math.max(progress.index, 1) : null,
    onDetail ? progress.index : (m.reached.detail ?? 0),
  );
  return { main, detail };
}

function hostOf(m: Model): string | null {
  return m.ideas?.host ?? m.view?.brand.host ?? m.brand.host ?? null;
}

export function ideasLineOf(m: Model): IdeasLineView {
  const ideas = m.ideas;
  if (!ideas) return null;
  switch (ideas.status) {
    case "UNAVAILABLE":
      switch (ideas.reason) {
        case "no_input":
          return { kind: "note", note: "no_input" };
        case "mock":
        case "provider":
          return { kind: "note", note: "mock" };
        case "limit":
          return { kind: "note", note: "limit" };
        case "busy":
          return { kind: "note", note: "busy" };
        default:
          // "off" (and a paused project): the slot is not rendered at all.
          return null;
      }
    case "IDLE":
      return ideas.canStart
        ? {
            kind: "offer",
            host: hostOf(m),
            noSite: hostOf(m) === null,
            ...(m.view?.seed ? { seed: m.view.seed } : {}),
          }
        : null;
    case "RUNNING":
      return {
        kind: "running",
        host: hostOf(m),
        slow: (ideas.ageSec ?? 0) >= POLL.slowAfterSec,
      };
    case "READY": {
      const o = ideas.options;
      return {
        kind: "ready",
        source: ideas.source === "discovery" ? "discovery" : "profile",
        host: hostOf(m),
        empty:
          o.business.length === 0 &&
          o.audience.length === 0 &&
          o.angle.length === 0,
      };
    }
    case "FAILED":
      if (ideas.canRetry) {
        return {
          kind: "retry",
          reason: ideas.reason === "timeout" ? "timeout" : "failed",
        };
      }
      if (ideas.reason === "busy") return { kind: "note", note: "busy" };
      if (ideas.reason === "limit") return { kind: "note", note: "limit" };
      if (ideas.reason === "mock" || ideas.reason === "provider") {
        return { kind: "note", note: "mock" };
      }
      return { kind: "note", note: "exhausted" };
  }
}

// The ONE polite status text. A catch-up carries no number, so progress never
// appears to go backwards.
export function announcementOf(m: Model): string {
  switch (m.phase) {
    case "applying":
      return "Saving your setup.";
    case "done":
      return "Setup saved.";
    case "bootError":
    case "unavailable":
    case "expired":
      return "";
    case "booting":
      if (m.returning) return "";
      break;
    case "ready":
      break;
  }
  if (m.announceReady) return "Suggestions are ready.";
  const progress = progressOf(m);
  return progress.catchUp ? "Suggestions are ready." : progress.assistive;
}

export function headerViewOf(m: Model): HeaderView {
  return {
    title: `Set up ${m.brand.name}`,
    segments: segmentsOf(m),
    ideasLine: ideasLineOf(m),
    announcement: announcementOf(m),
  };
}

// -----------------------------------------------------------------------------
// Panel view
// -----------------------------------------------------------------------------

export type StripView =
  | { kind: "ready"; source: "profile" | "discovery"; host: string | null }
  | { kind: "empty" };

export type InlineView = InlineNotice;

export type ProgressView = {
  group: "main" | "detail" | "catchup";
  index: number;
  total: number;
  assistive: string;
};

export type FooterView = {
  back: "Back" | "Back to review";
  canBack: boolean;
  skip: ReturnType<typeof skipLabelOf>;
  canContinue: boolean;
};

export type PanelView =
  | { kind: "boot" }
  | { kind: "bootError" }
  | { kind: "unavailable" }
  | { kind: "expired"; href: string }
  | {
      kind: "question";
      question: QuestionId;
      mode: "single" | "multi";
      title: string;
      help: string;
      rows: RowView[];
      tier: { current: 1 | 2; switchLabel: string } | null;
      other: { open: boolean; text: string; max: number } | null;
      // The stored profile value, shown under the question (never pre-selected).
      current?: { label: string; text: string; ai: boolean };
      count?: { picked: number; max: number };
      strip: StripView | null;
      banner: "suggestions_ready" | null;
      skeleton: boolean;
      progress: ProgressView;
      footer: FooterView;
      inline: InlineView | null;
    }
  | {
      kind: "confirm";
      title: string;
      help: string;
      candidate: { id: string; text: string; selected: boolean };
      strip: StripView | null;
      progress: ProgressView;
      footer: FooterView;
      inline: InlineView | null;
    }
  | {
      kind: "checkpoint";
      chips: ReviewChip[];
      detail: { count: 1 | 2 } | null;
      suggestions: { questions: string[] } | null;
      inline: InlineView | null;
    }
  | {
      kind: "review";
      rows: ReviewRow[];
      lines: PlanLine[];
      handsOn: { name: string; note: string } | null;
      skippedAll: boolean;
      suggestions: { questions: string[] } | null;
      approve: { state: "ready" | "saving"; hint?: "empty" | "unchanged" };
      banner: "saved" | "partial" | null;
      failed: ApplyPart[];
      help: "plain" | "discovery";
      inline: InlineView | null;
    }
  | { kind: "applying"; stalled: boolean }
  | { kind: "done"; summary: DoneSummary };

function titleOf(q: QuestionId, brand: string, confirm: boolean): string {
  switch (q) {
    case "goal":
      return "What matters most right now?";
    case "channels":
      return "Where should we show up?";
    case "business":
      return confirm
        ? `Is this what ${brand} does?`
        : `What kind of business is ${brand}?`;
    case "audience":
      return "Who do you want to reach?";
    case "tone":
      return `How should ${brand} sound?`;
    case "angle":
      return `What should people remember about ${brand}?`;
    case "guardrails":
      return `Anything ${brand} should never do?`;
  }
}

function helpOf(q: QuestionId): string {
  switch (q) {
    case "goal":
      return "Pick one. You can change it later.";
    case "channels":
      return "Pick up to 3. Connecting accounts is optional and comes later.";
    case "business":
      return "Pick the closest, or write your own.";
    case "audience":
      return "Pick up to 2.";
    case "tone":
      return "Pick one. Every post is written in this voice.";
    case "angle":
      return "Pick one. This becomes your positioning.";
    case "guardrails":
      return "Pick what applies. Your team treats these as rules.";
  }
}

function confirmHelp(m: Model): string {
  const source = m.ideas?.source;
  if (source === "profile") {
    return "We read your brand profile. Correct anything that is off.";
  }
  const host = hostOf(m);
  return host
    ? `We read ${host} and the web. Correct anything that is off.`
    : "We searched the web. Correct anything that is off.";
}

function stripOf(m: Model, q: QuestionId): StripView | null {
  const ideas = m.ideas;
  if (!ideas || (!isPendingKind(q) && q !== "angle")) return null;
  if (m.lists[q] === "ideas" && hasOptions(ideas, q)) {
    return {
      kind: "ready",
      source: ideas.source === "discovery" ? "discovery" : "profile",
      host: hostOf(m),
    };
  }
  if (ideas.status === "READY" && isPendingKind(q) && !hasOptions(ideas, q)) {
    return { kind: "empty" };
  }
  return null;
}

function currentOf(
  m: Model,
  q: QuestionId,
  confirm: boolean,
): { label: string; text: string; ai: boolean } | undefined {
  const current = m.view?.current;
  if (!current || confirm) return undefined;
  const clean = (raw: string | undefined) => cleanDisplayText(raw, CURRENT_MAX);
  switch (q) {
    case "goal": {
      const text = clean(current.goal);
      return text ? { label: "Current goal:", text, ai: false } : undefined;
    }
    case "business": {
      const text = clean(current.identity);
      return text ? { label: "Current:", text, ai: true } : undefined;
    }
    case "tone": {
      const text = clean(current.tone);
      return text ? { label: "Current:", text, ai: true } : undefined;
    }
    case "audience": {
      const parts = (current.audiences ?? [])
        .map((a) => clean(a))
        .filter((a): a is string => a !== null);
      return parts.length > 0
        ? { label: "Current:", text: parts.join(", "), ai: true }
        : undefined;
    }
    default:
      return undefined;
  }
}

function inlineOf(m: Model): InlineView | null {
  if (m.inline) return m.inline;
  return m.view && m.view.projectActive === false ? { kind: "paused" } : null;
}

function progressView(m: Model): ProgressView {
  const p = progressOf(m);
  return {
    group: p.group,
    index: p.index,
    total: p.total,
    assistive: p.assistive,
  };
}

function footerOf(m: Model): FooterView {
  return {
    back: m.returnTo === "review" ? "Back to review" : "Back",
    canBack: canBack(m),
    skip: skipLabelOf(m),
    canContinue: canContinue(m),
  };
}

function suggestionLabels(m: Model): { questions: string[] } | null {
  const questions = suggestionQuestions(m).map((q) =>
    q === "business" ? `What ${m.brand.name} does` : "Audience",
  );
  return questions.length > 0 ? { questions } : null;
}

const PANEL_QUESTION: Record<string, true> = Object.fromEntries(
  QUESTION_IDS.map((q) => [q, true]),
);

export function panelViewOf(m: Model): PanelView {
  switch (m.phase) {
    case "bootError":
      return { kind: "bootError" };
    case "unavailable":
      return { kind: "unavailable" };
    case "expired":
      return {
        kind: "expired",
        href: `/login?callbackUrl=${encodeURIComponent(
          `/projects/${m.projectId}?guide=setup`,
        )}`,
      };
    case "applying":
      return { kind: "applying", stalled: m.applyStalled };
    case "done":
      return {
        kind: "done",
        summary: m.done ?? { saved: [], canDraftPlan: false },
      };
    case "booting":
      // A returning person sees a neutral skeleton, never question 1.
      if (m.returning) return { kind: "boot" };
      break;
    case "ready":
      break;
  }

  if (m.step === "checkpoint") {
    const rows = reviewRowsOf(m).filter((row) =>
      (MAIN_QUESTIONS as readonly string[]).includes(row.question),
    );
    const count = detailSteps(hasOptions(m.ideas, "angle")).length;
    return {
      kind: "checkpoint",
      chips: rows.flatMap((row) => (row.state === "answered" ? row.chips : [])),
      detail: { count: count === 1 ? 1 : 2 },
      suggestions: suggestionLabels(m),
      inline: inlineOf(m),
    };
  }

  if (m.step === "review") {
    const plan = planOf(m);
    const hint = approveHint(m);
    const partial = m.inline?.kind === "partial" ? m.inline : null;
    const settled = !m.dirty && m.status === "DONE";
    const handsOn = m.view?.handsOn ? HANDS_ON_LABEL[m.view.handsOn] : null;
    return {
      kind: "review",
      rows: reviewRowsOf(m),
      lines: plan.lines,
      handsOn,
      skippedAll: allMainSkipped(m.answers),
      suggestions: suggestionLabels(m),
      approve: {
        state: m.save === "saving" ? "saving" : "ready",
        ...(hint ? { hint } : {}),
      },
      banner: partial ? "partial" : settled ? "saved" : null,
      failed: partial?.failed ?? [],
      help: m.ideas?.source === "discovery" ? "discovery" : "plain",
      inline: inlineOf(m),
    };
  }

  const q = questionOf(m.step);
  if (!q || !PANEL_QUESTION[q]) return { kind: "boot" };
  const confirm = isConfirm(m);
  const brand = m.brand.name;

  if (confirm) {
    const candidate = optionsOf(m.ideas).business[0];
    return {
      kind: "confirm",
      title: titleOf(q, brand, true),
      help: confirmHelp(m),
      candidate: {
        id: candidate?.id ?? "",
        text: candidate?.label ?? "",
        selected: candidate
          ? m.answers.business?.picked.includes(candidate.id) === true
          : false,
      },
      strip: stripOf(m, q),
      progress: progressView(m),
      footer: footerOf(m),
      inline: inlineOf(m),
    };
  }

  const spec = QUESTIONS[q];
  const skeleton = isPending(m, q);
  const answer = m.answers[q];
  const current = currentOf(m, q, false);
  return {
    kind: "question",
    question: q,
    mode: spec.mode,
    title: titleOf(q, brand, false),
    help: helpOf(q),
    rows: rowsOf(m, q),
    tier:
      q === "business" && !skeleton && m.lists.business !== "ideas"
        ? {
            current: m.kindTier,
            switchLabel: m.kindTier === 1 ? "More types" : "Common types",
          }
        : null,
    other:
      spec.other > 0
        ? { open: m.otherOpen, text: answer?.other ?? "", max: spec.other }
        : null,
    ...(current ? { current } : {}),
    ...(spec.mode === "multi"
      ? { count: { picked: answerCount(answer), max: spec.max } }
      : {}),
    strip: stripOf(m, q),
    banner: bannerVisible(m, q) ? "suggestions_ready" : null,
    skeleton,
    progress: progressView(m),
    footer: footerOf(m),
    inline: inlineOf(m),
  };
}

// -----------------------------------------------------------------------------
// The apply flow (a shell command, not a reducer action)
// -----------------------------------------------------------------------------

// Maps the action's outcome to a reducer action. `null` = the call threw (a
// signed-out redirect, a deploy-skew "Failed to find Server Action"): the same
// as an unexpected failure.
export function applyOutcomeAction(
  result: ApplyResult | null,
  closed: boolean,
): Action {
  if (result === null) return { type: "applyFailed", code: "FAILED", closed };
  if (result.ok) return { type: "applied", result, closed };
  return {
    type: "applyFailed",
    code: result.code,
    saved: result.saved,
    failed: result.failed,
    closed,
  };
}

export type ApproveDeps = {
  getModel: () => Model;
  dispatch: (action: Action) => void;
  // Flushes the save queue; false when the flush failed.
  flush: () => Promise<boolean>;
  // The Server Action; may throw.
  apply: (expectedRev: string) => Promise<ApplyResult>;
  // Runs `fn` after `ms` and returns a canceller (the shell owns the clock).
  schedule: (ms: number, fn: () => void) => () => void;
  // The sheet is closed right now (decides toast versus inline).
  isClosed: () => boolean;
};

// Approve: flush the save queue first (never disable the button for a network
// state), stop with the inline alert when the flush fails, otherwise apply and
// report the outcome. Retry is the same call.
export async function runApprove(deps: ApproveDeps): Promise<void> {
  if (!canApprove(deps.getModel())) return;
  const flushed = await deps.flush();
  if (!flushed) {
    deps.dispatch({ type: "saveFailed" });
    return;
  }
  const model = deps.getModel();
  if (!canApprove(model) || model.rev === null) return;
  deps.dispatch({ type: "applyStarted" });
  const cancel = deps.schedule(APPLY_UI.stalledAfterMs, () =>
    deps.dispatch({ type: "applyStalled" }),
  );
  let result: ApplyResult | null;
  try {
    result = await deps.apply(model.rev);
  } catch {
    result = null;
  }
  cancel();
  deps.dispatch(applyOutcomeAction(result, deps.isClosed()));
}
