// Guided setup: the apply plan and the Review rows (spec 9.1, 3.5).
//
// ONE pure function feeds the Review screen and the writers, so Review cannot
// promise something the saga does not do. It runs on the client (Review) and on
// the server (Approve recomputes it from the stored session and ideas row), and
// both must produce the same plan for the same inputs: no clock, no randomness,
// no IO. Every string that leaves here is (a) a catalog label, (b) a stored
// option label from the ideas row passed in, or (c) the person's own typed words
// cleaned again by cleanUserText (defence in depth: normalizeAnswers already did).
// A skipped or deferred answer produces nothing, whatever else it carries.

import {
  CHANNELS,
  PLAN_GOAL_LABEL,
  type ChannelKey,
} from "@/lib/content-channels";

import {
  AUDIENCE_SEGMENTS,
  BUSINESS_KINDS,
  CURRENT_MAX,
  DETAIL_QUESTIONS,
  GOAL_PRESETS,
  GUARDRAILS,
  MAIN_QUESTIONS,
  QUESTIONS,
  TONES,
  channelFromOptionId,
  goalFromOptionId,
  isAnswered,
  isResolved,
  type Answer,
  type Answers,
  type ApplyPlan,
  type CurrentValues,
  type GoalMode,
  type IdeaOptions,
  type Option,
  type PlanLine,
  type PlanProfile,
  type PlanRule,
  type QuestionId,
  type ReviewChip,
  type ReviewRow,
  type StaticOption,
} from "./contract";
import { cleanDisplayText, cleanUserText, foldLabel } from "./sanitize";

const STATIC_LISTS: Partial<Record<QuestionId, readonly StaticOption[]>> = {
  business: BUSINESS_KINDS,
  audience: AUDIENCE_SEGMENTS,
  tone: TONES,
  guardrails: GUARDRAILS,
};

type IdeasKey = "business" | "audience" | "angle";
const isIdeasKey = (q: QuestionId): q is IdeasKey =>
  q === "business" || q === "audience" || q === "angle";

// The label the person saw for an option id, or null when the id is not one of
// the catalogs or the stored ideas options (it is then dropped, never shown).
function chipForId(
  question: QuestionId,
  id: string,
  ideas: IdeaOptions,
): ReviewChip | null {
  if (question === "goal") {
    const goal = goalFromOptionId(id);
    return goal ? { text: PLAN_GOAL_LABEL[goal].label } : null;
  }
  if (question === "channels") {
    const channel = channelFromOptionId(id);
    return channel ? { text: CHANNELS[channel].label } : null;
  }
  const fixed = STATIC_LISTS[question]?.find((option) => option.id === id);
  if (fixed) return { text: fixed.label };
  if (isIdeasKey(question)) {
    const stored = ideas[question].find((option) => option.id === id);
    if (stored) return { text: stored.label, ai: true };
  }
  return null;
}

// Chips for one answer, in the order the person chose them, typed words last.
function chipsOf(
  question: QuestionId,
  answer: Answer | undefined,
  ideas: IdeaOptions,
): ReviewChip[] {
  if (!answer || answer.skipped === true || answer.deferred === true) return [];
  const spec = QUESTIONS[question];

  const typed = spec.other > 0 ? cleanUserText(answer.other, spec.other) : null;

  const picks: ReviewChip[] = [];
  const seen = new Set<string>();
  for (const id of answer.picked) {
    if (seen.has(id)) continue;
    seen.add(id);
    const chip = chipForId(question, id, ideas);
    if (chip) picks.push(chip);
  }
  // Typed words count as one pick: over the cap, trailing picks go first (so on
  // a single-choice question typed words replace the pick).
  const room = Math.max(spec.max - (typed ? 1 : 0), 0);
  const kept = picks.slice(0, room);
  return typed ? [...kept, { text: typed }] : kept;
}

export function resolveAnswerLabels(
  question: QuestionId,
  answer: Answer | undefined,
  ideas: IdeaOptions,
): string[] {
  return chipsOf(question, answer, ideas).map((chip) => chip.text);
}

// Main questions holding a real answer (skipped and deferred do not count).
export function answeredMain(answers: Answers): number {
  return MAIN_QUESTIONS.filter((q) => isAnswered(answers[q])).length;
}

// -----------------------------------------------------------------------------
// The plan
// -----------------------------------------------------------------------------

