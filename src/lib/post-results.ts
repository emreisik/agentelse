// What a published post did, as the owner judges it (Faz 4, docs/brand-brain-loop.md).
// The owner marks a published post "Worked" or "Didn't work"; that verdict, not
// the post's numbers, is what the brand learns. The live likes and comments are
// read when the owner looks (Instagram, never stored, never sent to the AI:
// privacy page and the Meta review texts promise exactly that), so the owner can
// judge with the numbers in front of them. Pure and isomorphic.

export const POST_VERDICTS = ["WORKED", "DIDNT"] as const;
export type PostVerdict = (typeof POST_VERDICTS)[number];

export function isPostVerdict(value: unknown): value is PostVerdict {
  return (POST_VERDICTS as readonly unknown[]).includes(value);
}

// The audit row that records a verdict (one per mark; the newest wins). It is
// the durable "already judged" marker: the lesson in memory can merge with an
// identical lesson of another post, the audit row never does.
export const VERDICT_AUDIT_ACTION = "creative.result_verdict";
// The audit row written when a plan piece is published: which pool idea it was
// built from, kept apart from the plan card, which goes when its chat is deleted.
export const PUBLISHED_AUDIT_ACTION = "creative.published";

// How the post compares with the account's other recent posts, by likes +
// comments. Shown next to the numbers to help the owner judge; never stored.
export type RecentComparison = "above" | "about" | "below";

const COMPARE_MARGIN = 0.2;
const MIN_RECENT = 3;

export function engagementOf(stats: {
  likes: number | null;
  comments: number | null;
}): number | null {
  if (stats.likes === null && stats.comments === null) return null;
  return (stats.likes ?? 0) + (stats.comments ?? 0);
}

// The median engagement of the other recent posts is the yardstick (one viral
// post must not make every other one look weak). Fewer than three posts to
// compare with: no comparison.
export function compareToRecent(
  post: { likes: number | null; comments: number | null },
  others: readonly { likes: number | null; comments: number | null }[],
): RecentComparison | null {
  const own = engagementOf(post);
  if (own === null) return null;
  const values = others
    .map(engagementOf)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length < MIN_RECENT) return null;
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 1
      ? values[middle]!
      : (values[middle - 1]! + values[middle]!) / 2;
  if (median === 0) return own > 0 ? "above" : "about";
  if (own >= median * (1 + COMPARE_MARGIN)) return "above";
  if (own <= median * (1 - COMPARE_MARGIN)) return "below";
  return "about";
}

const MAX_NOTE_CHARS = 200;

// The lesson a verdict leaves in Brand Memory. No numbers: the brand learns the
// owner's judgment of the post, never its counters. `name` is the post's own
// label (title and format), `note` the owner's optional words.
export function postResultInsight(input: {
  verdict: PostVerdict;
  name: string;
  note?: string | null;
}): string {
  const note = input.note?.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
  const head =
    input.verdict === "WORKED"
      ? `Published post ${input.name} worked: the client marked its results as good. Make more posts like it.`
      : `Published post ${input.name} did not work: the client marked its results as weak. Do not repeat it as it was.`;
  return note ? `${head} Client's note: ${note}` : head;
}

// What the results surfaces show for one published post.
export type PostResultItem = {
  creativeId: string;
  title: string;
  channel: string | null;
  formatKey: string | null;
  // ISO time it went out (the publish task's completion, else the post's last
  // update).
  publishedAt: string;
  assetId: string | null;
  // The pool idea it was built from, when known.
  ideaId: string | null;
  verdict: PostVerdict | null;
  // Live numbers, read for this view only. null: nothing to read (not an
  // Instagram post the agency published, or the read failed).
  stats: {
    likes: number | null;
    comments: number | null;
    permalink: string | null;
    comparison: RecentComparison | null;
  } | null;
};

// Why there are no live numbers, when the whole read failed.
export type PostResultsStatsNote =
  "not_connected" | "expired" | "rate_limited" | "error" | null;

export type PostResultsResponse = {
  items: PostResultItem[];
  statsNote: PostResultsStatsNote;
};

// An idea's results, kept in Idea.scores (a free JSON slot: the council writes
// its scores elsewhere): the owner's verdict per published post built from it,
// and the tally. Other keys already in the value are kept. A later verdict on
// the same post replaces the earlier one.
export type IdeaResults = {
  posts: Record<string, { verdict: PostVerdict; at: string }>;
  worked: number;
  didNotWork: number;
};

export function mergeIdeaResult(
  scores: unknown,
  creativeId: string,
  verdict: PostVerdict,
  at: string,
): Record<string, unknown> {
  const base =
    scores && typeof scores === "object" && !Array.isArray(scores)
      ? { ...(scores as Record<string, unknown>) }
      : {};
  const previous = base.results as Partial<IdeaResults> | undefined;
  const posts: IdeaResults["posts"] = {};
  if (previous?.posts && typeof previous.posts === "object") {
    for (const [id, entry] of Object.entries(previous.posts)) {
      if (entry && isPostVerdict(entry.verdict) && typeof entry.at === "string") {
        posts[id] = { verdict: entry.verdict, at: entry.at };
      }
    }
  }
  posts[creativeId] = { verdict, at };
  const verdicts = Object.values(posts).map((entry) => entry.verdict);
  base.results = {
    posts,
    worked: verdicts.filter((v) => v === "WORKED").length,
    didNotWork: verdicts.filter((v) => v === "DIDNT").length,
  } satisfies IdeaResults;
  return base;
}
