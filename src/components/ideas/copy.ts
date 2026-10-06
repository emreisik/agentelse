// Every sentence of the Ideas board (docs/ideas.md), in one place: the
// components hold no words of their own (guard W01). The actions' own answers
// are in src/lib/ideas/copy.ts.

import type { DismissReason, IdeaSource } from "@/lib/ideas/concept";
import type { BoardSort, BoardStatus } from "@/lib/ideas/board";

export const IDEAS_COPY = {
  title: "Ideas",
  subtitle: (brand: string) =>
    brand
      ? `Fresh post ideas for ${brand}, ready to make.`
      : "Fresh post ideas, ready to make.",
  health: (fresh: number) => `${fresh} fresh`,
  toppedUp: (ago: string) => `topped up ${ago}`,
  neverToppedUp: "not topped up yet",
  toppingUp: "Topping up your ideas…",
  generate: "Generate ideas",
  generating: "Finding ideas…",
  generateTitle: "New ideas",
  aboutLabel: "About",
  aboutPlaceholder: "Optional: a launch, a season, a product…",
  howMany: "How many",
  forLabel: "For",
  forKind: { social: "Posts", seo: "Articles" },
  generateGo: "Generate",
  newBadge: "New",
  searchPlaceholder: "Search ideas",
  sortLabel: "Sort",
  sort: {
    best: "Best first",
    newest: "Newest",
    ending: "Ending soon",
  } satisfies Record<BoardSort, string>,
  status: {
    fresh: "Fresh",
    saved: "Saved",
    planned: "Planned",
    done: "Done",
    expired: "Expired",
    archived: "Archived",
  } satisfies Record<BoardStatus, string>,
  modules: {
    all: "All",
    social: "Posts",
    seo: "Articles",
    ads: "Ads",
    untyped: "Older",
  },
  sourceAll: "All sources",
  source: {
    trend: "Trend",
    season: "Seasonal",
    results: "Your results",
    brand: "Brand",
    chat: "From chat",
    opportunity: "Opportunity",
    search: "Search",
    manual: "Your topic",
  } satisfies Record<IdeaSource, string>,
  channelAll: "All channels",
  strong: "Strong idea",
  until: (day: string) => `Until ${day}`,
  scene: "Scene",
  // Card actions
  make: "Make this post",
  making: "Opening…",
  openDraft: "Open draft",
  save: "Save",
  saved: "Saved",
  savedToast: "Saved: plans pick it first.",
  unsavedToast: "Removed from saved.",
  more: "More",
  angle: "Another angle",
  angleToast: (n: number) =>
    n === 1 ? "1 new angle added." : `${n} new angles added.`,
  planInChat: "Plan in chat",
  notForUs: "Not for us…",
  notForUsTitle: "Why not?",
  dismissed: "Got it. Next ideas steer away from this.",
  reasons: {
    "off-brand": "Off-brand",
    "not-now": "Not relevant now",
    "done-before": "Done before",
    "too-salesy": "Too salesy",
    other: "Something else",
  } satisfies Record<DismissReason, string>,
  archive: "Archive",
  archived: "Idea archived.",
  convert: "Turn into a post idea",
  converted: "Turned into a post idea.",
  olderIdea: "Older idea",
  // Where it went
  draftInChat: "Draft in chat",
  plannedFor: (when: string) => `Planned · ${when}`,
  published: "Published",
  // Article and ad cards
  articleFor: (keyword: string) => `Keyword: ${keyword}`,
  writeArticle: "Write this article",
  sponsored: "Sponsored",
  boost: "Boost this post",
  learnMore: "Learn more",
  // Detail
  detailTitle: "Idea",
  hook: "Hook",
  headline: "On the picture",
  headlineCount: (n: number, max: number) => `${n}/${max} words`,
  highlight: "Highlighted words",
  caption: "Caption",
  visual: "Scene",
  layout: "Layout",
  layoutDefault: "Brand default",
  layoutHint: "Layouts with a headline put these words on the picture.",
  noHeadlineHint:
    "This layout carries no words on the picture: the hook leads the caption.",
  formats: "Preview as",
  formatLabel: {
    "instagram.post": "Instagram post",
    "instagram.carousel": "Carousel",
    "instagram.story": "Story",
    "facebook.post": "Facebook",
  } as Record<string, string>,
  why: "Why this idea",
  evidence: "Source",
  saveChanges: "Save changes",
  savingChanges: "Saving…",
  changesSaved: "Changes saved.",
  close: "Close",
  // Empty states
  emptyTitle: "No ideas here yet",
  emptyFresh:
    "New ideas arrive on their own as the pool runs low. Generate some now to start.",
  emptyFiltered: "Nothing matches these filters.",
  clearFilters: "Clear filters",
  noKit:
    "Scan your website in the Brand tab so idea cards look like your posts.",
  failed: "That didn't work. Try again.",
} as const;

export const FORMAT_CHIP: Record<string, string> = {
  "instagram.post": "Post",
  "instagram.carousel": "Carousel",
  "instagram.story": "Story",
  "facebook.post": "Post",
  "linkedin.post": "Post",
};
