// Guided setup: step order, progress, catch-up and resume (spec 3.2 to 3.4).
//
// Pure and isomorphic on purpose: no Date, no randomness, no IO. The client
// reducer and the server (resume on `start`) call the same functions, so the two
// can never disagree about which step comes next. The ORDER of the steps depends
// only on the two flags stored once on the session row (seedFirst, staticFirst)
// and on `more`; the ideas only decide whether the optional "angle" step exists.

import {
  DETAIL_QUESTIONS,
  MAIN_QUESTIONS,
  QUESTIONS,
  TOTAL_MAIN_QUESTIONS,
  isAnswered,
  isResolved,
  type Answers,
  type IdeaOptions,
  type QuestionId,
  type SessionStatus,
  type StepId,
} from "./contract";

// "ideas" = the list the person sees is the AI/profile list, "static" = the
// catalog. Frozen per question by the reducer the first time the step renders.
export type ListKind = "ideas" | "static";
export type Lists = Partial<Record<QuestionId, ListKind>>;

// The two flags stored ONCE on the session row.
export type FlowFlags = { seedFirst: boolean; staticFirst: boolean };

// Anything that carries the stored options (IdeasView and IdeasRecord both fit).
// Options only exist for a READY row, so "has options" means "ideas landed".
export type IdeasLike = { options: IdeaOptions } | null | undefined;

export type StepListInput = FlowFlags & {
  more: boolean;
  hasAngleOptions: boolean;
};

// Highest segment filled so far, per group. Owned by the reducer; progressOf
// folds it in so the fill never goes backwards.
export type Reached = { main?: number; detail?: number };

export type FlowCtx = FlowFlags & {
  more: boolean;
  answers?: Answers;
  ideas?: IdeasLike;
  lists?: Lists;
  reached?: Reached;
  // The step the person opened Review from (Back returns there).
  cameFrom?: StepId | null;
};

export type Progress = {
  group: "main" | "detail" | "catchup";
  // Segments filled (never decreases when `reached` is passed in).
  index: number;
  total: number;
  // The one polite status text; a catch-up carries no number.
  assistive: string;
  catchUp: boolean;
};

export type MainQuestion = (typeof MAIN_QUESTIONS)[number];

const RESEARCH_FED = MAIN_QUESTIONS.filter((q) => QUESTIONS[q].ideas);

type IdeasKey = "business" | "audience" | "angle";
const isIdeasKey = (q: QuestionId): q is IdeasKey =>
  q === "business" || q === "audience" || q === "angle";

function ideasReadyFor(question: QuestionId, ideas: IdeasLike): boolean {
  if (!ideas || !isIdeasKey(question)) return false;
  return ideas.options[question].length > 0;
}

function isMainStep(step: StepId): step is MainQuestion {
  return (MAIN_QUESTIONS as readonly string[]).includes(step);
}

function isDetailStep(step: StepId): step is (typeof DETAIL_QUESTIONS)[number] {
  return (DETAIL_QUESTIONS as readonly string[]).includes(step);
}

// -----------------------------------------------------------------------------
// Order
// -----------------------------------------------------------------------------

// The first question in EVERY order: business when there is nothing to research
// from (its answer is what a paid run needs), else goal.
export function firstStepOf(seedFirst: boolean): "business" | "goal" {
  return seedFirst ? "business" : "goal";
}

export function mainOrder({
  seedFirst,
  staticFirst,
}: FlowFlags): MainQuestion[] {
  // staticFirst: the research-fed questions go LAST so a 30-60 s run has the
  // whole flow to land before the person reaches them.
  const base: MainQuestion[] = staticFirst
    ? ["goal", "channels", "tone", "business", "audience"]
    : ["goal", "channels", "business", "audience", "tone"];
  if (!seedFirst) return base;
  return ["business", ...base.filter((q) => q !== "business")];
}

// "angle" has no static catalog: the step exists only when options do.
export function detailSteps(hasAngleOptions: boolean): QuestionId[] {
  return hasAngleOptions ? ["angle", "guardrails"] : ["guardrails"];
}

