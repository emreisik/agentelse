import { z } from "zod";

import { foldForMatch } from "@/lib/text-fold";

import { cleanLine } from "./brief";
import { checkOnPage } from "./on-page";
import {
  SEO_INTENTS,
  SEO_LIMITS,
  type SeoIntent,
  type SeoOutlineSection,
  type SeoPlan,
  type SeoQuickWins,
} from "./state";

// The SEO plan (docs/modules.md "SEO Manager", Plan): what the research call's
// answer becomes on the card, and the person's edits to it (the title they
// pick, the outline they reshape, the keywords they add). Pure: the server is
// the authority, the card runs the same checks to say why "Write article" is
// blocked.

// What the research call answers (server/modules/seo/prompts.ts asks for it).
export type SeoResearchAnswer = {
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: string;
  intentNote: string;
  titleOptions: string[];
  metaDescription: string;
  outline: { h2: string; points: string[] }[];
};

export const SEO_SECONDARY_TARGET = 8;
const TITLE_OPTIONS = 3;

// A model-written line: one line, no markdown markers or wrapping quotes.
export function cleanModelLine(raw: unknown, max: number): string {
  return cleanLine(raw, max * 2)
    .replace(/^(?:#{1,6}\s+|[-*+>]\s+|\d{1,2}[.)]\s+|H2:\s*)/i, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim()
    .slice(0, max)
    .trim();
}

function keywordOf(raw: unknown): string {
  return cleanModelLine(raw, SEO_LIMITS.keyword).replace(/[.,;:!?]+$/, "");
}

export function sameKeyword(a: string, b: string): boolean {
  return foldForMatch(a).trim() === foldForMatch(b).trim();
}

// The list with `keyword` added at the end, unless it is empty, already there
// or the primary keyword itself.
export function withKeyword(
  list: readonly string[],
  keyword: string,
  primary: string,
): string[] {
  const clean = keywordOf(keyword);
  if (!clean || sameKeyword(clean, primary)) return [...list];
  if (list.some((item) => sameKeyword(item, clean))) return [...list];
  if (list.length >= SEO_LIMITS.secondaryMax) return [...list];
  return [...list, clean];
}

// SC-F7: aylık plandan açılan makalede hedef anahtar kelime planın sorgusudur;
// modelin seçtiği ana kelime ikincil listeye iner (kişi planı yine düzenleyebilir).
export function withPlannedKeyword(plan: SeoPlan, planned: string): SeoPlan {
  const keyword = keywordOf(planned);
  if (!keyword || sameKeyword(keyword, plan.primaryKeyword)) return plan;
  const rest = plan.secondaryKeywords.filter((item) => !sameKeyword(item, keyword));
  return {
    ...plan,
    primaryKeyword: keyword,
    secondaryKeywords: withKeyword(rest, plan.primaryKeyword, keyword),
  };
}

function intentOf(raw: unknown): SeoIntent {
  const text = foldForMatch(typeof raw === "string" ? raw : "");
  return SEO_INTENTS.find((intent) => text.includes(intent)) ?? "informational";
}

function sectionsOf(
  raw: readonly { h2?: unknown; points?: unknown }[],
): SeoOutlineSection[] {
  const seen = new Set<string>();
  const out: SeoOutlineSection[] = [];
  for (const section of raw) {
    const h2 = cleanModelLine(section.h2, SEO_LIMITS.h2);
    if (!h2 || seen.has(foldForMatch(h2))) continue;
    seen.add(foldForMatch(h2));
    const points = (Array.isArray(section.points) ? section.points : [])
      .map((point: unknown) => cleanModelLine(point, SEO_LIMITS.point))
      .filter(Boolean)
      .slice(0, SEO_LIMITS.pointsPerSection);
    out.push({ h2, points });
    if (out.length >= SEO_LIMITS.sectionsMax) break;
  }
  return out;
}

// The first title that already passes the title checks, else the first one.
function bestTitleIndex(
  titles: readonly string[],
  keyword: string,
  meta: string,
): number {
  const index = titles.findIndex((title) =>
    checkOnPage({
      title,
      metaDescription: meta,
      markdown: "",
      primaryKeyword: keyword,
    })
      .filter(
        (check) => check.id === "title-length" || check.id === "keyword-title",
      )
      .every((check) => check.status === "pass"),
  );
  return Math.max(0, index);
}

// The research answer as the card's plan, or null when it is too thin to work
// from (no keyword, no title, fewer than three sections).
export function planFromResearch(
  answer: SeoResearchAnswer,
  quickWins: SeoQuickWins,
  now: Date,
): SeoPlan | null {
  const primaryKeyword = keywordOf(answer.primaryKeyword);
  if (!primaryKeyword) return null;

  let secondaryKeywords: string[] = [];
  for (const keyword of answer.secondaryKeywords) {
    secondaryKeywords = withKeyword(secondaryKeywords, keyword, primaryKeyword);
    if (secondaryKeywords.length >= SEO_SECONDARY_TARGET) break;
  }

  const seenTitles = new Set<string>();
  const titleOptions: string[] = [];
  for (const raw of answer.titleOptions) {
    const title = cleanModelLine(raw, SEO_LIMITS.title);
    if (!title || seenTitles.has(foldForMatch(title))) continue;
    seenTitles.add(foldForMatch(title));
    titleOptions.push(title);
    if (titleOptions.length >= TITLE_OPTIONS) break;
  }
  const outline = sectionsOf(answer.outline);
  if (titleOptions.length === 0 || outline.length < SEO_LIMITS.sectionsMin) {
    return null;
  }

  const metaDescription = cleanModelLine(
    answer.metaDescription,
    SEO_LIMITS.meta,
  );
  return {
    primaryKeyword,
    secondaryKeywords,
    searchIntent: intentOf(answer.searchIntent),
    intentNote: cleanModelLine(answer.intentNote, SEO_LIMITS.intentNote),
    titleOptions,
    titleIndex: bestTitleIndex(titleOptions, primaryKeyword, metaDescription),
    metaDescription,
    outline,
    quickWins,
    researchedAt: now.toISOString(),
  };
}

export function chosenTitle(plan: SeoPlan): string {
  return plan.titleOptions[plan.titleIndex] ?? plan.titleOptions[0] ?? "";
}

// ---- the person's edits -----------------------------------------------------------

export type SeoPlanEdits = {
  titleIndex: number;
  metaDescription: string;
  secondaryKeywords: string[];
  outline: SeoOutlineSection[];
};

// Bounded BEFORE it is cleaned: a request can never carry more than a card
// could show.
const EditsSchema = z.object({
  titleIndex: z.number().int().min(0).max(9),
  metaDescription: z.string().max(SEO_LIMITS.meta * 2),
  secondaryKeywords: z
    .array(z.string().max(SEO_LIMITS.keyword * 2))
    .max(SEO_LIMITS.secondaryMax * 2),
  outline: z
    .array(
      z.object({
        h2: z.string().max(SEO_LIMITS.h2 * 2),
        points: z
          .array(z.string().max(SEO_LIMITS.point * 2))
          .max(SEO_LIMITS.pointsPerSection * 2),
      }),
    )
    .max(SEO_LIMITS.sectionsMax * 2),
});

export const SEO_EDIT_MESSAGES = {
  invalid: "That plan can't be used. Refresh and try again.",
  meta: "Add a meta description.",
  heading: "Give every section a heading, or remove it.",
  tooFew: `Keep at least ${SEO_LIMITS.sectionsMin} sections.`,
  tooMany: `Keep at most ${SEO_LIMITS.sectionsMax} sections.`,
} as const;

export function applyPlanEdits(
  plan: SeoPlan,
  input: unknown,
): { ok: true; plan: SeoPlan } | { ok: false; message: string } {
  const parsed = EditsSchema.safeParse(input);
  if (!parsed.success || parsed.data.titleIndex >= plan.titleOptions.length) {
    return { ok: false, message: SEO_EDIT_MESSAGES.invalid };
  }
  const edits = parsed.data;

  const metaDescription = cleanLine(edits.metaDescription, SEO_LIMITS.meta);
  if (!metaDescription) return { ok: false, message: SEO_EDIT_MESSAGES.meta };

  const outline: SeoOutlineSection[] = [];
  for (const section of edits.outline) {
    const h2 = cleanLine(section.h2, SEO_LIMITS.h2);
    if (!h2) return { ok: false, message: SEO_EDIT_MESSAGES.heading };
    outline.push({
      h2,
      points: section.points
        .map((point) => cleanLine(point, SEO_LIMITS.point))
        .filter(Boolean)
        .slice(0, SEO_LIMITS.pointsPerSection),
    });
  }
  if (outline.length < SEO_LIMITS.sectionsMin) {
    return { ok: false, message: SEO_EDIT_MESSAGES.tooFew };
  }
  if (outline.length > SEO_LIMITS.sectionsMax) {
    return { ok: false, message: SEO_EDIT_MESSAGES.tooMany };
  }

  let secondaryKeywords: string[] = [];
  for (const keyword of edits.secondaryKeywords) {
    secondaryKeywords = withKeyword(
      secondaryKeywords,
      keyword,
      plan.primaryKeyword,
    );
  }

  return {
    ok: true,
    plan: {
      ...plan,
      titleIndex: edits.titleIndex,
      metaDescription,
      secondaryKeywords,
      outline,
    },
  };
}

// ---- the article --------------------------------------------------------------

// The written article as it is stored: a fence around the whole answer goes,
// and so does a first-line H1 (the model repeating the title, which lives on
// its own). Any other H1 stays for the on-page check to flag.
export function normalizeArticleMarkdown(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^#\s+[^\n]*\n+/, "");
  return text.slice(0, SEO_LIMITS.articleChars).trim();
}
