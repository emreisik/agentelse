// Every sentence of the Analytics module (docs/modules.md), in one place: the
// card, its server actions and the exports read the same words, so the card
// components hold none of their own. UI chrome is English; the report's AI
// summary is written in the brand's language.

import type { AnalyticsSource, FailReason, SourceStatus } from "./catalog";

// "1 key event", "3 key events" (the count comes formatted).
function keyEventsText(count: string): string {
  return count === "1" ? "1 key event" : `${count} key events`;
}

export const ANALYTICS_COPY = {
  // The card
  readOnly: "This card can't be changed here.",
  // Brief
  periodHeading: "Period",
  periodOption: (days: number) => `Last ${days} days`,
  sourcesHeading: "Sources",
  fixAria: (fix: string, name: string) => `${fix}: ${name}`,
  checking: "Checking your connections…",
  sourcesFailed: "Couldn't check your connections.",
  retry: "Try again",
  continue: "Continue",
  saving: "Saving…",
  reasonPick: "Pick at least one connected source.",
  reasonNoneConnected: "Connect a source first to build a report.",
  // Plan
  sectionsHeading: "Report sections",
  sectionAria: (name: string) => `Include ${name}`,
  summaryLine: "Then a short AI summary that only uses these numbers.",
  back: "Back",
  build: "Build report",
  reasonKeepOne: "Keep at least one section.",
  // Create
  building: "Building your report…",
  readingSource: (name: string) => `Reading ${name}`,
  writingSummary: "Writing the summary",
  buildingHint: "This takes up to a minute. The card updates when it's ready.",
  stopped: "This build stopped before it finished.",
  tryAgain: "Try again",
  // Review
  summaryEyebrow: "Summary",
  highlightsHeading: "What went well",
  watchoutsHeading: "Watch out",
  nextStepsHeading: "Next steps",
  rebuild: "Rebuild",
  share: "Share",
  reasonNothingToShare: "Nothing to share yet: no source returned numbers.",
  reportMissing: "This report can't be shown. Build it again.",
  reasonBriefFirst: "Pick the sources in the brief first.",
  builtAt: (date: string) => `Built ${date}`,
  onlyNumbers: "The summary only uses the numbers in this report.",
  now: "Now",
  resultsHeading: "Results",
  campaignsHeading: "Top campaigns",
  queriesHeading: "Top searches",
  channelsHeading: "Channels",
  landingPagesHeading: "Top landing pages",
  keyEventsHeading: "Key events",
  costEach: (cost: string) => `${cost} each`,
  clicks: (clicks: string) => `${clicks} clicks`,
  position: (position: string) => `position ${position}`,
  // "42% of sessions · 3 key events"; the share part only when known.
  channelSub: (share: string | null, keyEvents: string) =>
    [share ? `${share} of sessions` : null, keyEventsText(keyEvents)]
      .filter(Boolean)
      .join(" · "),
  // "58% engaged · 3 key events"
  pageSub: (engaged: string | null, keyEvents: string) =>
    [engaged ? `${engaged} engaged` : null, keyEventsText(keyEvents)]
      .filter(Boolean)
      .join(" · "),
  openIntegrations: "Open integrations",
  instagramWindow: (days: number) =>
    `Instagram gives at most ${days} days at a time.`,
  searchConsoleLag: "Search Console data arrives 2 to 3 days late.",
  // Deliver
  shareHeading: "Share this report",
  copy: "Copy summary",
  copied: "Summary copied.",
  copyFailed: "Couldn't copy. Try again.",
  download: "Download Markdown",
  downloaded: "Markdown downloaded.",
  downloadFailed: "Couldn't download. Try again.",
  print: "Print / Save as PDF",
  printOpened: "Print view opened.",
  printFailed: "Couldn't open the print view.",
  shared: "Shared",
  // Server answers
  stale: "This card is out of date. Refreshing.",
  noLongerConnected: (names: string) =>
    `${names} can't be read anymore. Check your connections.`,
  alreadyBuilding: "This report is already being built.",
  buildFailed: "Building the report failed. Try again.",
  summaryNoNumbers:
    "No source returned numbers, so there is nothing to summarize.",
  summaryUnavailable: "The AI summary isn't available right now.",
  summaryFailed:
    "The AI summary couldn't be written this time. Rebuild to try again.",
  summaryDropped:
    "The AI summary was left out: it named numbers that aren't in this report.",
  briefSaved: "Brief saved.",
  reportReady: "Report ready.",
  workSummary: (period: string) => `Report · ${period}`,
  // Exports
  reportTitle: "Analytics report",
  keyNumbers: "Key numbers",
  metric: "Metric",
  value: "Value",
  result: "Result",
  count: "Count",
  costPerResult: "Cost per result",
  campaign: "Campaign",
  spend: "Spend",
  results: "Results",
  search: "Search",
  clicksColumn: "Clicks",
  impressions: "Impressions",
  ctr: "CTR",
  positionColumn: "Position",
  channelColumn: "Channel",
  pageColumn: "Page",
  sessionsColumn: "Sessions",
  shareColumn: "Share",
  engagementColumn: "Engaged",
  keyEventsColumn: "Key events",
  eventColumn: "Event",
  unavailable: (reason: string) => `Couldn't be read. ${reason}`,
} as const;

// What a section of the plan will show, one line each.
export const SECTION_DESCRIPTION: Readonly<Record<AnalyticsSource, string>> = {
  instagram: "Reach, views, accounts engaged, interactions and followers.",
  metaAds: "Spend, impressions, reach, clicks, CTR, CPC and results.",
  ga4: "Active users, new users, sessions, views, engagement rate and session time.",
  searchConsole:
    "Clicks, impressions, CTR, average position and the top 5 searches.",
};

// The brief's status line of a source that can't be ticked yet.
export const SOURCE_STATUS_TEXT: Readonly<
  Record<Exclude<SourceStatus, "connected">, string>
> = {
  setup: "Setup not finished",
  expired: "Connection expired",
  not_connected: "Not connected",
};

export const SOURCE_CONNECTED = "Connected";

// The quiet link beside a source that can't be ticked yet.
export const SOURCE_FIX_LINK: Readonly<
  Record<Exclude<SourceStatus, "connected">, string>
> = {
  setup: "Finish setup",
  expired: "Reconnect",
  not_connected: "Connect",
};

export const FAIL_REASON_TEXT: Readonly<Record<FailReason, string>> = {
  not_connected: "Not connected.",
  setup: "Its setup isn't finished.",
  expired: "The connection expired. Reconnect it.",
  permission: "The connection can't read insights. Reconnect it to allow them.",
  rate_limited:
    "The platform's request limit is reached. Try again in an hour.",
  no_data: "No numbers for this period.",
  error: "The platform didn't answer. Try again later.",
};
