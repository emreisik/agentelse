import type { ChainLinkKey, ChainLinkState } from "./chain";
import type { AdsAccountStatus } from "./state";

// The Ads Manager flow card's words (UI chrome is English; the ad itself is in
// the brand's language). Pure: the server actions answer with the same lines.

export const ADS_FLOW_COPY = {
  failed: "That didn't work. Try again.",
  back: "Back",
  next: "Next",

  // Brief
  platform: "Where to advertise",
  meta: "Meta",
  metaSub: "Facebook and Instagram",
  google: "Google Ads",
  soon: "Coming soon",
  optionsLoading: "Loading your posts…",
  optionsFailed: "Couldn't load your posts.",
  retry: "Try again",
  post: "Post to promote",
  noPosts: "Make a post in the Social Media Planner first.",
  openSocial: "Open Social Media Planner",
  goal: "Goal",
  budget: "Daily budget",
  duration: "For",
  days: (n: number) => `${n} days`,
  total: (amount: string) => `About ${amount} in total.`,
  audience: "Audience",
  countries: "Countries",
  ageFrom: "From age",
  ageTo: "To age",
  gender: "Gender",
  link: "Website link",
  // DSA (EU/EEA only)
  dsa: "EU ad disclosure",
  dsaHint:
    "Ads shown in the EU must say who benefits from them and who pays for them.",
  dsaBeneficiary: "Who benefits from this ad?",
  dsaPayor: "Who pays for it?",
  button: "Button",
  // F5a
  messagesGoal: "Messages",
  messagesHint: "People start a chat with you.",
  messagesWhere: "Where people message you",
  whatsappNumber: "WhatsApp number your Facebook Page uses",
  replyTime: "How fast you usually reply",
  lpvOn: "Meta optimizes for landing page views: people who wait for your page to load.",
  noPixel:
    "No Meta Pixel sent events from your website this week, so Meta optimizes for link clicks, which brings more accidental taps. Add the Pixel to optimize for landing page views.",
  // F5b
  morePosts: "More posts (optional)",
  morePostsHint: "Up to 2 more as separate ads: different ideas in one ad set let Meta find what works.",
  hoursLabel: "When should the ad run?",
  hoursHint: "Account time. Needs a total budget: Meta only paces by hour then.",
  allDay: "All day",
  businessHours: "Business hours",
  hoursFrom: "From",
  hoursTo: "To",
  weekdaysOnly: "Weekdays only",
  everyDay: "Every day",
  adFormat: "How should they show?",
  separateAds: "Separate ads",
  carouselAd: "One carousel",
  carouselHint: "Every picked post becomes a card people swipe through (2 to 10 cards). For website goals only.",
  carouselNeedsMore: "Pick at least one more post to make a carousel.",
  where: "Where",
  newCampaign: "New campaign",
  addToAdSet: "Add to an ad set",
  addToAdSetHint: "The ad set keeps its own budget, schedule and audience; only the new ads are added.",
  recommended: (goal: string, reason: string) => `Recommended: ${goal}. ${reason}`,
  totalBudget: "Total budget",
  budgetMode: "Budget type",
  perDay: "Per day",
  inTotal: "In total",
  feasibility: (amount: string) =>
    `Meta needs about 50 results a week to learn. At this budget it will likely stay "learning limited"; about ${amount} a day, or a more frequent goal such as messages, helps.`,
  target: "Your target (optional)",
  targetHint: "Agentelse judges cost against it.",
  targetIs: (amount: string) => `Target: ${amount} per result (70% of break-even).`,
  targetSkip: "Skip",
  targetFromNumbers: "From my numbers",
  targetMax: "Max cost",
  saleValue: "Average sale value",
  closeRate: "Out of 10 leads or chats, how many buy?",
  maxCost: "Max cost per result",
  audienceMode: "How strict",
  suggest: "Suggest to Meta",
  limitTo: "Limit to these",
  suggestHint: "Meta may reach beyond these ages and genders when it finds better results (Advantage+ audience).",
  limitHint: "Ads reach only these ages and genders.",
  addsToExisting: "Adds the new ads to the ad set you picked; no new budget is approved.",
  messagesNeedV2: "This setup needs the new launch (one approval). Turn it on first.",
  connect: "Connect Meta Ads",
  finishSetup: "Finish Meta Ads setup",

  // Plan
  drafting: "Writing your ad from the post…",
  notDrafted: "Not written with AI yet: these are your post's own words.",
  write: "Write with AI",
  rewrite: "Rewrite with AI",
  campaignName: "Campaign name",
  adSetName: "Ad set name",
  adName: "Ad name",
  primaryText: "Primary text",
  characters: (count: number, max: number) => `${count}/${max}`,
  flagged: (words: readonly string[]) =>
    `Check the wording: ${words.map((word) => `“${word}”`).join(", ")} ${words.length === 1 ? "is" : "are"} on your brand's avoid list.`,
  planReady: "Your ad is written.",

  // Create
  yourAd: "Your ad",
  picture: "It uses your post's picture: nothing new is drawn.",

  // Review
  summary: {
    goal: "Goal",
    budget: "Budget",
    audience: "Audience",
    link: "Link",
    post: "Post",
    names: "Names",
  },
  launch: "Launch",
  launching: "Launching…",
  safety:
    "Everything is created paused in your Meta Ads account, and each step waits for your approval first.",
  // Meta stops the ad set by itself at its end date (docs/meta-ads-plan.md F0b).
  endDate: (days: number) =>
    `Runs ${days} days from creation, then Meta stops it by itself. Turning it on later does not move the end date.`,

  // Launch
  chainAria: "What is created in Meta",
  approve: "Approve",
  refresh: "Refresh",
  checking: "Checking Meta…",
  createdAll: "Created paused in your Meta Ads account.",
  turnOn: "Turn it on in Ads Manager when you're ready.",
  openAds: "Open Ads Manager",
  relaunch: "Edit and launch again",
  stopped: "This launch stopped.",
  stillWorking: "Still working on it. Refresh to check again.",
  approved: "Approved. Creating it in Meta…",
  launched: "Launched. Approve the campaign to create it in Meta.",
  loadFailed: "Couldn't read the launch. Try again.",
  launchedAlready: "This ad was launched already.",
  movedOn: "This card moved on. Refreshing.",
  briefChanged: "The brief changed. Try again.",
  postGone: "This post can't be used for an ad any more. Pick another one.",
  stillGoing: "This launch is still going.",
  accountChanged:
    "The Meta ad account changed since the brief. Go back to the Brief and check the budget.",
  notStarted: "The launch didn't start. Launch it again.",

  // Launch v2 (one approval)
  checkingMeta: "Checking with Meta…",
  checkFailed: "Couldn't check with Meta. Try again.",
  metaChecked: "Meta checked the campaign and the ad.",
  previews: "How it looks",
  approveLaunch: "Approve & launch",
  createPaused: "Create paused",
  approvingLaunch: "Launching…",
  waitingAdmin: "Waiting for an owner or admin to approve the spend.",
  envelope: (amount: string) => `You approve up to ${amount} (net, before taxes and fees).`,
  pacing: "Meta may spend up to 1.75× your daily budget on some days; the weekly total stays within 7×.",
  gross: (amount: string) =>
    `With Meta's location fees your bill is about ${amount}, plus VAT where it applies.`,
  spendCap: (amount: string) => `Campaign spending limit: ${amount}.`,
  endsOn: (date: string) => `Meta stops it by itself on ${date} (account time).`,
  featuresOff: "Meta's automatic creative changes couldn't be set; Meta's defaults apply.",
  live: "Live in Meta. Delivery starts after Meta's review.",
  createdPaused: "Created paused in your Meta Ads account.",
  discard: "Discard",
  turnOnNow: "Turn on",
  discarded: "Discarded. Nothing is left running.",
  discardFirst: "Discard the half-made campaign first, then launch again.",
  liveUntil: (date: string) => `Live until ${date}. Meta stops it by itself.`,
} as const;

export const ADS_ACCOUNT_COPY: Readonly<
  Record<Exclude<AdsAccountStatus, "ready">, { text: string; blocked: string }>
> = {
  "needs-connect": {
    text: "Meta Ads isn't connected for this brand. Connect it to run ads from here.",
    blocked: "Connect Meta Ads first.",
  },
  "needs-account": {
    text: "Meta Ads is connected, but no ad account is picked yet.",
    blocked: "Pick an ad account in Meta Ads first.",
  },
  "needs-page": {
    text: "Pick the Facebook Page your ads run as.",
    blocked: "Pick the Facebook Page your ads run as first.",
  },
};

export const CHAIN_LINK_LABEL: Readonly<Record<ChainLinkKey, string>> = {
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
};

export const CHAIN_STATE_LABEL: Readonly<Record<ChainLinkState, string>> = {
  waiting: "Waits for the step before",
  preparing: "Getting it ready…",
  approval: "Waiting for your approval",
  running: "Creating in Meta…",
  created: "Created, paused",
  failed: "Failed",
  declined: "Declined",
  blocked: "Not created",
};

// The Meta Ads settings, opened on the Meta Ads connection.
export function metaAdsSettingsHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/integrations?integration=meta_ads`;
}
