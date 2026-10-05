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
