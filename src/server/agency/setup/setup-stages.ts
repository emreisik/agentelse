import type { CapabilityKey } from "@prisma/client";

// Pure stage metadata for the 12-stage Setup Mode (spec section 5). The
// orchestrator owns all side effects; this module only describes the plan.

// The parallel research fan-out of DEEP_DISCOVERY (spec section 6).
// Website Research = WEB_RESEARCH; Customer Research = CUSTOMER_INTELLIGENCE.
export const DEEP_DISCOVERY_CAPABILITIES: CapabilityKey[] = [
  "BRAND_DISCOVERY",
  "WEB_RESEARCH",
  "COMPETITOR_RESEARCH",
  "MARKET_RESEARCH",
  "CUSTOMER_INTELLIGENCE",
  "SEO_RESEARCH",
];

// Discovery completes when >=80% of research tasks are terminal and at least
// one actually completed (spec: controlled progression, not all-or-nothing).
export const DISCOVERY_COMPLETION_RATIO = 0.8;

export function discoveryResearchRequest(
  capability: CapabilityKey,
  brandName: string,
  domain?: string,
): string {
  const target = domain ? `${brandName} (${domain})` : brandName;
  return `Deep discovery ${capability.toLowerCase().replace(/_/g, " ")} for ${target}`;
}

// How a setup runs. FULL is the original 12-stage onboarding, still what the
// setup panel and the legacy chat start. ENRICHMENT is the optional deep
// research a client can ask for AFTER they are already working (the project is
// ACTIVE from its first message; see projects/activation.ts): it does the
// research and rewrites the brand's constitution, and skips every stage that
// only fed the old agency pipeline.
export type SetupMode = "FULL" | "ENRICHMENT";

// The stages ENRICHMENT skips. They build the machinery of the legacy
// simulation (department audits, department modes, the autonomy tuning stub,
// and a first batch of opportunities, ideas and a work plan for the Director),
// none of which the chat agent needs. What stays: INTAKE, DEEP_DISCOVERY,
// BRAND_CONSTITUTION, SIGNAL_PROFILE, GOAL_GENERATION and PROJECT_ACTIVATION.
export const ENRICHMENT_SKIPPED_STAGES: ReadonlySet<string> = new Set([
  "BASELINE_AUDITS",
  "AGENCY_CONFIGURATION",
  "AUTONOMY_CONFIGURATION",
  "INITIAL_OPPORTUNITIES",
  "INITIAL_IDEA_PORTFOLIO",
  "INITIAL_WORK_PLAN",
]);

// Research that has been running this long with nothing newer started is
// treated as over. OpenClaw sessions legitimately take minutes, so this is
// generous; it exists so one hung task cannot hold the stage forever.
export const DISCOVERY_STAGE_TIMEOUT_MS = 30 * 60 * 1000;

export const DISCOVERY_FAILED_MESSAGE =
  "Deep discovery ended without a single completed research task (every task failed, or none finished in time). Retry once the research provider is available.";

export type DiscoveryVerdict = "WAIT" | "COMPLETE" | "FAILED";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

// Decides what to do with a DEEP_DISCOVERY stage that is RUNNING, from the
// research tasks it started. Before this, a stage whose tasks ALL failed (the
// provider is out of credit, the gateway is down) stayed RUNNING forever: it
// needs one completed task to finish, and none ever would, while the automatic
// retry only ever looked at FAILED stages.
//  - COMPLETE: enough of them ended (>= the completion ratio) and at least one
//    produced a result; or the wait ran out but something did complete, so the
//    stage moves on with partial data instead of hanging on one stuck task.
//  - FAILED: every task ended and none produced a result; or the wait ran out
//    with nothing completed. The stage's normal retry rules then apply.
//  - WAIT: otherwise.
// The clock starts at the NEWEST task, not at the stage: a retry re-runs the
// stage, and its own startedAt (kept from the first attempt) would time the
// retry out on the spot.
export function discoveryVerdict(input: {
  tasks: { status: string; createdAt: Date }[];
  ratio: number;
  timeoutMs: number;
  now?: Date;
}): DiscoveryVerdict {
  const { tasks } = input;
  if (tasks.length === 0) return "WAIT";

  const ended = tasks.filter((task) => TERMINAL.has(task.status)).length;
  const completed = tasks.filter((task) => task.status === "COMPLETED").length;

  if (ended === tasks.length && completed === 0) return "FAILED";
  if (ended / tasks.length >= input.ratio && completed >= 1) return "COMPLETE";

  const newest = Math.max(...tasks.map((task) => task.createdAt.getTime()));
  const now = (input.now ?? new Date()).getTime();
  if (now - newest > input.timeoutMs) {
    return completed >= 1 ? "COMPLETE" : "FAILED";
  }
  return "WAIT";
}