export function buildApplyPlan({
  answers,
  ideas,
  goalMode = "proposed",
}: {
  answers: Answers;
  ideas: IdeaOptions;
  goalMode?: GoalMode;
}): ApplyPlan {
  const labels = (q: QuestionId) => resolveAnswerLabels(q, answers[q], ideas);

  // Profile: what the business does, audience, positioning, voice.
  const profile: PlanProfile = {};
  const [identity] = labels("business");
  if (identity) profile.identity = identity;
  const audiences = labels("audience");
  if (audiences.length > 0) profile.audiences = audiences;
  const [positioning] = labels("angle");
  if (positioning) profile.positioning = positioning;
  const [toneOfVoice] = labels("tone");
  if (toneOfVoice) profile.toneOfVoice = toneOfVoice;
  const profileParts = [
    profile.identity ? "what you do" : null,
    profile.audiences ? "audience" : null,
    profile.positioning ? "positioning" : null,
    profile.toneOfVoice ? "voice" : null,
  ].filter((part): part is string => part !== null);

  // Goal: title and metricKey are code, never the person's or the model's text.
  const goalKey = (
    answers.goal?.skipped === true || answers.goal?.deferred === true
      ? []
      : (answers.goal?.picked ?? [])
  )
    .map((id) => goalFromOptionId(id))
    .find((key) => key !== null);
  const goal = goalKey
    ? { key: goalKey, ...GOAL_PRESETS[goalKey], mode: goalMode }
    : null;

  // Channels: at most QUESTIONS.channels.max, catalog order of the taps.
  const channelKeys: ChannelKey[] = [];
  if (
    answers.channels &&
    answers.channels.skipped !== true &&
    answers.channels.deferred !== true
  ) {
    for (const id of answers.channels.picked) {
      const key = channelFromOptionId(id);
      if (key && !channelKeys.includes(key)) channelKeys.push(key);
    }
  }
  const focus = channelKeys.slice(0, QUESTIONS.channels.max);
  const channels =
    focus.length > 0
      ? {
          keys: focus,
          memoryLine: `Focus channels: ${focus
            .map((key) => CHANNELS[key].label)
            .join(", ")}.`,
        }
      : null;

  // Guardrails: preset labels ARE the rule text; typed rules become rule rows
  // only and never enter the memory line.
  const rules: PlanRule[] = [];
  const seenRules = new Set<string>();
  const addRule = (rule: PlanRule) => {
    const key = foldLabel(rule.text);
    if (!key || seenRules.has(key)) return;
    seenRules.add(key);
    rules.push(rule);
  };
  const guardAnswer = answers.guardrails;
  const guardChips = chipsOf("guardrails", guardAnswer, ideas);
  const presetLabels = new Set(GUARDRAILS.map((option) => option.label));
  for (const chip of guardChips) {
    addRule({
      text: chip.text,
      source: presetLabels.has(chip.text) ? "preset" : "typed",
    });
  }
  const presets = rules.filter((rule) => rule.source === "preset");
  const guardrails =
    rules.length > 0
      ? {
          rules,
          memoryLine:
            presets.length > 0
              ? `Never: ${presets
                  .map((rule) => rule.text.replace(/^Never\s+/u, ""))
                  .join("; ")}.`
              : null,
        }
      : null;

  const lines: PlanLine[] = [];
  if (profileParts.length > 0) {
    lines.push({
      part: "profile",
      text: `Saves your brand profile: ${profileParts.join(", ")}`,
    });
  }
  if (goal && goalKey) {
    lines.push({
      part: "goal",
      text:
        goal.mode === "active"
          ? `Sets your goal: ${PLAN_GOAL_LABEL[goalKey].label}. Your agency will work toward it.`
          : "Adds your goal as a proposal: approve it in Strategy.",
    });
  }
  if (channels) {
    lines.push({
      part: "channels",
      text: `Remembers your channel focus: ${focus
        .map((key) => CHANNELS[key].label)
        .join(", ")}`,
    });
  }
  if (guardrails) {
    lines.push({
      part: "guardrails",
      text: `Adds ${guardrails.rules.length} ${
        guardrails.rules.length === 1 ? "rule" : "rules"
      } your team always follows (existing rules stay)`,
    });
  }

  return {
    profile: profileParts.length > 0 ? profile : null,
    goal,
    channels,
    guardrails,
    lines,
    empty: lines.length === 0,
  };
}

// -----------------------------------------------------------------------------
// Review rows
// -----------------------------------------------------------------------------

// What the stored profile already holds for a question ("Current: ..."), shown
// only for a question left unanswered. Display-cleaned again: it is never stored.
function currentChips(
  question: QuestionId,
  current: CurrentValues | undefined,
): ReviewChip[] {
  if (!current) return [];
  const clean = (raw: string | undefined, ai: boolean): ReviewChip[] => {
    const text = cleanDisplayText(raw, CURRENT_MAX);
    return text ? [ai ? { text, ai: true } : { text }] : [];
  };
  switch (question) {
    case "goal":
      return clean(current.goal, false);
    case "business":
      return clean(current.identity, true);
    case "tone":
      return clean(current.tone, true);
    case "audience":
      return (current.audiences ?? []).flatMap((value) => clean(value, true));
    default:
      return [];
  }
}

export function reviewRowsOf({
  answers,
  ideas,
  current,
  more = false,
}: {
  answers: Answers;
  ideas: IdeaOptions;
  // Live channel rows of the view: ids and labels come from the catalog, so
  // they are accepted for call-site symmetry and not read.
  channels?: readonly Option[];
  current?: CurrentValues;
  // "Add more detail" was tapped: the detail rows are part of the flow.
  more?: boolean;
}): ReviewRow[] {
  const questions: QuestionId[] = [
    ...MAIN_QUESTIONS,
    ...DETAIL_QUESTIONS.filter((q) => {
      if (isResolved(answers[q])) return true;
      if (!more) return false;
      // "angle" only exists when the ideas hold options for it.
      return q !== "angle" || ideas.angle.length > 0;
    }),
  ];

  return questions.map((question): ReviewRow => {
    const answer = answers[question];
    const chips = chipsOf(question, answer, ideas);
    if (chips.length > 0) return { question, state: "answered", chips };

    if (answer?.skipped === true || answer?.deferred === true) {
      return {
        question,
        state: QUESTIONS[question].delegate ? "delegated" : "skipped",
        chips: [],
      };
    }
    const held = currentChips(question, current);
    if (held.length > 0) return { question, state: "current", chips: held };
    return { question, state: "unanswered", chips: [] };
  });
}
