// Words the idea actions answer with (src/server/actions/idea-board-actions.ts,
// src/server/ideas/idea-post.ts): shared by the server, which returns them,
// and the board, which shows them. The board's own words are in
// src/components/ideas/copy.ts.

export const IDEA_POST_COPY = {
  planTitle: "Post from your idea",
  // The click row and the reply are replayed to the model as the person's
  // message and as its own words: channels, formats and times only, never
  // the idea's text (schedule-slots.ts, review SC-7).
  clickRow: (channels: string) => `Make this post on ${channels}`,
  added: (when: string, where: string) =>
    `Added a post from an idea to your calendar for ${when} on ${where}. It is planned and has no content yet.`,
  gone: "This idea is no longer here.",
  notPost:
    "Only post ideas can be made into a post here. Plan it in the chat instead.",
  blocked:
    "A brand rule stops this idea. Change its words on the Ideas board, then try again.",
  noChat: "This idea is already on your calendar. Open the calendar to find it.",
} as const;

export const IDEA_ACTION_COPY = {
  failed: "That didn't work. Try again.",
  budget:
    "Today's AI limit is reached. New ideas come tomorrow, or raise the limit in Settings.",
  full: "The idea pool is full. Archive a few ideas or raise the pool size in Settings.",
  empty: "No new ideas this time. Try again, or give a topic.",
  noBrand: "Set up the brand first.",
  notDue: "The pool is fresh.",
  invalid: "That didn't look right. Check the fields and try again.",
} as const;

// The "why" line of an ad idea (made without a model: idea-modules.ts).
export const IDEA_REASON_COPY = {
  adWorked: "You marked this post as worked. Show it to more people like your followers.",
  adRecent: "One of your latest posts, ready to reach more people.",
} as const;
