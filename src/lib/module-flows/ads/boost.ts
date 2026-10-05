// "Boost with an ad" on a post card: a new chat in the Ads Manager module whose
// Brief starts from that post (NewWorkOpener passes `post` to the flow card's
// hint). Only a post that is approved or out, with a picture made, can be an
// ad: the ad uses that picture. Pure.

export type BoostCandidate = {
  id: string;
  stage: string;
  excluded?: boolean;
  // The delivery's image, once made.
  assetId?: string;
  // Its channel format ("instagram.story"): a feed picture fits an ad better.
  formatKey?: string;
};

const BOOSTABLE = new Set(["APPROVED", "PUBLISHED"]);

export function canBoost(candidate: BoostCandidate): boolean {
  return (
    !candidate.excluded &&
    Boolean(candidate.assetId) &&
    BOOSTABLE.has(candidate.stage)
  );
}

// The delivery whose picture the ad uses: a feed one before a Story.
export function boostCreativeOf(
  candidates: readonly BoostCandidate[],
): string | null {
  const usable = candidates.filter(canBoost);
  const feed = usable.find(
    (candidate) => !candidate.formatKey?.endsWith(".story"),
  );
  return (feed ?? usable[0])?.id ?? null;
}

export function boostAdHref(projectId: string, creativeId: string): string {
  const params = new URLSearchParams({ module: "ads", post: creativeId });
  return `/projects/${encodeURIComponent(projectId)}?${params.toString()}`;
}
