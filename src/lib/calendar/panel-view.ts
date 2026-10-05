// Sağ paneldeki Calendar sekmesinin saf görünüm mantığı (IO yok): arama,
// platform/durum/biçim süzgeçleri, sıralama ve günlere gruplama. Durumun
// kendisi (stage) burada hesaplanmaz; sunucunun `loadCalendarData`'sından
// ve istemcinin `rescheduleItem`'ından gelir.
//
// Öğeler post girdileri de olabilir (posts.ts groupPosts): süzgeçler teslimat
// başına çalışır, teslimatlarından biri bütün süzgeçlere uyan post görünür.

import type { FormatGlyph } from "@/lib/content-channels";

import { deliveriesOf, sourcesOf } from "./posts";
import { STAGE_ORDER, type CalendarStage } from "./stage";
import type { CalendarItem } from "./types";

export type PanelSort = "soonest" | "latest" | "attention" | "platform";

export const PANEL_SORTS: readonly { key: PanelSort; label: string }[] = [
  { key: "soonest", label: "Soonest first" },
  { key: "latest", label: "Latest first" },
  { key: "attention", label: "Needs me first" },
  { key: "platform", label: "By platform" },
];

export type PanelFilter = {
  query: string;
  // Boş küme: hepsi.
  sources: ReadonlySet<string>;
  stages: ReadonlySet<CalendarStage>;
  glyphs: ReadonlySet<FormatGlyph>;
};

export const EMPTY_FILTER: PanelFilter = {
  query: "",
  sources: new Set(),
  stages: new Set(),
  glyphs: new Set(),
};

// Kullanıcının bir şey yapması gerekenler: hata, kaçan, bekleyen, onay, içerik.
export const ATTENTION_STAGES: ReadonlySet<CalendarStage> = new Set([
  "failed",
  "missed",
  "held",
  "needs-approval",
  "needs-content",
]);

export const GLYPH_LABEL: Record<FormatGlyph, string> = {
  image: "Post",
  carousel: "Carousel",
  reel: "Reel",
  story: "Story",
  video: "Video",
  text: "Text",
  thread: "Thread",
  article: "Article",
  campaign: "Campaign",
};

function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").normalize("NFKD");
}

export function matchesQuery(item: CalendarItem, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  const haystack = normalize(
    [item.title, item.preview, item.label, item.source.label]
      .filter(Boolean)
      .join(" "),
  );
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

export type FilterDimension = "sources" | "stages" | "glyphs";

// Tek bir teslimat süzgece uyuyor mu.
function passes(
  item: CalendarItem,
  filter: PanelFilter,
  skip?: FilterDimension,
): boolean {
  return (
    matchesQuery(item, filter.query) &&
    (skip === "sources" ||
      filter.sources.size === 0 ||
      filter.sources.has(item.source.key)) &&
    (skip === "stages" ||
      filter.stages.size === 0 ||
      filter.stages.has(item.stage)) &&
    (skip === "glyphs" ||
      filter.glyphs.size === 0 ||
      (item.glyph !== null && filter.glyphs.has(item.glyph)))
  );
}

// `skip` verilen boyut yok sayılır: her süzgeç şeridi, kendisi hariç diğer
// süzgeçlere göre sayar (platform sayıları seçili durumu yansıtır vb.). Bir
// post, teslimatlarından biri uyuyorsa görünür.
export function filterItems<T extends CalendarItem>(
  items: readonly T[],
  filter: PanelFilter,
  skip?: FilterDimension,
): T[] {
  return items.filter((item) =>
    deliveriesOf(item).some((delivery) => passes(delivery, filter, skip)),
  );
}

// Bir süzgeç şeridinin sayıları: her değer, seçilince kaç girdi gösterecekse
// o kadar. Bir post, uyan teslimatlarının her değerinde BİR kez sayılır
// (Instagram ve Facebook'taki bir post iki platformda da 1).
export function countEntries<K>(
  items: readonly CalendarItem[],
  filter: PanelFilter,
  skip: FilterDimension,
  key: (delivery: CalendarItem) => K | null,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const keys = new Set<K>();
    for (const delivery of deliveriesOf(item)) {
      if (!passes(delivery, filter, skip)) continue;
      const k = key(delivery);
      if (k !== null) keys.add(k);
    }
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function isFiltering(filter: PanelFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.sources.size > 0 ||
    filter.stages.size > 0 ||
    filter.glyphs.size > 0
  );
}

// "YYYY-MM-DDTHH:mm"; günü olmayan en sona.
function when(item: CalendarItem): string {
  return item.localDay ? `${item.localDay}T${item.localTime ?? "00:00"}` : "~";
}

function headline(item: CalendarItem): string {
  return item.title ?? item.preview ?? item.label;
}

// Platforma göre sıralama ve gruplama anahtarı: girdinin mecra kümesi (bir
// post bütün mecralarıyla tek grupta durur: "Instagram + Facebook").
export function sourceSetKey(item: CalendarItem): string {
  return sourcesOf(item)
    .map((source) => source.key)
    .join("+");
}

export function sourceSetLabel(item: CalendarItem): string {
  return sourcesOf(item)
    .map((source) => source.label)
    .join(" + ");
}

const STAGE_RANK = new Map(STAGE_ORDER.map((stage, index) => [stage, index]));

export function sortItems<T extends CalendarItem>(
  items: readonly T[],
  sort: PanelSort,
): T[] {
  // Düz kod noktası karşılaştırması: localeCompare "~" işaretini rakamlardan
  // önceye koyar, günü olmayanlar başa düşerdi.
  const byWhen = (a: T, b: T) => {
    const x = when(a);
    const y = when(b);
    return x < y ? -1 : x > y ? 1 : headline(a).localeCompare(headline(b));
  };
  const list = [...items];
  switch (sort) {
    case "latest":
      return list.sort((a, b) => byWhen(b, a));
    case "attention":
      return list.sort(
        (a, b) =>
          (STAGE_RANK.get(a.stage) ?? 99) - (STAGE_RANK.get(b.stage) ?? 99) ||
          byWhen(a, b),
      );
    case "platform":
      return list.sort(
        (a, b) =>
          sourceSetLabel(a).localeCompare(sourceSetLabel(b)) || byWhen(a, b),
      );
    default:
      return list.sort(byWhen);
  }
}

export type DayGroup<T extends CalendarItem = CalendarItem> = {
  day: string;
  items: T[];
};

// Günü olan parçaları gün gün gruplar; günlerin sırası `order`'a göre, gün
// içi sıra verilen listenin sırasıdır (önce sortItems).
export function groupByDay<T extends CalendarItem>(
  items: readonly T[],
  order: "asc" | "desc" = "asc",
): DayGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!item.localDay) continue;
    const bucket = map.get(item.localDay);
    if (bucket) bucket.push(item);
    else map.set(item.localDay, [item]);
  }
  const days = [...map.keys()].sort();
  if (order === "desc") days.reverse();
  return days.map((day) => ({ day, items: map.get(day)! }));
}

