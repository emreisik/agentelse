import type {
  CapabilityKey,
  CreativeLens,
  DepartmentKey,
  SignalCategory,
} from "@prisma/client";

// Agency focus mode — temporarily narrows the autonomous agency to its first
// goal: social media management + ad management. Everything outside that
// scope (SEO, PR, partnerships, website, email/CRM, offline/event signals,
// GA/SEO scanning, the measurement → learning → strategy loop) is switched
// off here in ONE place instead of being deleted, so turning it back on is a
// single env change: AGENCY_FOCUS=social_ads (opt-in; the default is off).
//
// Read straight from process.env (not getEnv()) so pure modules that import
// this (work-plan-builder's buildCampaignNodes, creative-lenses) stay
// testable without a full validated environment. Default is "off": the full
// agency (measurement → learning → strategy loop included) runs unless focus
// is explicitly enabled with AGENCY_FOCUS=social_ads.
export function isAgencyFocusMode(): boolean {
  return (process.env.AGENCY_FOCUS ?? "off").toLowerCase() === "social_ads";
}

// Departments that serve social/ads work. BRAND_STRATEGY leads every work
// plan (campaign brief) and DATA_ANALYTICS closes it (REPORTING, OpenAI) —
// both are cheap, working, and part of the social/ads flow.
export const FOCUS_DEPARTMENTS: ReadonlySet<DepartmentKey> = new Set([
  "BRAND_STRATEGY",
  "CREATIVE",
  "ART_DIRECTION",
  "COPY_CONTENT",
  "SOCIAL_MEDIA",
  "PERFORMANCE_MARKETING",
  "DATA_ANALYTICS",
]);

// Idea lenses that produce social posts or ad concepts. MEDIA = "paid or
// owned media concept", i.e. the ad lens.
export const FOCUS_LENS_MIX: CreativeLens[] = [
  "SOCIAL",
  "MEDIA",
  "BRAND",
  "CONTENT",
];

// Signal categories worth scanning for social/ads decisions. Each scan is
// an OpenClaw browser task + LLM extraction + LLM scoring, so every
// category left out here saves real time and daily budget.
export const FOCUS_SIGNAL_CATEGORIES: ReadonlySet<SignalCategory> = new Set([
  "SOCIAL_TREND",
  "PAID_ADVERTISING",
  "COMPETITOR",
  "PERFORMANCE",
]);

// Setup's deep-discovery research fan-out, minus SEO research.
export const FOCUS_EXCLUDED_DISCOVERY: ReadonlySet<CapabilityKey> = new Set([
  "SEO_RESEARCH",
]);

// Agency tick steps that do no social/ads work: GA/Search Console scanning
// (writes SEO signals) and the measurement → learning → strategy loop
// (OpenClaw MEASUREMENT_CHECK browser tasks + one LLM call each).
export const FOCUS_DISABLED_TICK_STEPS: ReadonlySet<string> = new Set([
  "google-analytics-scan",
  "measurement-checks",
  "learning",
  "strategy-synthesis",
]);

export function isDepartmentInFocus(department: DepartmentKey): boolean {
  return !isAgencyFocusMode() || FOCUS_DEPARTMENTS.has(department);
}
