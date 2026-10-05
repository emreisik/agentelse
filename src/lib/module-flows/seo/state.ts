import { z } from "zod";

import type { ModuleFlowStep } from "@/lib/module-flows/card";

import type { SeoQuickWin } from "./quick-wins";

// The SEO Manager's state on its module flow card (card.data, docs/modules.md):
// the brief, the researched plan, the article, the calendar delivery and the
// claim of a model call that is running. Stored JSON is never trusted: every
// read goes through parseSeoState, which keeps each part that is valid and
// drops the rest. Pure and isomorphic: the card reads it, the actions write it.

export const SEO_LIMITS = {
  topicMin: 3,
  topic: 160,
  siteUrl: 200,
  audience: 240,
  keyword: 80,
  secondaryMax: 12,
  title: 120,
  meta: 320,
  intentNote: 240,
  h2: 120,
  point: 200,
  pointsPerSection: 5,
  sectionsMin: 3,
  sectionsMax: 10,
  articleChars: 40_000,
  notes: 400,
  rewrites: 5,
} as const;

export const SEO_INTENTS = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
] as const;
export type SeoIntent = (typeof SEO_INTENTS)[number];

// A model call that started longer ago than this has crashed: its claim no
// longer blocks the card (a search-and-write call ends well inside it).
export const SEO_RUN_TTL_MS = 5 * 60_000;

export type SeoBrief = {
  topic: string;
  // "" when the person left it empty.
  siteUrl: string;
  language: string;
  audience: string;
};

export type SeoOutlineSection = { h2: string; points: string[] };

export type SeoQuickWins =
  | { state: "ok"; items: SeoQuickWin[] }
  | { state: "not-connected" }
  | { state: "failed" };

export type SeoPlan = {
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: SeoIntent;
  intentNote: string;
  titleOptions: string[];
  titleIndex: number;
  metaDescription: string;
  outline: SeoOutlineSection[];
  quickWins: SeoQuickWins;
  researchedAt: string;
};

export type SeoArticle = {
  title: string;
  metaDescription: string;
  markdown: string;
  writtenAt: string;
  rewrites: number;
};

// The article on the Content Calendar: one Post with one Blog/SEO delivery.
export type SeoDelivery = {
  postId: string;
  creativeId: string;
  scheduledFor: string;
  timezone: string;
  publishedAt?: string;
};

export type SeoRunKind = "research" | "write" | "rewrite";
export type SeoRun = { id: string; kind: SeoRunKind; startedAt: string };

export type SeoState = {
  brief?: SeoBrief;
  plan?: SeoPlan;
  article?: SeoArticle;
  delivery?: SeoDelivery;
  run?: SeoRun;
};

// ---- stored shape -------------------------------------------------------------

// An array whose bad items are dropped one by one instead of failing the whole
// part (only for reading stored JSON; never sent to a model).
function lenientArray<T>(item: z.ZodType<T>, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((values) => {
      const out: T[] = [];
      for (const value of values) {
        const parsed = item.safeParse(value);
        if (parsed.success) out.push(parsed.data);
        if (out.length >= max) break;
      }
      return out;
    });
}

const line = (max: number) => z.string().min(1).max(max);

const briefSchema = z.object({
  topic: line(SEO_LIMITS.topic),
  siteUrl: z.string().max(SEO_LIMITS.siteUrl).catch(""),
  language: z.string().min(2).max(8),
  audience: z.string().max(SEO_LIMITS.audience).catch(""),
});

const quickWinSchema = z.object({
  query: line(SEO_LIMITS.keyword),
  impressions: z.number().nonnegative(),
  clicks: z.number().nonnegative().catch(0),
  position: z.number().positive(),
});

const quickWinsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), items: lenientArray(quickWinSchema, 10) }),
  z.object({ state: z.literal("not-connected") }),
  z.object({ state: z.literal("failed") }),
]);

const sectionSchema = z.object({
  h2: line(SEO_LIMITS.h2),
  points: lenientArray(line(SEO_LIMITS.point), SEO_LIMITS.pointsPerSection),
});

const planSchema = z.object({
  primaryKeyword: line(SEO_LIMITS.keyword),
  secondaryKeywords: lenientArray(
    line(SEO_LIMITS.keyword),
    SEO_LIMITS.secondaryMax,
  ),
  searchIntent: z.enum(SEO_INTENTS).catch("informational"),
  intentNote: z.string().max(SEO_LIMITS.intentNote).catch(""),
  titleOptions: lenientArray(line(SEO_LIMITS.title), 5),
  titleIndex: z.number().int().nonnegative().catch(0),
  metaDescription: z.string().max(SEO_LIMITS.meta).catch(""),
  outline: lenientArray(sectionSchema, SEO_LIMITS.sectionsMax),
  quickWins: quickWinsSchema.catch({ state: "failed" }),
  researchedAt: z.string().max(40).catch(""),
});

