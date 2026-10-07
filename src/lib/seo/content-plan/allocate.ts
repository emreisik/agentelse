import type { PlanCandidate } from "./types";

// Slot dağıtımı (SC-F7): D'Hondt benzeri. Her seçimde, kovasında (küme; kümesiz
// adayların hepsi TEK "_ungrouped" kovasını paylaşır) şimdiye dek seçilen sayıya
// göre bölünmüş en yüksek skorlu uygun aday alınır; böylece slotlar kümelerin
// payına orantılı dağılır. Saf ve belirleyici.

export const UNGROUPED_BUCKET = "_ungrouped";
const TIE_EPSILON = 1e-12;

export function MAX_PILLARS(cap: number): number {
  return cap >= 8 ? 2 : 1;
}

export function maxPerCluster(cap: number): number {
  return Math.max(1, Math.floor(cap / 3));
}

export type AllocateSkipReason =
  "CLUSTER_LIMIT" | "NEEDS_PILLAR" | "PILLAR_LIMIT" | "CAPACITY";

export type AllocateResult = {
  chosen: PlanCandidate[];
  skipped: { candidateId: string; reason: AllocateSkipReason }[];
  relaxed: boolean;
};

export function allocateSlots(
  candidates: readonly PlanCandidate[],
  options: {
    capacity: number;
    cap: number;
    strongPillarClusterIds: readonly string[];
  },
): AllocateResult {
  const capacity = Number.isFinite(options.capacity)
    ? Math.max(0, Math.floor(options.capacity))
    : 0;
  if (capacity === 0 || candidates.length === 0) {
    return { chosen: [], skipped: [], relaxed: false };
  }
  const strong = new Set(options.strongPillarClusterIds);
  const maxPillars = MAX_PILLARS(options.cap);
  let limit = maxPerCluster(options.cap);
  // Zayıf ana sayfalı kümenin PILLAR adayı listede varsa, SUPPORT'u ondan sonra
  // gelir. PILLAR adayı hiç yoksa (ör. doorway elediyse) beklenecek bir şey
  // olmadığından SUPPORT serbesttir.
  const pillarClusters = new Set(
    candidates
      .filter((candidate) => candidate.kind === "PILLAR" && candidate.clusterId !== null)
      .map((candidate) => candidate.clusterId as string),
  );

  const bucketOf = (candidate: PlanCandidate) =>
    candidate.clusterId ?? UNGROUPED_BUCKET;
  const picksInBucket = new Map<string, number>();
  const chosenPillarClusters = new Set<string>();
  const chosen: PlanCandidate[] = [];
  const taken = new Set<string>();
  let pillarPicks = 0;
  let relaxed = false;

  const gated = (candidate: PlanCandidate): boolean =>
    candidate.kind === "SUPPORT" &&
    candidate.clusterId !== null &&
    !strong.has(candidate.clusterId) &&
    pillarClusters.has(candidate.clusterId) &&
    !chosenPillarClusters.has(candidate.clusterId);

  const eligible = (candidate: PlanCandidate): boolean => {
    if (taken.has(candidate.id)) return false;
    if ((picksInBucket.get(bucketOf(candidate)) ?? 0) >= limit) return false;
    if (candidate.kind === "PILLAR" && pillarPicks >= maxPillars) return false;
    return !gated(candidate);
  };

  const pickBest = (): PlanCandidate | null => {
    let best: PlanCandidate | null = null;
    let bestValue = -1;
    for (const candidate of candidates) {
      if (!eligible(candidate)) continue;
      const value = candidate.score / (1 + (picksInBucket.get(bucketOf(candidate)) ?? 0));
      if (
        best === null ||
        value > bestValue + TIE_EPSILON ||
        (Math.abs(value - bestValue) <= TIE_EPSILON && candidate.id < best.id)
      ) {
        best = candidate;
        bestValue = value;
      }
    }
    return best;
  };

  while (chosen.length < capacity) {
    let pick = pickBest();
    if (pick === null && !relaxed) {
      // İkinci geçiş: kova sınırı bir kez gevşetilir (az kümeli planlar boş kalmasın).
      limit += 1;
      pick = pickBest();
      if (pick === null) {
        limit -= 1;
        break;
      }
      relaxed = true;
    }
    if (pick === null) break;
    chosen.push(pick);
    taken.add(pick.id);
    picksInBucket.set(bucketOf(pick), (picksInBucket.get(bucketOf(pick)) ?? 0) + 1);
    if (pick.kind === "PILLAR") {
      pillarPicks += 1;
      if (pick.clusterId !== null) chosenPillarClusters.add(pick.clusterId);
    }
  }

  const skipped: AllocateResult["skipped"] = [];
  for (const candidate of candidates) {
    if (taken.has(candidate.id)) continue;
    let reason: AllocateSkipReason = "CAPACITY";
    if (gated(candidate)) reason = "NEEDS_PILLAR";
    else if (candidate.kind === "PILLAR" && pillarPicks >= maxPillars) reason = "PILLAR_LIMIT";
    else if ((picksInBucket.get(bucketOf(candidate)) ?? 0) >= limit) reason = "CLUSTER_LIMIT";
    skipped.push({ candidateId: candidate.id, reason });
  }
  return { chosen, skipped, relaxed };
}
