import { compactCount } from "@/lib/module-flows/seo/quick-wins";
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
  // SC-F4: CTR eğrisinden gelen quick wins (kazanç tahminli) için.
  quickWinsHintCurve:
    "Queries you rank 4–20 for, sorted by the extra clicks a better position could bring. Tap one to add it.",
  quickWinAria: (
    query: string,
    impressions: number,
    position: number,
    gain?: number,
  ) =>
    `Add “${query}”: ${impressions} impressions in 28 days, average position ${position}${gain === undefined ? "" : `, about ${gain} more clicks a month`}`,
  quickWinGain: (gain: number) => `+${compactCount(gain)}/mo`,
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
  scheduleFirstForWordPress:
    "Schedule the article first; then you can send a draft to WordPress.",
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

  // SC-F6: kipler (state.features.modes)
  modesLabel: "What do you want to do?",
  modes: {
    article: {
      label: "Write an article",
      hint: "A new post, from keyword research to the page.",
    },
    refresh: {
      label: "Refresh a page",
      hint: "Rewrite a page you already have.",
    },
    snippet: {
      label: "Fix a snippet",
      hint: "A better title and description for one page.",
    },
  },
  modeFailed: "Couldn't change what to do. Try again.",

  // Hedef sayfa seçici
  pageUrl: "Page address",
  pageUrlPlaceholder: "example.com/blog/your-page",
  pickFromPages: "Pick from your pages",
  hidePages: "Hide your pages",
  pagesLoading: "Loading your pages…",
  pagesNone: "No pages found yet. Paste the address instead.",
  pagesFailed: "Couldn't load your pages. Paste the address instead.",
  pageClicks: (clicks: string) => `${clicks} clicks`,
  pageOnSite: "On your site",
  pageSnapshot: "This page today",
  pageNoTitle: "No title found",
  pageWords: (words: number) => `${words.toLocaleString("en-US")} words`,
  ranksFor: (count: number) =>
    `Ranks for ${count.toLocaleString("en-US")} ${count === 1 ? "search" : "searches"}`,
  suggestTitles: "Suggest titles",
  suggestingTitles: "Suggesting…",
  planRefresh: "Plan the refresh",
  planningRefresh: "Planning…",
  keepSuggestions: "Keep these suggestions",
  snippetNote: "Reading your page and writing three title options.",
  refreshNote:
    "Reading your page and researching what it is missing. This takes about a minute.",

  // Başlık düzeltme adımı
  snippetNow: "Now",
  snippetOption: (n: number) => `Option ${n}`,
  snippetTitleLabel: "Title",
  snippetMetaLabel: "Meta description",
  snippetCounter: (count: number, limit: number) => `${count} / ${limit}`,
  snippetCheck: {
    title_length: "Title fits",
    meta_length: "Description fits",
    keyword_in_title: "Keyword in title",
  },
  snippetCheckFail: {
    title_length: "Title is too long",
    meta_length: "Description is too long",
    keyword_in_title: "Keyword missing from title",
  },
  snippetEmpty: "Both the title and the description need text.",
  snippetTooLong: "Shorten the title or the description first.",
  useThis: "Use this",
  suggestAgain: "Suggest again",
  suggesting: "Suggesting…",
  snippetStopped: "The suggestions stopped before they finished.",
  snippetPreviewHost: "your-site.com",
  editText: "Edit before using",

  // Tazeleme: ne değişir
  whatChanges: "What changes",
  refreshAdd: "Adds",
  refreshKeep: "Keeps",
  refreshNone: "Nothing to add was found.",
  refreshTraffic: (count: number) =>
    `This page already gets search traffic for ${count.toLocaleString("en-US")} ${count === 1 ? "search" : "searches"}.`,
  writeRefresh: "Rewrite the page",
  writingRefresh: "Rewriting…",

  // Tazeleme farkı (Review)
  diffTitle: "Changes to the page",
  diffTitleChanged: "Title changes",
  diffTitleSame: "Title stays",
  diffMetaChanged: "Description changes",
  diffMetaSame: "Description stays",
  diffAdded: "New sections",
  diffRemoved: "Dropped sections",
  diffKept: (count: number) =>
    `${count} ${count === 1 ? "section" : "sections"} stay`,
  diffWords: (before: number | null, after: number, pct: number | null) =>
    before === null
      ? `${after.toLocaleString("en-US")} words`
      : `${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} words${
          pct === null ? "" : ` (${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%)`
        }`,
  diffNone: "No changes to show.",

  // Teslim: kipe göre
  liveUrl: "Live page address (optional)",
  liveUrlPlaceholder: "https://example.com/blog/your-article",
  liveUrlHint:
    "If you add it, Agentelse checks that page. Otherwise it looks for the page itself.",
  updatedIntro:
    "Copy it into your site, then tell Agentelse you've updated the page.",
  snippetIntro:
    "Paste the title and meta description into your site's own fields, then tell Agentelse.",
  markApplied: "I've updated my site",
  updatedOn: (day: string) => `Updated · ${day}`,

  // Sonuç ve sorular
  checkingStatus: "Checking…",
  itsLive: "It's live",
  checkAgain: "Check again",
  notDoneYet: "Not done yet",
  measuringUntil: (day: string) => `Measuring until ${day}`,
  resultsRemoved:
    "These results were removed when Search Console was disconnected.",
  suggestedTopic: "Suggested from Search Console",
  useSuggestion: "Use this",
  statusFailed: "Couldn't update. Try again.",

  // Sıradaki
  next: "Next",
  writeAnother: "Write another",
  refreshPage: "Refresh a page",
  fixSnippet: "Fix a snippet",
  anotherFailed: "Couldn't start another card. Try again.",

  // Canlı koşu
  phase: {
    reading_page: "Reading your page…",
    researching: "Researching…",
    writing: "Writing…",
    checking: "Checking…",
  },
  phasePill: {
    reading_page: "Reading page",
    researching: "Researching",
    writing: "Writing",
    checking: "Checking",
  },
  liveFailed: "That stopped before it finished.",
  lastErrorTitle: "That didn't finish",
} as const;

export const INTENT_LABEL: Readonly<Record<SeoIntent, string>> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
};