export function stepsFor({
  seedFirst,
  staticFirst,
  more,
  hasAngleOptions,
}: StepListInput): StepId[] {
  return [
    ...mainOrder({ seedFirst, staticFirst }),
    "checkpoint",
    ...(more ? detailSteps(hasAngleOptions) : []),
    "review",
  ];
}

function listOf(ctx: FlowCtx): StepId[] {
  return stepsFor({
    seedFirst: ctx.seedFirst,
    staticFirst: ctx.staticFirst,
    more: ctx.more,
    hasAngleOptions: ideasReadyFor("angle", ctx.ideas),
  });
}

// -----------------------------------------------------------------------------
// The business question: one answer, two modes (spec 3.3)
// -----------------------------------------------------------------------------

export type BusinessModeInput = {
  lists: Lists;
  ideas: { options: Pick<IdeaOptions, "business"> } | null | undefined;
};

// confirm: the list is frozen to the ideas and exactly one sentence exists.
// "Not quite" (list mode) is the reducer freezing the list to "static".
export function businessMode(input: BusinessModeInput): "confirm" | "list" {
  return input.lists.business === "ideas" &&
    input.ideas?.options.business.length === 1
    ? "confirm"
    : "list";
}

// -----------------------------------------------------------------------------
// Skipped-everything, catch-up, checkpoint suggestions
// -----------------------------------------------------------------------------

function allMainResolved(answers: Answers | undefined): boolean {
  return MAIN_QUESTIONS.every((q) => isResolved(answers?.[q]));
}

// All five questions were dealt with and none holds an answer: the checkpoint
// has nothing to show, so the flow goes straight to Review.
export function allMainSkipped(answers: Answers | undefined): boolean {
  return (
    allMainResolved(answers) &&
    MAIN_QUESTIONS.every((q) => !isAnswered(answers?.[q]))
  );
}

// A research-fed question skipped with "Skip for now" while its list was pending
// and whose ideas have landed since: offered ONCE more before the checkpoint
// (the reducer turns a second skip into `skipped`). A list already frozen to the
// ideas was seen, so it is not offered again.
export function catchUpQuestions(
  answers: Answers | undefined,
  ideas: IdeasLike,
  lists: Lists | undefined,
): MainQuestion[] {
  return RESEARCH_FED.filter((q) => {
    const answer = answers?.[q];
    return (
      answer?.deferred === true &&
      !isAnswered(answer) &&
      lists?.[q] !== "ideas" &&
      ideasReadyFor(q, ideas)
    );
  });
}

// Research-fed questions that were ANSWERED from a static list while ideas are
// now ready for them: feeds the checkpoint and the Review "Look" row, so a quick
// person is not stuck with a generic stored identity.
export function checkpointSuggestions(
  answers: Answers | undefined,
  ideas: IdeasLike,
  lists: Lists | undefined,
): MainQuestion[] {
  return RESEARCH_FED.filter(
    (q) =>
      isAnswered(answers?.[q]) &&
      lists?.[q] === "static" &&
      ideasReadyFor(q, ideas),
  );
}

// Derived, not stored: a deferred question with landed ideas, seen after every
// main question was dealt with, is the catch-up visit.
function isCatchUpVisit(step: StepId, ctx: FlowCtx): boolean {
  return (
    isMainStep(step) &&
    allMainResolved(ctx.answers) &&
    catchUpQuestions(ctx.answers, ctx.ideas, ctx.lists).includes(step)
  );
}

// -----------------------------------------------------------------------------
// Navigation
// -----------------------------------------------------------------------------

// null after Review (there is no next) and for a step outside the current list.
export function nextStep(step: StepId, ctx: FlowCtx): StepId | null {
  if (step === "review") return null;
  const skipCheckpoint = allMainSkipped(ctx.answers);

  if (isMainStep(step)) {
    const order = mainOrder(ctx);
    const at = order.indexOf(step);
    const candidates = catchUpQuestions(ctx.answers, ctx.ideas, ctx.lists);
    const afterMain: StepId = skipCheckpoint ? "review" : "checkpoint";

    if (isCatchUpVisit(step, ctx)) {
      const later = candidates.find((q) => order.indexOf(q) > at);
      return later ?? afterMain;
    }
    const following = order[at + 1];
    if (following) return following;
    return candidates.find((q) => q !== step) ?? afterMain;
  }

  const list = listOf(ctx);
  const at = list.indexOf(step);
  if (at < 0) return null;
  return list[at + 1] ?? null;
}

