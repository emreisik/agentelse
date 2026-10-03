// A client's verdict on a finished post, and what it teaches the brand. Pure and
// client-safe: the card shows the choices, the memory writes the sentence.

export const RATINGS = ["LIKE", "DISLIKE"] as const;
export type CreativeRating = (typeof RATINGS)[number];

// What was wrong with a post the client did not like. A short fixed set keeps the
// learning consistent (the same sentence for the same complaint, so it counts as
// seen again instead of becoming a new memory every time).
export const DISLIKE_REASONS = [
  { key: "layout", label: "Layout", sentence: "the layout does not follow the brand's post design" },
  { key: "product", label: "Product", sentence: "the product is not shown right (it must be the real product, prominent)" },
  { key: "colors", label: "Colors", sentence: "the colors are off-brand" },
  { key: "text", label: "Text", sentence: "the on-image text is wrong or badly set" },
  { key: "generic", label: "Too generic", sentence: "it looks generic, not like this brand" },
  { key: "mood", label: "Mood", sentence: "the mood does not fit the brand" },
] as const;
export type DislikeReasonKey = (typeof DISLIKE_REASONS)[number]["key"];

export const MAX_RATING_NOTE_CHARS = 200;

export function isDislikeReason(value: unknown): value is DislikeReasonKey {
  return DISLIKE_REASONS.some((reason) => reason.key === value);
}

// The reasons the client ticked, in the list's order, once each.
export function cleanReasons(values: readonly unknown[]): DislikeReasonKey[] {
  const wanted = new Set(values.filter(isDislikeReason));
  return DISLIKE_REASONS.filter((reason) => wanted.has(reason.key)).map(
    (reason) => reason.key,
  );
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

// "Auction ad" · "Instagram carousel": how a post is named in a memory.
export function creativeName(creative: {
  title: string | null;
  formatKey: string | null;
  channel: string | null;
}): string | null {
  const title = creative.title ? flat(creative.title) : "";
  if (!title) return null;
  const where = creative.formatKey ?? creative.channel;
  return where ? `"${title}" (${where})` : `"${title}"`;
}

// What the post looked like, as far as the records say: the visual its brief
// names ("Visual: ...") and the layout it was laid out with.
export function designDigestOf(input: {
  brief: string | null;
  layoutName?: string | null;
}): string {
  const visual = /(?:^|\n)Visual:\s*([^\n]+)/i.exec(input.brief ?? "")?.[1];
  const parts = [
    visual ? `visual: ${flat(visual).slice(0, 110)}` : "",
    input.layoutName ? `layout: ${flat(input.layoutName).slice(0, 40)}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

// The sentence a rating becomes in the brand's memory.
export function ratingInsight(input: {
  rating: CreativeRating;
  name: string;
  digest: string;
  reasons: readonly DislikeReasonKey[];
  note?: string;
}): string {
  const digest = input.digest ? ` (${input.digest})` : "";
  if (input.rating === "LIKE") {
    return `Client liked ${input.name}${digest}`;
  }
  const why = input.reasons.map(
    (key) => DISLIKE_REASONS.find((reason) => reason.key === key)?.sentence ?? key,
  );
  const note = input.note ? flat(input.note).slice(0, MAX_RATING_NOTE_CHARS) : "";
  const reason = [...why, note].filter(Boolean).join("; ");
  return reason
    ? `Client did not like ${input.name}${digest}: ${reason}`
    : `Client did not like ${input.name}${digest}`;
}
