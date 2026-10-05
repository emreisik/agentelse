import { z } from "zod";

import type { ModuleFlowStep } from "@/lib/module-flows/card";

import {
  ANALYTICS_PERIODS,
  DEFAULT_ANALYTICS_PERIOD,
  orderedSources,
  type AnalyticsPeriod,
  type AnalyticsSource,
} from "./catalog";
import { readReport, reportHasNumbers, type ReportData } from "./report";

// The Analytics card's own state, kept in ModuleFlowCardData.data (docs/
// modules.md): the brief (period, sources), the plan (sections), a build in
// flight, the last report and whether it was shared. Read field by field with
// defaults, so one bad field never costs the rest. Pure and isomorphic: the
// card and the server actions decide the same moves with the same functions.

// A build older than this has stopped (a restart, a lost request): the card
// offers to try again and the server accepts a new one.
export const BUILD_STALE_MS = 5 * 60_000;

const ID_MAX = 64;
const ERROR_MAX = 300;

export type BuildFrom = "plan" | "review" | "deliver";

export type BuildState = {
  id: string;
  startedAt: string;
  // Where the card goes back to when the build fails.
  from: BuildFrom;
};

export type AnalyticsFlowState = {
  period: AnalyticsPeriod;
  sources: AnalyticsSource[];
  sections: AnalyticsSource[];
  build: BuildState | null;
  report: ReportData | null;
  // The last failed build's message, shown on the step it went back to.
  error: string | null;
  sharedAt: string | null;
};

const isoTime = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));

const buildSchema = z.object({
  id: z.string().min(1).max(ID_MAX),
  startedAt: isoTime,
  from: z.enum(["plan", "review", "deliver"]),
});

// Each stored field on its own: a bad one falls back, the others stay.
function field<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function readAnalyticsState(
  data: Record<string, unknown> | null | undefined,
): AnalyticsFlowState {
  const raw = data ?? {};
  const list = z.array(z.unknown());
  const sources = orderedSources(field(list, raw.sources, []));
  const sections = Array.isArray(raw.sections)
    ? orderedSources(raw.sections).filter((source) => sources.includes(source))
    : sources;
  const error = field(z.string().trim().min(1), raw.error, null);
  return {
    period: field(z.literal(ANALYTICS_PERIODS), raw.period, DEFAULT_ANALYTICS_PERIOD),
    sources,
    sections,
    build: field(buildSchema, raw.build, null),
    report: readReport(raw.report),
    error: error ? error.slice(0, ERROR_MAX) : null,
    sharedAt: field(isoTime, raw.sharedAt, null),
  };
}

// The state as the card stores it (JSON).
export function analyticsCardData(
  state: AnalyticsFlowState,
): Record<string, unknown> {
  return {
    period: state.period,
    sources: state.sources,
    sections: state.sections,
    build: state.build,
    report: state.report,
    error: state.error,
    sharedAt: state.sharedAt,
  };
}

export function isBuildRunning(build: BuildState | null, now: number): boolean {
  if (!build) return false;
  const started = Date.parse(build.startedAt);
  return Number.isFinite(started) && now - started < BUILD_STALE_MS;
}

// A report can be (re)built from the plan, from a finished report, or from a
// build that stopped. Never while one runs.
export function canBuild(
  step: ModuleFlowStep,
  state: AnalyticsFlowState,
  now: number,
): boolean {
  if (state.sources.length === 0) return false;
  if (step === "create") return !isBuildRunning(state.build, now);
  return step === "plan" || step === "review" || step === "deliver";
}

// The steps a tap can open from where the card stands: back to the brief or
// the plan, forward to a report that exists. Nothing moves while a build runs,
// and "create" is reached only by building.
export function openableSteps(
  step: ModuleFlowStep,
  state: AnalyticsFlowState,
  now: number,
): Record<ModuleFlowStep, boolean> {
  const closed = {
    brief: false,
    plan: false,
    create: false,
    review: false,
    deliver: false,
  };
  if (step === "create" && isBuildRunning(state.build, now)) return closed;
  return {
    brief: step !== "brief",
    plan: step !== "plan" && state.sources.length > 0,
    create: false,
    review: step !== "review" && state.report !== null,
    deliver: step !== "deliver" && reportHasNumbers(state.report),
  };
}

// Everything is delivered once the report was shared at least once.
export function isFlowComplete(
  step: ModuleFlowStep,
  state: AnalyticsFlowState,
): boolean {
  return step === "deliver" && state.sharedAt !== null && state.report !== null;
}