export type ItemGroup<T extends CalendarItem = CalendarItem> = {
  key: string;
  kind: "day" | "stage" | "source";
  items: T[];
};

// Liste görünümünün başlıkları sıralamaya uyar: tarih sıralamasında günler,
// "önce benden beklenenler"de durumlar (postun birleşik durumu), platforma
// göre sıralamada mecra kümeleri. Günü olmayanlar burada yok (tepside).
export function groupForSort<T extends CalendarItem>(
  items: readonly T[],
  sort: PanelSort,
): ItemGroup<T>[] {
  const sorted = sortItems(
    items.filter((item) => item.localDay),
    sort,
  );
  if (sort === "soonest" || sort === "latest") {
    return groupByDay(sorted, sort === "latest" ? "desc" : "asc").map(
      (group) => ({ key: group.day, kind: "day", items: group.items }),
    );
  }
  const kind = sort === "attention" ? "stage" : "source";
  const map = new Map<string, T[]>();
  for (const item of sorted) {
    const key = kind === "stage" ? item.stage : sourceSetKey(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].map(([key, list]) => ({ key, kind, items: list }));
}

export function countBy<K>(
  items: readonly CalendarItem[],
  key: (item: CalendarItem) => K | null,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

// Ay ızgarasında bir günün nokta göstergesi: en çok `max` farklı platform
// rengi (postların bütün mecraları), toplam girdi (post) sayısı ve bir
// teslimatın sorunu olup olmadığı.
export function dayDots(
  items: readonly CalendarItem[],
  max = 3,
): { colors: string[]; total: number; attention: boolean } {
  const colors: string[] = [];
  let attention = false;
  for (const item of items) {
    for (const delivery of deliveriesOf(item)) {
      if (colors.length < max && !colors.includes(delivery.source.color)) {
        colors.push(delivery.source.color);
      }
      if (
        delivery.stage === "failed" ||
        delivery.stage === "missed" ||
        delivery.stage === "held"
      ) {
        attention = true;
      }
    }
  }
  return { colors, total: items.length, attention };
}

// "Today", "Tomorrow", "Yesterday" ya da null (bugüne göre).
export function relativeDayLabel(
  day: string,
  todayKey: string,
  addDays: (key: string, delta: number) => string | null,
): string | null {
  if (day === todayKey) return "Today";
  if (day === addDays(todayKey, 1)) return "Tomorrow";
  if (day === addDays(todayKey, -1)) return "Yesterday";
  return null;
}
