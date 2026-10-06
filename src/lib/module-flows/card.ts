// The card a module flow lives on in the chat (docs/modules.md): Ads Manager,
// Analytics and SEO Manager each run their standard steps (Brief -> Plan ->
// Create -> Review -> Deliver) on ONE card that changes in place, so a module
// Work reads top to bottom like the Social Media Planner's plan card. Each
// module owns its `data` (components/module-flows/<module>, server/modules/
// <module>); this file only fixes the envelope. Pure and isomorphic.

export const FLOW_MODULES = ["ads", "analytics", "seo"] as const;
export type FlowModuleKey = (typeof FLOW_MODULES)[number];

export const MODULE_FLOW_STEPS = [
  "brief",
  "plan",
  "create",
  "review",
  "deliver",
] as const;
export type ModuleFlowStep = (typeof MODULE_FLOW_STEPS)[number];

export type ModuleFlowCardData = {
  kind: "module-flow";
  module: FlowModuleKey;
  title: string;
  step: ModuleFlowStep;
  // The module's own state. Stored JSON: each module validates what it reads
  // and never trusts a shape it did not write.
  data: Record<string, unknown>;
};

export function isFlowModuleKey(value: unknown): value is FlowModuleKey {
  return (FLOW_MODULES as readonly unknown[]).includes(value);
}

export function isModuleFlowStep(value: unknown): value is ModuleFlowStep {
  return (MODULE_FLOW_STEPS as readonly unknown[]).includes(value);
}

export function isModuleFlowCard(value: unknown): value is ModuleFlowCardData {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<ModuleFlowCardData>;
  return (
    card.kind === "module-flow" &&
    isFlowModuleKey(card.module) &&
    typeof card.title === "string" &&
    isModuleFlowStep(card.step) &&
    !!card.data &&
    typeof card.data === "object" &&
    !Array.isArray(card.data)
  );
}

// A new flow starts at its brief with nothing decided yet.
export function newModuleFlowCard(
  module: FlowModuleKey,
  title: string,
): ModuleFlowCardData {
  return { kind: "module-flow", module, title, step: "brief", data: {} };
}

// What the place a flow was opened from already knew (card.data.hint): the
// post "Boost with an ad" names, the idea "Write this article" starts from
// (docs/ideas.md) and that idea's topic. Read defensively: stored JSON.
export type ModuleFlowHintData = {
  sourceCreativeId?: string;
  ideaId?: string;
  topic?: string;
};

const HINT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function flowHintOf(data: unknown): ModuleFlowHintData {
  const hint =
    data && typeof data === "object"
      ? (data as { hint?: unknown }).hint
      : undefined;
  if (!hint || typeof hint !== "object") return {};
  const raw = hint as Record<string, unknown>;
  const out: ModuleFlowHintData = {};
  if (typeof raw.sourceCreativeId === "string" && HINT_ID.test(raw.sourceCreativeId)) {
    out.sourceCreativeId = raw.sourceCreativeId;
  }
  if (typeof raw.ideaId === "string" && HINT_ID.test(raw.ideaId)) out.ideaId = raw.ideaId;
  if (typeof raw.topic === "string" && raw.topic.trim()) {
    out.topic = raw.topic.trim().slice(0, 200);
  }
  return out;
}
