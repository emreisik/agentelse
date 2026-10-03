// Sağ paneldeki Calendar sekmesinin saf görünüm mantığı (IO yok): arama,
// platform/durum/biçim süzgeçleri, sıralama ve günlere gruplama. Durumun
// kendisi (stage) burada hesaplanmaz; sunucunun `loadCalendarData`'sından
// ve istemcinin `rescheduleItem`'ından gelir.

import type { FormatGlyph } from "@/lib/content-channels";

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

// `skip` verilen boyut yok sayılır: her süzgeç şeridi, kendisi hariç diğer
// süzgeçlere göre sayar (platform sayıları seçili durumu yansıtır vb.).
export function filterItems(
  items: readonly CalendarItem[],
  filter: PanelFilter,
  skip?: "sources" | "stages" | "glyphs",
): CalendarItem[] {
  return items.filter(
    (item) =>
      matchesQuery(item, filter.query) &&
      (skip === "sources" ||
        filter.sources.size === 0 ||
        filter.sources.has(item.source.key)) &&
      (skip === "stages" ||
        filter.stages.size === 0 ||
        filter.stages.has(item.stage)) &&
      (skip === "glyphs" ||
        filter.glyphs.size === 0 ||
        (item.glyph !== null && filter.glyphs.has(item.glyph))),
  );
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

const STAGE_RANK = new Map(STAGE_ORDER.map((stage, index) => [stage, index]));

export function sortItems(
  items: readonly CalendarItem[],
  sort: PanelSort,
): CalendarItem[] {
  // Düz kod noktası karşılaştırması: localeCompare "~" işaretini rakamlardan
  // önceye koyar, günü olmayanlar başa düşerdi.
  const byWhen = (a: CalendarItem, b: CalendarItem) => {
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
        (a, b) => a.source.label.localeCompare(b.source.label) || byWhen(a, b),
      );
    default:
      return list.sort(byWhen);
  }
}

export type DayGroup = { day: string; items: CalendarItem[] };

// Günü olan parçaları gün gün gruplar; günlerin sırası `order`'a göre, gün
// içi sıra verilen listenin sırasıdır (önce sortItems).
export function groupByDay(
  items: readonly CalendarItem[],
  order: "asc" | "desc" = "asc",
): DayGroup[] {
  const map = new Map<string, CalendarItem[]>();
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

export type ItemGroup = {
  key: string;
  kind: "day" | "stage" | "source";
  items: CalendarItem[];
};

// Liste görünümünün başlıkları sıralamaya uyar: tarih sıralamasında günler,
// "önce benden beklenenler"de durumlar, platforma göre sıralamada platformlar.
// Günü olmayanlar burada yok (atanmamış tepsisinde).
export function groupForSort(
  items: readonly CalendarItem[],
  sort: PanelSort,
): ItemGroup[] {
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
  const map = new Map<string, CalendarItem[]>();
  for (const item of sorted) {
    const key = kind === "stage" ? item.stage : item.source.key;
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
// rengi, gerisi sayıyla.
export function dayDots(
  items: readonly CalendarItem[],
  max = 3,
): { colors: string[]; total: number; attention: boolean } {
  const colors: string[] = [];
  for (const item of items) {
    if (colors.length >= max) break;
    if (!colors.includes(item.source.color)) colors.push(item.source.color);
  }
  return {
    colors,
    total: items.length,
    attention: items.some(
      (item) =>
        item.stage === "failed" ||
        item.stage === "missed" ||
        item.stage === "held",
    ),
  };
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
