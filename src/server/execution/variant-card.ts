// Pure helpers for the picture set a creative-ready card shows (Works only).
// The set the strip shows is ALWAYS "the current picture + every other
// picture of the piece": card.alternatives never contains the current
// picture and never repeats one, whichever writer touched the card last
// (materialize, "Make 3 more", "Use this one", the live overlay).

export type CardPicture = {
  assetId: string;
  label?: string;
  assetWidth?: number;
  assetHeight?: number;
};

type CardPictureSource = {
  assetId?: string;
  assetWidth?: number;
  assetHeight?: number;
  alternatives?: readonly CardPicture[];
};

function dedupe(
  pictures: readonly CardPicture[],
  currentAssetId: string | undefined,
): CardPicture[] {
  const seen = new Set<string>(currentAssetId ? [currentAssetId] : []);
  const out: CardPicture[] = [];
  for (const picture of pictures) {
    if (!picture || typeof picture.assetId !== "string") continue;
    if (seen.has(picture.assetId)) continue;
    seen.add(picture.assetId);
    out.push(picture);
  }
  return out;
}

// After a picture becomes current, the picture it displaced takes its place
// in the list (so the person can go back and the set size is unchanged).
export function swapCurrentPicture(
  card: CardPictureSource,
  newCurrentAssetId: string,
  previousAssetId?: string,
): CardPicture[] {
  const alternatives = card.alternatives ?? [];
  const previous = previousAssetId ?? card.assetId;
  if (!previous || previous === newCurrentAssetId) {
    return dedupe(alternatives, newCurrentAssetId);
  }
  const displaced: CardPicture = {
    assetId: previous,
    ...(card.assetId === previous && card.assetWidth
      ? { assetWidth: card.assetWidth }
      : {}),
    ...(card.assetId === previous && card.assetHeight
      ? { assetHeight: card.assetHeight }
      : {}),
  };
  const known = alternatives.find((a) => a.assetId === previous);
  const replacement = known ?? displaced;
  const hasAdopted = alternatives.some((a) => a.assetId === newCurrentAssetId);
  const swapped = hasAdopted
    ? alternatives.map((a) =>
        a.assetId === newCurrentAssetId ? replacement : a,
      )
    : [...alternatives, replacement];
  return dedupe(swapped, newCurrentAssetId);
}

// "Make 3 more": the stored alternatives (v1 metadata) may repeat the current
// picture after an adopt and never hold the picture an adopt displaced, so the
// card list is rebuilt from the card's own list first, then the stored ones.
export function mergeCardAlternatives(
  card: CardPictureSource,
  stored: readonly CardPicture[],
): CardPicture[] {
  return dedupe([...(card.alternatives ?? []), ...stored], card.assetId);
}
