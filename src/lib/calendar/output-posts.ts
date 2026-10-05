// Outputs listesinde bir post = tek kart (IO yok; docs/works.md "Posts").
// Bir postun mecra teslimatları (aynı postId) tek kart olur; postu olmayan
// parça kendi kartıdır. Süzgeçler takvimdeki gibi teslimat başına çalışır:
// teslimatlarından biri uyan post görünür. Kartın onayı postu onaylar.

import {
  filterOutputs,
  phaseOf,
  sortOutputs,
  type OutputFilter,
  type OutputItem,
  type OutputPhase,
  type OutputSort,
  type OutputsPayload,
} from "@/lib/outputs/panel";

// Sunucunun gönderdiği parça: Outputs öğesi + postu (yoksa null).
export type OutputDelivery = OutputItem & { postId: string | null };

export type OutputPostsPayload = Omit<OutputsPayload, "items"> & {
  items: OutputDelivery[];
};

export type OutputEntry = OutputDelivery & {
  // Oluşturulma sırasıyla (planın mecra sırası); ilki kartın kendisidir.
  deliveries: readonly OutputDelivery[];
};

// Postun birleşik aşaması: en geride olanı. Sıra plan panelinin postStateOf'u
// ve takvimin postStageOf'uyla aynı: taslak > reddedilen > onay bekleyen.
const POST_PHASE_ORDER: readonly OutputPhase[] = [
  "draft",
  "rejected",
  "review",
  "approved",
  "scheduled",
  "published",
];

export function postPhaseOf(phases: readonly OutputPhase[]): OutputPhase {
  return (
    POST_PHASE_ORDER.find((phase) => phases.includes(phase)) ??
    phases[0] ??
    "draft"
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstOf<V>(
  list: readonly OutputDelivery[],
  pick: (delivery: OutputDelivery) => V | null,
): V | null {
  for (const delivery of list) {
    const picked = pick(delivery);
    if (picked !== null) return picked;
  }
  return null;
}

// Kartın onay kaydı: bekleyen bir onay varsa ve her mecranın içeriği hazırsa
// (approvePostAction aksi halde reddeder) ilk bekleyen; yoksa null.
function approvalOf(deliveries: readonly OutputDelivery[]): string | null {
  if (deliveries.some((delivery) => delivery.status === "DRAFT")) return null;
  return firstOf(deliveries, (delivery) => delivery.approvalId);
}

function entryOf(list: readonly OutputDelivery[]): OutputEntry {
  const deliveries = [...list].sort(
    (a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
  );
  const lead = deliveries[0]!;
  if (deliveries.length === 1) {
    return { ...lead, approvalId: approvalOf(deliveries), deliveries };
  }
  return {
    ...lead,
    title: lead.title ?? firstOf(deliveries, (d) => d.title),
    preview: lead.preview ?? firstOf(deliveries, (d) => d.preview),
    text: lead.text ?? firstOf(deliveries, (d) => d.text),
    // Post tek görsellidir: metin mecrasıyla başlayan postta da görünsün.
    assetId: lead.assetId ?? firstOf(deliveries, (d) => d.assetId),
    // "Instagram · Post +2": diğer mecralar kartta simgeleriyle.
    label: `${lead.label} +${deliveries.length - 1}`,
    phase: postPhaseOf(deliveries.map((delivery) => delivery.phase)),
    approvalId: approvalOf(deliveries),
    updatedAt: deliveries.reduce(
      (latest, delivery) =>
        delivery.updatedAt > latest ? delivery.updatedAt : latest,
      lead.updatedAt,
    ),
    deliveries,
  };
}

// Kartlar, ilk görünen teslimatlarının sırasıyla (sunucu en yeniden eskiye).
export function groupOutputs(items: readonly OutputDelivery[]): OutputEntry[] {
  const groups = new Map<string, OutputDelivery[]>();
  for (const item of items) {
    const key = item.postId ? `post:${item.postId}` : `item:${item.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map(entryOf);
}

export type OutputDimension = "phases" | "sources" | "kinds";

// Teslimatlarından biri süzgece uyan kartlar (`skip`: o boyut yok sayılır).
export function filterOutputEntries(
  entries: readonly OutputEntry[],
  filter: OutputFilter,
  skip?: OutputDimension,
): OutputEntry[] {
  return entries.filter(
    (entry) => filterOutputs(entry.deliveries, filter, skip).length > 0,
  );
}

// Bir şeridin sayıları: her değer, seçilince kaç kart göstereceğini söyler;
// bir post, uyan teslimatlarının her değerinde bir kez sayılır.
export function countOutputEntries<K>(
  entries: readonly OutputEntry[],
  filter: OutputFilter,
  skip: OutputDimension,
  key: (delivery: OutputItem) => K,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const entry of entries) {
    const keys = new Set(
      filterOutputs(entry.deliveries, filter, skip).map(key),
    );
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function sortOutputEntries(
  entries: readonly OutputEntry[],
  sort: OutputSort,
): OutputEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return sortOutputs(entries, sort).flatMap((item) => {
    const entry = byId.get(item.id);
    return entry ? [entry] : [];
  });
}

// Kartın indirilecek görselleri: postun her biçimi kendi görselidir (post
// 3:4, story 9:16); aynı görsel bir kez.
export function assetsOf(entry: OutputEntry): string[] {
  return [
    ...new Set(
      entry.deliveries.flatMap((delivery) =>
        delivery.assetId ? [delivery.assetId] : [],
      ),
    ),
  ];
}

// Karar sonrası iyimser hal: kartın kararı bekleyen teslimatları yeni duruma
// geçer (post onayı, sunucuda da postun bekleyen bütün mecralarını onaylar).
export function applyDecision(
  items: readonly OutputDelivery[],
  entry: OutputEntry,
  to: "APPROVED" | "REJECTED",
): OutputDelivery[] {
  const waiting = new Set(
    entry.deliveries
      .filter((delivery) => delivery.approvalId)
      .map((delivery) => delivery.id),
  );
  return items.map((item) =>
    waiting.has(item.id)
      ? {
          ...item,
          status: to,
          phase: phaseOf(to, item.scheduledFor),
          approvalId: null,
        }
      : item,
  );
}
