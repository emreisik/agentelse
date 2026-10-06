import { cosine } from "./vector";

// Sorgu kümeleri (docs/google-search-console-plan.md SC-F4): iki sorgu aynı
// kümededir ya aynı sayfa ikisinin de gösterimlerinin ≥%30'unu alıyorsa
// (Google onları aynı konu sayıyor) ya da gömmeleri kosinüs ≥ 0,82 ise.
// Birleşim-bul (union-find) ile geçişli kapanış alınır; 3'ten küçük kümeler
// atılır. Haftadan haftaya kimlik matchClusters ile taşınır (Jaccard ≥ 0,5).
// Saf ve izomorfik.

export const CLUSTER_COSINE_MIN = 0.82;
export const CLUSTER_SHARE_MIN = 0.3;
export const CLUSTER_MIN_SIZE = 3;
export const CLUSTER_MAX_QUERIES = 2000;
const CLUSTER_MATCH_MIN = 0.5;

export type ClusterQueryInput = {
  queryId: string;
  impressions: number;
  clicks: number;
  topPageId: string | null;
  topPageShare: number;
  vector: Float32Array | null;
};

export type BuiltCluster = {
  // Kümedeki en küçük queryId: aynı üyeler her çalışmada aynı anahtarı verir.
  key: string;
  // Gösterime göre azalan.
  queryIds: string[];
  impressions: number;
  clicks: number;
  pillarPageId: string | null;
};

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function createUnionFind(size: number) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let node = index;
    while (parent[node] !== root) {
      const next = parent[node]!;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (rootA < rootB) parent[rootB] = rootA;
    else parent[rootA] = rootB;
  };
  return { find, union };
}

export function buildClusters(
  queries: readonly ClusterQueryInput[],
): BuiltCluster[] {
  const items = [...queries]
    .sort(
      (a, b) =>
        finiteOrZero(b.impressions) - finiteOrZero(a.impressions) ||
        compareIds(a.queryId, b.queryId),
    )
    .slice(0, CLUSTER_MAX_QUERIES);
  const { find, union } = createUnionFind(items.length);

  // (a) Ortak baskın sayfa.
  const byPage = new Map<string, number>();
  items.forEach((item, index) => {
    if (!item.topPageId || !(item.topPageShare >= CLUSTER_SHARE_MIN)) return;
    const first = byPage.get(item.topPageId);
    if (first === undefined) byPage.set(item.topPageId, index);
    else union(first, index);
  });

  // (b) Anlam yakınlığı.
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i]!.vector;
    if (!a) continue;
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j]!.vector;
      if (!b || find(i) === find(j)) continue;
      if (cosine(a, b) >= CLUSTER_COSINE_MIN) union(i, j);
    }
  }

  const groups = new Map<number, ClusterQueryInput[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(item);
    else groups.set(root, [item]);
  });

  const clusters: BuiltCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < CLUSTER_MIN_SIZE) continue;
    const pageImpressions = new Map<string, number>();
    let impressions = 0;
    let clicks = 0;
    for (const member of members) {
      const value = finiteOrZero(member.impressions);
      impressions += value;
      clicks += finiteOrZero(member.clicks);
      if (member.topPageId) {
        pageImpressions.set(
          member.topPageId,
          (pageImpressions.get(member.topPageId) ?? 0) + value,
        );
      }
    }
    let pillarPageId: string | null = null;
    let pillarImpressions = -1;
    for (const [pageId, value] of pageImpressions) {
      if (
        value > pillarImpressions ||
        (value === pillarImpressions &&
          pillarPageId !== null &&
          compareIds(pageId, pillarPageId) < 0)
      ) {
        pillarPageId = pageId;
        pillarImpressions = value;
      }
    }
    const queryIds = members.map((member) => member.queryId);
    clusters.push({
      key: [...queryIds].sort(compareIds)[0]!,
      queryIds,
      impressions,
      clicks,
      pillarPageId,
    });
  }
  return clusters.sort(
    (a, b) => b.impressions - a.impressions || compareIds(a.key, b.key),
  );
}

function jaccard(a: ReadonlySet<string>, b: readonly string[]): number {
  let shared = 0;
  const unique = new Set(b);
  for (const id of unique) if (a.has(id)) shared += 1;
  const union = a.size + unique.size - shared;
  return union === 0 ? 0 : shared / union;
}

// Önceki kümelerin kimliklerini yeni kümelere taşır: en yüksek Jaccard'dan
// başlayarak açgözlü, bire bir, yalnız ≥ 0,5. Dönen harita next.key →
// previous.id.
export function matchClusters(
  previous: readonly { id: string; queryIds: readonly string[] }[],
  next: readonly BuiltCluster[],
): Map<string, string> {
  const candidates: { key: string; id: string; score: number }[] = [];
  const previousSets = previous.map((cluster) => ({
    id: cluster.id,
    ids: new Set(cluster.queryIds),
  }));
  for (const cluster of next) {
    for (const old of previousSets) {
      const score = jaccard(old.ids, cluster.queryIds);
      if (score >= CLUSTER_MATCH_MIN) {
        candidates.push({ key: cluster.key, id: old.id, score });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score || compareIds(a.key, b.key) || compareIds(a.id, b.id),
  );
  const matched = new Map<string, string>();
  const used = new Set<string>();
  for (const candidate of candidates) {
    if (matched.has(candidate.key) || used.has(candidate.id)) continue;
    matched.set(candidate.key, candidate.id);
    used.add(candidate.id);
  }
  return matched;
}
