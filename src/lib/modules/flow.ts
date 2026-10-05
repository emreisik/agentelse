import { progressOf } from "@/lib/works/plan-pane";
import type { IdeaEventCardData } from "@/types/idea-event-card";

import { MODULES, type ModuleKey } from "./catalog";

// The standard steps every module walks (plan P4): Brief -> Plan -> Create ->
// Review -> Deliver, with one stepper and one card language. Only the last
// step's verb differs per module ("Publish", "Launch", "Share"). Pure.

export const FLOW_STEPS = [
  "brief",
  "plan",
  "create",
  "review",
  "deliver",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];
export type FlowStepState = "done" | "current" | "todo";

const STEP_LABELS: Readonly<Record<Exclude<FlowStep, "deliver">, string>> = {
  brief: "Brief",
  plan: "Plan",
  create: "Create",
  review: "Review",
};

export function isFlowStep(value: unknown): value is FlowStep {
  return (
    typeof value === "string" &&
    (FLOW_STEPS as readonly string[]).includes(value)
  );
}

export function flowStepLabel(step: FlowStep, module: ModuleKey): string {
  return step === "deliver" ? MODULES[module].deliverLabel : STEP_LABELS[step];
}

// The stepper's row for a module, in order.
export function flowStepsOf(
  module: ModuleKey,
): { key: FlowStep; label: string }[] {
  return FLOW_STEPS.map((key) => ({ key, label: flowStepLabel(key, module) }));
}

// One state per step: the steps before the current one are done, the ones
// after it still to do. `complete` (everything delivered) marks all done.
export function flowStatesOf(
  current: FlowStep,
  options: { complete?: boolean } = {},
): Record<FlowStep, FlowStepState> {
  const at = FLOW_STEPS.indexOf(current);
  const states = {} as Record<FlowStep, FlowStepState>;
  FLOW_STEPS.forEach((step, index) => {
    states[step] = options.complete
      ? "done"
      : index < at
        ? "done"
        : index === at
          ? "current"
          : "todo";
  });
  return states;
}

// ---- Social Media Planner ------------------------------------------------------

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;

// Where a social Work stands, from its plan card (the newest one): no plan yet
// is the brief; a draft is the plan; once saved, pieces still to make (or being
// made) are the create step, content waiting for a decision the review, and
// with nothing left to decide the plan is delivered. A plan whose pieces were
// all declined stays in review (nothing goes out).
export function socialFlowStep(card?: PlanCard | null): FlowStep {
  if (!card) return "brief";
  const progress = progressOf(card);
  if (progress.draft) return "plan";
  if (progress.total === 0) return "create";
  if (progress.producible > 0 || progress.making > 0) return "create";
  if (progress.ready > 0) return "review";
  return progress.approved > 0 ? "deliver" : "review";
}

// Every live piece of the saved plan is out: the flow is complete.
export function socialFlowComplete(card?: PlanCard | null): boolean {
  if (!card || card.state !== "saved" || !card.slots) return false;
  const live = card.slots.filter((slot) => slot && !slot.excluded);
  return live.length > 0 && live.every((slot) => slot?.stage === "PUBLISHED");
}
