import { keptShare } from "@/lib/photo-crop";
import { tokenizeFolded } from "@/lib/text-fold";

// Which of a brand's own photos fits a post idea (docs/brand-media.md). Word
// overlap between the idea's text and what the photo shows, then hard filters
// and small nudges toward photos that have not been used yet. Pure: no model,
// no database, so the rules are testable and the Ideas board can sort a picker
// with them instantly.

export type MatchPhoto = {
  assetId: string;
  description: string | null;
  tags: readonly string[];
  subjects: readonly string[];
  setting: string | null;
  quality: number | null;
  width: number | null;
  height: number | null;
  useCount: number;
  lastUsedAt: Date | null;
};

export type MatchIdea = {
  // The idea's own words: hook, scene, headline, pillar.
  text: string;
  // The canvas the post is made for, to see how much a crop would lose.
  canvas?: { width: number; height: number };
};

// Photos below this are too soft or too poor to be a post's picture.
export const MIN_USABLE_QUALITY = 40;
// Below this score the idea and the photo have nothing to do with each other.
export const MIN_MATCH_SCORE = 2;

// Words that appear in almost every idea and say nothing about a picture.
const FILLER = new Set([
  "the", "and", "for", "with", "our", "your", "you", "new", "this", "that",
  "from", "are", "was", "has", "have", "will", "can", "all", "any", "more",
  "post", "photo", "picture", "image", "instagram", "story", "carousel",
  "bir", "ve", "ile", "icin", "bu", "da", "de", "mi", "ne", "en", "cok",
]);

function wordsOf(text: string): Set<string> {
  return new Set(
    tokenizeFolded(text).filter((word) => word.length >= 3 && !FILLER.has(word)),
  );
}

// What the photo shows, as words: its tags and subjects count most, the
// description and setting a little less.
function photoWords(photo: MatchPhoto): { strong: Set<string>; weak: Set<string> } {
  const strong = new Set<string>();
  for (const entry of [...photo.tags, ...photo.subjects]) {
    for (const word of wordsOf(entry)) strong.add(word);
  }
  const weak = new Set<string>();
  for (const word of wordsOf(`${photo.description ?? ""} ${photo.setting ?? ""}`)) {
    if (!strong.has(word)) weak.add(word);
  }
  return { strong, weak };
}

// Words of the idea that the photo also names (a whole-word match, after
// folding, so "Kahvaltı" and "kahvalti" agree).
export function overlapScore(idea: MatchIdea, photo: MatchPhoto): number {
  const ideaWords = wordsOf(idea.text);
  if (ideaWords.size === 0) return 0;
  const { strong, weak } = photoWords(photo);
  let score = 0;
  for (const word of ideaWords) {
    if (strong.has(word)) score += 2;
    else if (weak.has(word)) score += 1;
  }
  return score;
}

export function isUsable(photo: MatchPhoto): boolean {
  return photo.quality === null || photo.quality >= MIN_USABLE_QUALITY;
}

// How well the photo fills a post on this canvas: the share a crop keeps, or
// a middling 0.5 when it would be shown whole over a blurred copy (it works,
// but a photo of the right shape is better).
function shownShare(photo: MatchPhoto, canvas?: { width: number; height: number }) {
  if (!canvas || !photo.width || !photo.height) return 1;
  const kept = keptShare({ width: photo.width, height: photo.height }, canvas);
  return kept < 0.5 ? 0.5 : kept;
}

export type RankedPhoto = { photo: MatchPhoto; score: number };

// The photos that fit the idea, best first. A photo with no word in common is
// left out; among equals the one used least, then longest ago, leads.
export function rankPhotos(
  idea: MatchIdea,
  photos: readonly MatchPhoto[],
  options: { exclude?: ReadonlySet<string>; limit?: number } = {},
): RankedPhoto[] {
  const ranked: RankedPhoto[] = [];
  for (const photo of photos) {
    if (options.exclude?.has(photo.assetId) || !isUsable(photo)) continue;
    const overlap = overlapScore(idea, photo);
    if (overlap < MIN_MATCH_SCORE) continue;
    const quality = (photo.quality ?? 70) / 100;
    const score =
      overlap +
      quality +
      shownShare(photo, idea.canvas) -
      Math.min(photo.useCount, 5) * 0.5;
    ranked.push({ photo, score });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.photo.lastUsedAt?.getTime() ?? 0) - (b.photo.lastUsedAt?.getTime() ?? 0),
  );
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}

// A brand's library for the idea engine's prompt: the photos worth showing the
// model, the freshest and best first (a library of hundreds cannot all go in).
export function catalogOf(
  photos: readonly MatchPhoto[],
  limit: number,
  focus?: string,
): MatchPhoto[] {
  const usable = photos.filter(isUsable);
  const focusWords = focus ? wordsOf(focus) : null;
  const scored = usable.map((photo) => ({
    photo,
    score:
      (photo.quality ?? 70) / 100 -
      Math.min(photo.useCount, 5) * 0.3 +
      (focusWords
        ? overlapScore({ text: [...focusWords].join(" ") }, photo) * 0.5
        : 0),
  }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.photo.lastUsedAt?.getTime() ?? 0) - (b.photo.lastUsedAt?.getTime() ?? 0),
  );
  return scored.slice(0, limit).map((entry) => entry.photo);
}