// null on the first step. From Review it returns the step the person came from
// when known, else the step before it in the list.
export function prevStep(step: StepId, ctx: FlowCtx): StepId | null {
  const skipCheckpoint = allMainSkipped(ctx.answers);
  const list = listOf(ctx).filter(
    (s) => !(s === "checkpoint" && skipCheckpoint),
  );
  if (step === "review" && ctx.cameFrom && ctx.cameFrom !== "review") {
    if (list.includes(ctx.cameFrom)) return ctx.cameFrom;
  }
  const at = list.indexOf(step);
  return at > 0 ? (list[at - 1] ?? null) : null;
}

// -----------------------------------------------------------------------------
// Resume
// -----------------------------------------------------------------------------

export type ResumeCtx = FlowCtx & {
  status: SessionStatus;
  // An ACTIVE, non-mock constitution exists.
  hasProfile: boolean;
  // A paid discovery run was ever claimed for this project.
  paidRun: boolean;
};

// Where the sheet opens. A saved step is trusted only while it is still in the
// current list; a stale one (e.g. "angle" after the options vanished) clamps.
export function resumeStep(saved: StepId | null, ctx: ResumeCtx): StepId {
  if (ctx.status === "DONE") return "review";

  const answers = ctx.answers;
  const skippedAll = allMainSkipped(answers);
  const untouched =
    !MAIN_QUESTIONS.some((q) => isResolved(answers?.[q])) &&
    !DETAIL_QUESTIONS.some((q) => isResolved(answers?.[q]));
  const neverLeftFirst = saved === null || saved === firstStepOf(ctx.seedFirst);

  // "Update your setup": an established project, nothing answered, nothing begun.
  if (ctx.hasProfile && untouched && neverLeftFirst && !ctx.paidRun) {
    return "review";
  }

  if (saved && listOf(ctx).includes(saved)) {
    return saved === "checkpoint" && skippedAll ? "review" : saved;
  }

  const firstOpen = mainOrder(ctx).find((q) => !isResolved(answers?.[q]));
  if (firstOpen) return firstOpen;
  return skippedAll ? "review" : "checkpoint";
}

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------

export function progressOf(step: StepId, ctx: FlowCtx): Progress {
  const total = TOTAL_MAIN_QUESTIONS;
  const reachedMain = ctx.reached?.main ?? 0;

  if (isMainStep(step)) {
    if (isCatchUpVisit(step, ctx)) {
      return {
        group: "catchup",
        index: Math.max(total, reachedMain),
        total,
        assistive: "Suggestions ready",
        catchUp: true,
      };
    }
    const position = mainOrder(ctx).indexOf(step) + 1;
    return {
      group: "main",
      index: Math.max(position, reachedMain),
      total,
      assistive: `Question ${position} of ${total}`,
      catchUp: false,
    };
  }

  if (isDetailStep(step)) {
    const details = detailSteps(ideasReadyFor("angle", ctx.ideas));
    const position = Math.max(details.indexOf(step), 0) + 1;
    return {
      group: "detail",
      index: Math.max(position, ctx.reached?.detail ?? 0),
      total: details.length,
      assistive: `Extra question ${position} of ${details.length}`,
      catchUp: false,
    };
  }

  // checkpoint and review: every main segment is filled.
  return {
    group: "main",
    index: Math.max(total, reachedMain),
    total,
    assistive: "Review",
    catchUp: false,
  };
}

// The reducer folds each new progress into `reached` so the header never shows
// a segment emptying after Back.
export function bumpReached(reached: Reached, progress: Progress): Reached {
  if (progress.group === "detail") {
    return {
      ...reached,
      detail: Math.max(reached.detail ?? 0, progress.index),
    };
  }
  return { ...reached, main: Math.max(reached.main ?? 0, progress.index) };
}
