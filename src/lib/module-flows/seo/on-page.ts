import { tokenizeFolded } from "@/lib/text-fold";

import { articleStats } from "./markdown";

// The on-page checks of an SEO article (docs/modules.md "SEO Manager", Review):
// the few rules a page needs before it goes up, each a pass or a warning with
// ONE line saying what to do. Pure: the card shows them and the rewrite step
// hands the warnings to the model. Nothing here blocks publishing.

export const ON_PAGE_RULES = {
  title: { min: 30, max: 60 },
  meta: { min: 120, max: 160 },
  minSections: 4,
  minWords: 800,
  maxParagraphWords: 150,
} as const;

export type OnPageCheckId =
  | "title-length"
  | "meta-length"
  | "keyword-title"
  | "keyword-intro"
  | "keyword-heading"
  | "sections"
  | "length"
  | "no-h1"
  | "paragraphs";

export type OnPageCheck = {
  id: OnPageCheckId;
  label: string;
  status: "pass" | "warn";
  line: string;
};

export type OnPageInput = {
  title: string;
  metaDescription: string;
  markdown: string;
  primaryKeyword: string;
};

function chars(text: string): number {
  return Array.from(text.trim()).length;
}

// A word of the keyword matches a word of the text that starts with it, less
// a short ending on long words: "shoe" finds "shoes", Turkish "ayakkabısı"
// finds "ayakkabıları". Approximate on purpose; a check, not a grader.
function stemOf(token: string): string {
  return token.length > 5 ? token.slice(0, token.length - 2) : token;
}

export function containsKeyword(text: string, keyword: string): boolean {
  const needle = tokenizeFolded(keyword);
  if (needle.length === 0) return false;
  const hay = tokenizeFolded(text);
  const stems = needle.map(stemOf);
  for (let start = 0; start + stems.length <= hay.length; start++) {
    if (stems.every((stem, offset) => hay[start + offset]!.startsWith(stem))) {
      return true;
    }
  }
  return false;
}

function lengthLine(
  count: number,
  range: { min: number; max: number },
  missing: string,
  long: string,
  short: string,
): { status: "pass" | "warn"; line: string } {
  if (count === 0) return { status: "warn", line: missing };
  const span = `${range.min}–${range.max}`;
  if (count > range.max) {
    return { status: "warn", line: `${count} characters. ${long} (${span}).` };
  }
  if (count < range.min) {
    return { status: "warn", line: `${count} characters. ${short} (${span}).` };
  }
  return { status: "pass", line: `${count} characters, within ${span}.` };
}

export function checkOnPage(input: OnPageInput): OnPageCheck[] {
  const keyword = input.primaryKeyword.trim();
  const quoted = `“${keyword}”`;
  const stats = articleStats(input.markdown);
  const longParagraphs = stats.paragraphWords.filter(
    (words) => words > ON_PAGE_RULES.maxParagraphWords,
  ).length;

  const title = lengthLine(
    chars(input.title),
    ON_PAGE_RULES.title,
    "Add a title.",
    "Shorten it so search results show all of it",
    "Make it longer so it says what the page is about",
  );
  const meta = lengthLine(
    chars(input.metaDescription),
    ON_PAGE_RULES.meta,
    "Add a meta description.",
    "Shorten it so it isn't cut off",
    "Make it longer to fill the search snippet",
  );
  const inTitle = containsKeyword(input.title, keyword);
  const inIntro = containsKeyword(stats.firstParagraph, keyword);
  const inHeading = stats.h2.some((heading) =>
    containsKeyword(heading, keyword),
  );

  return [
    { id: "title-length", label: "Title length", ...title },
    { id: "meta-length", label: "Meta description", ...meta },
    {
      id: "keyword-title",
      label: "Keyword in title",
      status: inTitle ? "pass" : "warn",
      line: inTitle
        ? `${quoted} is in the title.`
        : `Add ${quoted} to the title.`,
    },
    {
      id: "keyword-intro",
      label: "Keyword in intro",
      status: inIntro ? "pass" : "warn",
      line: inIntro
        ? `${quoted} is in the first paragraph.`
        : `Use ${quoted} in the first paragraph.`,
    },
    {
      id: "keyword-heading",
      label: "Keyword in a heading",
      status: inHeading ? "pass" : "warn",
      line: inHeading
        ? `${quoted} is in a section heading.`
        : `Use ${quoted} in at least one H2.`,
    },
    {
      id: "sections",
      label: "Sections",
      status: stats.h2.length >= ON_PAGE_RULES.minSections ? "pass" : "warn",
      line:
        stats.h2.length >= ON_PAGE_RULES.minSections
          ? `${stats.h2.length} H2 sections.`
          : `${stats.h2.length} H2 ${stats.h2.length === 1 ? "section" : "sections"}. Aim for at least ${ON_PAGE_RULES.minSections}.`,
    },
    {
      id: "length",
      label: "Length",
      status: stats.words >= ON_PAGE_RULES.minWords ? "pass" : "warn",
      line:
        stats.words >= ON_PAGE_RULES.minWords
          ? `${stats.words} words.`
          : `${stats.words} words. Aim for at least ${ON_PAGE_RULES.minWords}.`,
    },
    {
      id: "no-h1",
      label: "No H1 in the body",
      status: stats.h1Count === 0 ? "pass" : "warn",
      line:
        stats.h1Count === 0
          ? "The title is the page's only H1."
          : "The body has an H1. The title is the H1, so make it an H2.",
    },
    {
      id: "paragraphs",
      label: "Paragraphs",
      status: longParagraphs === 0 ? "pass" : "warn",
      line:
        longParagraphs === 0
          ? `Every paragraph is under ${ON_PAGE_RULES.maxParagraphWords} words.`
          : `${longParagraphs} ${longParagraphs === 1 ? "paragraph runs" : "paragraphs run"} over ${ON_PAGE_RULES.maxParagraphWords} words. Split ${longParagraphs === 1 ? "it" : "them"} up.`,
    },
  ];
}

export function onPageWarnings(checks: readonly OnPageCheck[]): OnPageCheck[] {
  return checks.filter((check) => check.status === "warn");
}
