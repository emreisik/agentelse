// Every sentence of the social media plan pane (docs/works.md), in one place:
// the components hold no words of their own (guard W01).

import type { PostState } from "@/lib/works/plan-pane";

export const PLAN_PANE_COPY = {
  // Header
  eyebrow: "Content plan",
  title: "One plan. Every channel.",
  accounts: "Accounts",
  // Steps
  stepsAria: "Plan steps",
  stepPlan: "Plan",
  stepContent: "Content",
  stepPublish: "Approve & publish",
  // Accounts panel
  accountsTitle: "Account connections",
  accountsHint:
    "Posts are made for the channels you pick. Publishing starts once an account is connected.",
  connected: "Connected",
  notConnected: "Not connected",
  connect: "Connect",
  manage: "Manage",
  close: "Close",
  // Channels
  channelsLabel: "Channels to post on",
  channelsAria: "Channels to post on",
  keepOne: "Keep at least one channel.",
  selected: (n: number) => `${n} ${n === 1 ? "channel" : "channels"} selected`,
  connectChannel: (name: string) => `Connect ${name}`,
  story: "Story",
  storyAria: "Also share each Instagram post as a Story",
  notConnectedLine: (names: string) =>
    `${names} isn't connected yet. The posts are made now; publishing starts once it is.`,
  // The list
  postsCount: (n: number) => `${n} ${n === 1 ? "post" : "posts"}`,
  viewAria: "View",
  list: "List",
  week: "Week",
  previousWeek: "Previous week",
  nextWeek: "Next week",
  ideaCount: (n: number) => `${n} ${n === 1 ? "idea" : "ideas"}`,
  nothingThatDay: "No posts on this day.",
  channelCount: (n: number) => `${n} ${n === 1 ? "channel" : "channels"}`,
  // A post
  adaptations: "Adaptations by channel",
  contentApproach: "Content approach",
  move: "Move",
  moveTo: "Move to",
  at: "At",
  removePost: "Remove post",
  newIdea: "New idea",
  findingIdeas: "Finding ideas…",
  suggestionAria: "Suggested idea",
  suggestionLabel: "Suggested idea",
  suggestionPosition: (position: number, total: number) =>
    `${position} of ${total}`,
  ideaFrom: (label: string) => `From: ${label}`,
  useIdea: "Use this idea",
  anotherIdea: "Another idea",
  keepIdea: "Keep current",
  swapped: "Idea changed.",
  noMoreIdeas: "No other ideas for this post.",
  expand: "Show details",
  // A post's channels: each can be left out of it, the post keeps one.
  leaveOut: "Leave out",
  include: "Include",
  leaveOutAria: (channel: string) => `Leave ${channel} out of this post`,
  includeAria: (channel: string) => `Include ${channel} in this post`,
  leftOut: "Left out",
  // After a left-out tab's name, for screen readers.
  leftOutTab: ", left out",
  leftOutNote: "Left out of this post: it isn't made or posted.",
  leftOutDone: "Channel left out.",
  includedDone: "Channel included.",
  keepOneChannel: "A post keeps at least one channel.",
  // One Approve for the whole post.
  approvePost: "Approve post",
  postApproved: "Post approved.",
  postReady: (channels: number) =>
    channels === 1
      ? "Its channel is ready."
      : `All ${channels} channels are ready.`,
  // A piece
  textOf: (channel: string) => `${channel} text`,
  characters: (n: number) => `${n} ${n === 1 ? "character" : "characters"}`,
  saving: "Saving…",
  saved: "Saved",
  publishTime: "Publish time",
  timeAria: "Publish time",
  textAria: "Post text",
  pieceNeeds: "Not made yet. Make it with the button below.",
  pieceMaking: "Being made…",
  pieceFailed: "This piece could not be made. Make it again below.",
  pieceDeclined: "This piece was declined. Open it to change it.",
  openPiece: "Open in calendar",
  locked: "Approved: the text and time are final.",
  textFailed: "The text could not be saved.",
  timeFailed: "The time could not be changed.",
  moved: "Post moved.",
  moveFailed: "The post could not be moved.",
  // States of a post
  state: {
    idea: "Idea",
    needs: "Needs content",
    making: "Making…",
    ready: "Ready",
    failed: "Failed",
    declined: "Declined",
    scheduled: "Scheduled",
    published: "Published",
  } satisfies Record<PostState, string>,
  // Footers
  prepare: "Prepare content",
  continue: "Continue",
  addToCalendar: "Add to calendar",
  planSummary: (posts: number, channels: number) =>
    `${posts} ${posts === 1 ? "post" : "posts"} · ${channels} ${channels === 1 ? "channel" : "channels"}`,
  planHelper: "Every idea is adapted to each channel.",
  planHelperBatch: (posts: number) =>
    posts === 1
      ? "The first post is made now; the rest after it."
      : `The first ${posts} posts are made now; the rest after them.`,
  prepareNote: "Text and format are made separately for each channel.",
  readyOf: (ready: number, total: number) =>
    `${ready} of ${total} ${total === 1 ? "post" : "posts"} ready`,
  reviewHelper: "Review the texts and times.",
  makeMore: (n: number) => `Make ${n} more`,
  making: "Making content…",
  planPublishing: "Plan publishing",
  producingBusy: "A run is already making content for this plan.",
  // Publish step
  reviewTitle: "Review the publish plan",
  reviewMeta: (posts: number, channels: number, zone: string) =>
    [
      `${posts} ${posts === 1 ? "post" : "posts"}`,
      `${channels} ${channels === 1 ? "channel" : "channels"}`,
      zone ? `${zone} time` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  edit: "Edit",
  notMade: "Not made yet",
  tags: {
    auto: "posts itself",
    manual: "you post it",
    approval: "needs your approval",
    off: "turn on scheduled posting",
    unconnected: "not connected",
  },
  holdLine:
    "Posts for a channel that isn't connected stay on the calendar until it is.",
  approveLabel: (n: number) =>
    n === 1
      ? "I approve this post for the selected channels and times."
      : `I approve these ${n} posts for the selected channels and times.`,
  toApprove: (n: number) => `${n} ${n === 1 ? "post" : "posts"} to approve`,
  connectedOf: (connected: number, total: number) =>
    `${connected} of ${total} ${total === 1 ? "channel" : "channels"} connected`,
  approve: "Approve and schedule",
  approving: "Approving…",
  approvedToast: (approved: number, failed: number) =>
    failed > 0
      ? `${approved} approved, ${failed} could not be.`
      : `${approved} approved.`,
  // Done
  calendarTitle: "Publish calendar",
  seeContent: "See content",
  doneTitle: (n: number) =>
    `${n} ${n === 1 ? "post is" : "posts are"} on the calendar.`,
  doneBody: "Each channel's publish status is tracked on its own.",
  turnOnScheduled: "Turn on scheduled posting",
  turnOnLine:
    "Instagram posts go out at their time once scheduled posting is on.",
  scheduledOn: "Scheduled posting is on.",
  openCalendar: "Open calendar",
  // Chat quick links
  seeCalendar: "Open calendar",
  // Stale / errors
  stale: "This plan changed. Plan it again to continue.",
  planAgain: "Plan again",
  planAgainMessage: (channels: string) => `Plan the week for ${channels}.`,
  replaced: "Replaced by a newer version",
  failedGeneric: "That didn't work. Try again.",
} as const;
