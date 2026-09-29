// The legacy "agency simulation" loop switch.
//
// The continuous engine (continuous-agency-engine.ts) runs tick steps and
// task-completion handlers that belong to the old multi-agent pipeline
// (Council -> Director -> WorkPlan -> Handoff -> Measurement -> Learning).
// Agency Desk no longer depends on them: the chat agent (src/server/chat/)
// acts through tools directly. This switch lets that pipeline be wound down
// from the environment, without a deploy, in two safe stages:
//
//   LEGACY_AGENCY_LOOP=on     (default) everything runs, exactly as before.
//   LEGACY_AGENCY_LOOP=drain  GENERATORS stop creating new pipeline work;
//                             DRAINERS keep finishing rows already in flight,
//                             so no open WorkPlan / handoff / measurement is
//                             stranded.
//   LEGACY_AGENCY_LOOP=off    drainers stop too. Flip to this only once the
//                             in-flight counts are zero (see
//                             docs/architecture/legacy-loop-rollout.md).
//
// Units are identified by name: tick steps by their registered step name, and
// task-completion handlers by the name they were registered with. Anything
// NOT listed below is a real product feature (publish completion, Meta ad
// chain relays, metric scanners, Telegram polling, the loop heartbeat, and the
// signal -> insight -> opportunity intelligence) and always runs.
//
// Read from process.env at call time (like agency-focus.ts), never cached, so
// tests can flip it and a restart is the only thing an operator needs.

export type LegacyAgencyLoopMode = "on" | "drain" | "off";

// Create NEW legacy pipeline work. Closed by `drain` and `off`.
const GENERATORS: ReadonlySet<string> = new Set([
  // Generic OpenClaw web scans per signal category; in real (non-mock) mode
  // they never produced a Signal, so they only cost browser sessions + LLM.
  "signal-scans",
  // Council promotes ideas to SHORTLISTED; Director turns them into tasks and
  // WorkPlans. Replaced by IdeaRepository.promoteToShortlist (LLM-free) on the
  // on-demand idea paths.
  "council-evaluation",
  "director-decisions",
  // Opens a MeasurementPlan for every completed externally-visible task.
  "measurement-planning",
]);

// Finish rows a generator already created. Closed only by `off`.
const DRAINERS: ReadonlySet<string> = new Set([
  "handoff-progression",
  "work-plan-stale-sweep",
  "measurement-checks",
  "learning",
  "strategy-synthesis",
  "work-plan-progression",
  "work-plan-terminal",
  "handoff-close-out",
  "measurement-check-result",
  "measurement-check-terminal",
]);

export function legacyAgencyLoopMode(): LegacyAgencyLoopMode {
  const raw = (process.env.LEGACY_AGENCY_LOOP ?? "on").trim().toLowerCase();
  return raw === "off" || raw === "drain" ? raw : "on";
}

// True when the named tick step / handler should run under the current mode.
export function isLegacyUnitEnabled(name: string): boolean {
  const mode = legacyAgencyLoopMode();
  if (GENERATORS.has(name)) return mode === "on";
  if (DRAINERS.has(name)) return mode !== "off";
  return true;
}
