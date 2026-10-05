// Takvimde bir post = tek girdi (IO yok; docs/works.md "Posts"). Bir postun
// mecra teslimatları (aynı postId) panoda ve sağ paneldeki takvimde tek kart
// olur: postun başlığı ve görseli, her teslimatın simgesi ve postun birleşik
// durumu. Postu olmayan (eski) parça kendi girdisidir. Girdi ilk teslimatın
// kimliğini taşır (adres, sürükleme, detay); taşıma bütün postu götürür.

import { rescheduleItem, type RescheduleContext } from "./item";
import type { CalendarStage } from "./stage";
import type { CalendarItem, CalendarSource } from "./types";

export type PostEntry<T extends CalendarItem = CalendarItem> = T & {
  // Teslim sırasıyla (sunucu listesi: zaman, sonra oluşturulma = planın mecra
  // sırası); ilki girdinin kendisidir.
  deliveries: readonly T[];
};

function isEntry(item: CalendarItem): item is PostEntry {
  return "deliveries" in item;
}

// Girdinin teslimatları: postun mecraları ya da parçanın kendisi.
export function deliveriesOf(item: CalendarItem): readonly CalendarItem[] {
  return isEntry(item) ? item.deliveries : [item];
}

// Girdinin mecraları, teslim sırasıyla; aynı mecradaki post ve story bir kez.
export function sourcesOf(item: CalendarItem): CalendarSource[] {
  const seen = new Map<string, CalendarSource>();
  for (const delivery of deliveriesOf(item)) {
    if (!seen.has(delivery.source.key)) {
      seen.set(delivery.source.key, delivery.source);
    }
  }
  return [...seen.values()];
}

// Postun birleşik durumu: bir teslimatı başarısızsa Failed, hepsi yayındaysa
// Published, yoksa en geride olanı. Sıra plan panelinin postStateOf'uyla aynı:
// içerik bekleyen > reddedilen > onay bekleyen > onaylı.
const POST_STAGE_ORDER: readonly CalendarStage[] = [
  "failed",
  "missed",
  "needs-content",
  "rejected",
  "needs-approval",
  "held",
  "manual",
  "scheduled",
  "publishing",
  "published",
];

export function postStageOf(stages: readonly CalendarStage[]): CalendarStage {
  return (
    POST_STAGE_ORDER.find((stage) => stages.includes(stage)) ??
    stages[0] ??
    "needs-content"
  );
}

// Aynı postun aynı gün ve saatteki teslimatları tek girdi. Post tek parça
// taşınır; yine de ayrı zamanlara düşmüş eski bir postun parçaları kendi
// günlerinde görünür (yanlış günde tek kart göstermektense).
function entryKey(item: CalendarItem): string {
  return item.postId
    ? `post:${item.postId}|${item.localDay ?? ""}|${item.localTime ?? ""}`
    : `item:${item.id}`;
}

function firstOf<T, V>(
  list: readonly T[],
  pick: (value: T) => V | null,
): V | null {
  for (const value of list) {
    const picked = pick(value);
    if (picked !== null) return picked;
  }
  return null;
}

function entryOf<T extends CalendarItem>(
  deliveries: readonly T[],
): PostEntry<T> {
  const lead = deliveries[0]!;
  if (deliveries.length === 1) return { ...lead, deliveries };
  const stage = postStageOf(deliveries.map((delivery) => delivery.stage));
  return {
    ...lead,
    title: lead.title ?? firstOf(deliveries, (d) => d.title),
    preview: lead.preview ?? firstOf(deliveries, (d) => d.preview),
    // Post tek görsellidir: metin mecrasıyla başlayan postta da görünsün.
    assetId: lead.assetId ?? firstOf(deliveries, (d) => d.assetId),
    label: deliveries.map((delivery) => delivery.label).join(", "),
    stage,
    reason:
      deliveries.find((delivery) => delivery.stage === stage)?.reason ?? null,
    overdue: deliveries.some((delivery) => delivery.overdue),
    movable: deliveries.every((delivery) => delivery.movable),
    deliveries,
  };
}

export type EntryCache<T extends CalendarItem> = Map<string, PostEntry<T>>;

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Girdiler, ilk teslimatlarının listedeki sırasıyla. `cache` verilirse
// teslimatları değişmeyen girdi ESKİ nesnesiyle döner: memo'lu kartlar her
// yoklamada yeniden render olmasın (öğeler zaten reuseUnchanged'den geçer).
export function groupPosts<T extends CalendarItem>(
  items: readonly T[],
  cache?: EntryCache<T>,
): PostEntry<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = entryKey(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const entries: PostEntry<T>[] = [];
  for (const [key, deliveries] of groups) {
    const hit = cache?.get(key);
    if (hit && sameList(hit.deliveries, deliveries)) {
      entries.push(hit);
      continue;
    }
    const entry = entryOf(deliveries);
    cache?.set(key, entry);
    entries.push(entry);
  }
  if (cache) {
    for (const key of cache.keys()) {
      if (!groups.has(key)) cache.delete(key);
    }
  }
  return entries;
}

// Taşınınca birlikte gidenler: postun yüklü bütün teslimatları (sunucu da
// postu tek parça taşır, server/works/post-move.ts); postu olmayan parça tek
// başına. Listedeki GÜNCEL nesneler döner.
export function postGroupOf<T extends CalendarItem>(
  items: readonly T[],
  item: T,
): T[] {
  const group = items.filter((other) =>
    item.postId ? other.postId === item.postId : other.id === item.id,
  );
  return group.length > 0 ? group : [item];
}

export type PostMove<T> =
  { ok: true; moved: T[] } | { ok: false; reason: string };

// Sürükle-bırakın ve detaydaki saat seçicinin iyimser hali: postun bütün
// teslimatları aynı yeni zamana geçer, her birinin durumu kendi olgularından
// yeniden türetilir. Bir parçası yayında olan post taşınmaz (sunucu da
// reddeder; post iki zamana bölünmez).
export function reschedulePost<T extends CalendarItem>(
  items: readonly T[],
  item: T,
  localDateTime: string | null,
  context: RescheduleContext,
): PostMove<T> {
  const group = postGroupOf(items, item);
  if (group.length > 1) {
    if (group.some((delivery) => delivery.stage === "published")) {
      return {
        ok: false,
        reason: "Part of this post is already posted, so it can't be moved.",
      };
    }
    if (group.some((delivery) => delivery.stage === "publishing")) {
      return {
        ok: false,
        reason:
          "Part of this post is being sent right now, so it can't be moved.",
      };
    }
  }
  return {
    ok: true,
    moved: group.map((delivery) =>
      rescheduleItem(delivery, localDateTime, context),
    ),
  };
}