const articleSchema = z.object({
  title: line(SEO_LIMITS.title),
  metaDescription: z.string().max(SEO_LIMITS.meta).catch(""),
  markdown: line(SEO_LIMITS.articleChars),
  writtenAt: z.string().max(40).catch(""),
  rewrites: z.number().int().nonnegative().catch(0),
});

const deliverySchema = z.object({
  postId: line(64),
  creativeId: line(64),
  scheduledFor: line(40),
  timezone: line(64),
  publishedAt: z.string().min(1).max(40).optional().catch(undefined),
});

const runSchema = z.object({
  id: line(64),
  kind: z.enum(["research", "write", "rewrite"]),
  startedAt: line(40),
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseSeoState(data: unknown): SeoState {
  const raw = asRecord(data);
  const state: SeoState = {};

  const brief = briefSchema.safeParse(raw.brief);
  if (brief.success) state.brief = brief.data;

  const plan = planSchema.safeParse(raw.plan);
  if (
    plan.success &&
    plan.data.titleOptions.length > 0 &&
    plan.data.outline.length > 0
  ) {
    const last = plan.data.titleOptions.length - 1;
    state.plan = {
      ...plan.data,
      titleIndex: Math.min(plan.data.titleIndex, last),
    };
  }

  const article = articleSchema.safeParse(raw.article);
  if (article.success) state.article = article.data;

  const delivery = deliverySchema.safeParse(raw.delivery);
  if (delivery.success) {
    const { publishedAt, ...rest } = delivery.data;
    state.delivery = publishedAt ? { ...rest, publishedAt } : rest;
  }

  const run = runSchema.safeParse(raw.run);
  if (run.success) state.run = run.data;

  return state;
}

// The card's `data`: plain JSON, no undefined keys.
export function serializeSeoState(state: SeoState): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
}

export function withoutRun(state: SeoState): SeoState {
  const next = { ...state };
  delete next.run;
  return next;
}

// ---- where the flow stands ------------------------------------------------------

export function seoRunActive(
  run: SeoRun | undefined,
  now: number = Date.now(),
): boolean {
  if (!run) return false;
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) return false;
  return now - started < SEO_RUN_TTL_MS;
}

// Whether the card may move from `step` to `to` with a tap (Back, the stepper,
// Publish). Never while a model call runs, never once the article is on the
// calendar (its copy there would no longer match), never into Create (that is
// the writing itself), and only to a step whose content exists.
export function canGoToSeoStep(input: {
  step: ModuleFlowStep;
  state: SeoState;
  to: ModuleFlowStep;
  now?: number;
}): boolean {
  const { step, state, to } = input;
  if (to === step) return false;
  if (seoRunActive(state.run, input.now)) return false;
  if (state.delivery) return false;
  switch (to) {
    case "brief":
      return true;
    case "plan":
      return Boolean(state.plan);
    case "create":
      return false;
    case "review":
      return Boolean(state.article);
    case "deliver":
      return Boolean(state.article) && step === "review";
  }
}

export function seoOpenableSteps(
  step: ModuleFlowStep,
  state: SeoState,
  now?: number,
): Partial<Record<ModuleFlowStep, boolean>> {
  const steps: ModuleFlowStep[] = ["brief", "plan", "review"];
  return Object.fromEntries(
    steps.map((to) => [to, canGoToSeoStep({ step, state, to, now })]),
  );
}

export function seoFlowComplete(state: SeoState): boolean {
  return Boolean(state.delivery?.publishedAt);
}

export type SeoStatus = {
  label: string;
  tone: "neutral" | "positive" | "waiting" | "special";
};

const RUN_STATUS: Readonly<Record<SeoRunKind, string>> = {
  research: "Researching",
  write: "Writing",
  rewrite: "Rewriting",
};

// The pill beside the card's title.
export function seoStatusOf(state: SeoState, now?: number): SeoStatus | null {
  if (state.run && seoRunActive(state.run, now)) {
    return { label: RUN_STATUS[state.run.kind], tone: "waiting" };
  }
  if (state.delivery?.publishedAt) {
    return { label: "Published", tone: "positive" };
  }
  if (state.delivery) return { label: "On calendar", tone: "special" };
  return null;
}
