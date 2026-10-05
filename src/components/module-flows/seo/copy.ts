import { SEO_LIMITS, type SeoIntent } from "@/lib/module-flows/seo/state";

// Every word the SEO Manager's card shows (UI chrome stays English; the
// article itself is in the brief's language).
export const SEO_FLOW_COPY = {
  unavailable: "Open this card in its chat to continue.",
  stepsMoved: "Couldn't change the step. Try again.",

  // Brief
  topic: "Topic",
  topicPlaceholder: "What should the article be about?",
  site: "Website",
  sitePlaceholder: "example.com",
  language: "Language",
  languagePlaceholder: "Pick a language",
  audience: "Audience or goal (optional)",
  audiencePlaceholder: "e.g. first-time buyers, get them to book a fitting",
  research: "Find keywords",
  researchAgain: "Research again",
  researching: "Researching…",
  keepPlan: "Keep current plan",
  researchNote:
    "Researching keywords and what ranks today. This takes about a minute.",

  // Plan
  primaryKeyword: "Primary keyword",
  secondaryKeywords: "Secondary keywords",
  removeKeyword: (keyword: string) => `Remove “${keyword}”`,
  noSecondary: "No secondary keywords.",
  quickWins: "Quick wins from Search Console",
  quickWinsHint: "Queries you already rank 8–20 for. Tap one to add it.",
  quickWinAria: (query: string, impressions: number, position: number) =>
    `Add “${query}”: ${impressions} impressions in 28 days, average position ${position}`,
  quickWinsNone: "No queries close to page one in the last 28 days.",
  quickWinsMissing:
    "Connect Search Console to see queries you almost rank for.",
  quickWinsConnect: "Connect",
  quickWinsFailed: "Search Console couldn't be read just now.",
  title: "Title",
  meta: "Meta description",
  outline: "Outline",
  sectionHeading: (n: number) => `Section ${n} heading`,
  moveUp: (n: number) => `Move section ${n} up`,
  moveDown: (n: number) => `Move section ${n} down`,
  removeSection: (n: number) => `Remove section ${n}`,
  addSection: "Add a section",
  write: "Write article",
  writing: "Writing…",
  back: "Back",
  backToArticle: "Back to article",
  writeNote: "Writing your article. This takes about a minute.",
  researchStopped: "The research stopped before it finished.",
  tryAgain: "Try again",

  // Create
  writeStopped: "The writing stopped before it finished.",
  backToPlan: "Back to plan",

  // Review
  preview: "Search preview",
  previewSite: "your-site.com",
  article: "Article",
  stats: (words: number, sections: number) =>
    `${words.toLocaleString("en-US")} words · ${sections} ${sections === 1 ? "section" : "sections"}`,
  checks: "On-page checks",
  checksSummary: (passed: number, total: number) =>
    `${passed} of ${total} pass`,
  pass: "Pass",
  warn: "Worth a fix",
  publish: "Publish",
  rewrite: "Rewrite",
  rewriteNow: "Rewrite now",
  rewriting: "Rewriting…",
  cancel: "Cancel",
  rewriteLabel: "What should change? (optional)",
  rewritePlaceholder: "e.g. a shorter intro, more practical tips",
  rewriteNote: "Rewriting your article. This takes about a minute.",
  rewriteHint: "The rewrite also fixes the checks marked “Worth a fix”.",
  rewriteLimit: `This article was rewritten ${SEO_LIMITS.rewrites} times. Edit it on your site instead.`,

  // Publish
  deliverIntro:
    "Ready to go live. Copy it into your site, then mark it as published.",
  pasteHint:
    "Paste the title and meta description into your site's own fields.",
  copyMarkdown: "Copy as Markdown",
  copyHtml: "Copy as HTML",
  copied: (what: string) => `${what} copied`,
  copyFailed: "Couldn't copy. Select the text instead.",
  when: "When does it go live?",
  addToCalendar: "Add to calendar",
  markPublished: "Mark as published",
  backToReview: "Back to review",
  openCalendar: "Open calendar",
  onCalendar: (when: string) => `On your calendar for ${when}.`,
  publishedOn: (day: string) => `Published · ${day}`,
  pickWhen: "Pick a day and a time.",
} as const;

export const INTENT_LABEL: Readonly<Record<SeoIntent, string>> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
};
