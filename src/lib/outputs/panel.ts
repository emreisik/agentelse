// Sağ panelin Outputs sekmesinin saf mantığı (IO yok): bir parçanın biçim
// türü, arama, durum/platform/biçim süzgeçleri ve sıralama. Sunucu ucu
// (/api/projects/[id]/outputs) parçaları bu şekle çevirir; süzme ve sayma
// istemcide yapılır, böylece her tıklama anında olur.

import type { CalendarSource } from "@/lib/calendar/types";
import type { FormatGlyph } from "@/lib/content-channels";

export type OutputStatus =
  "DRAFT" | "IN_REVIEW" | "APPROVED" | "REJECTED" | "PUBLISHED";

// Panelde gösterilen durum: onaylı ve günü atanmış parça "Scheduled" olur.
export type OutputPhase =
  "draft" | "review" | "approved" | "scheduled" | "published" | "rejected";

export type OutputKind =
  "post" | "carousel" | "story" | "reel" | "video" | "ad" | "text";

export type OutputItem = {
  id: string;
  title: string | null;
  // Metnin kısaltılmış önizlemesi.
  preview: string | null;
  // Kopyalamak için tam metin (copy ya da caption).
  text: string | null;
  status: OutputStatus;
  phase: OutputPhase;
  kind: OutputKind;
  // "Instagram · Carousel" ya da yalnız platform/tür adı.
  label: string;
  source: CalendarSource;
  assetId: string | null;
  version: number | null;
  // Bekleyen onay kaydı: kart üstünden onay/ret bununla yapılır.
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  scheduledFor: string | null;
  // Proje saat diliminde "YYYY-MM-DDTHH:mm".
  scheduledLocal: string | null;
};

export type OutputsPayload = {
  items: OutputItem[];
  // Sınır yüzünden en eskiler gelmediyse true.
  truncated: boolean;
  timezone: string;
};

export const PHASE_META: Record<
  OutputPhase,
  { label: string; tone: "muted" | "pending" | "ok" | "active" | "danger" }
> = {
  review: { label: "Needs review", tone: "pending" },
  draft: { label: "Draft", tone: "muted" },
  approved: { label: "Approved", tone: "ok" },
  scheduled: { label: "Scheduled", tone: "active" },
  published: { label: "Published", tone: "ok" },
  rejected: { label: "Rejected", tone: "danger" },
};

// Süzgeç şeridindeki sıra: önce kullanıcıdan bir şey bekleyenler.
export const PHASE_ORDER: readonly OutputPhase[] = [
  "review",
  "draft",
  "approved",
  "scheduled",
  "published",
  "rejected",
];

export const KIND_LABEL: Record<OutputKind, string> = {
  post: "Post",
  carousel: "Carousel",
  story: "Story",
  reel: "Reel",
  video: "Video",
  ad: "Ad",
  text: "Text",
};

export const KIND_ORDER: readonly OutputKind[] = [
  "post",
  "carousel",
  "story",
  "reel",
  "video",
  "ad",
  "text",
];

export function phaseOf(
  status: OutputStatus,
  scheduledFor: string | null,
): OutputPhase {
  switch (status) {
    case "IN_REVIEW":
      return "review";
    case "APPROVED":
      return scheduledFor ? "scheduled" : "approved";
    case "PUBLISHED":
      return "published";
    case "REJECTED":
      return "rejected";
    default:
      return "draft";
  }
}

const TEXT_GLYPHS: ReadonlySet<FormatGlyph> = new Set([
  "text",
  "thread",
  "article",
]);

// Biçim türü: kanal planının biçim simgesi (glyph) önceliklidir, yoksa son
// sürümün içerik biçimi ve parçanın türü.
export function kindOf(input: {
  type: string;
  contentFormat: string | null;
  glyph: FormatGlyph | null;
}): OutputKind {
  if (input.type === "AD_CREATIVE" || input.type === "CAMPAIGN_BRIEF") {
    return "ad";
  }
  if (input.glyph === "campaign") return "ad";
  if (input.glyph === "carousel") return "carousel";
  if (input.glyph === "story" || input.contentFormat === "STORY") {
    return "story";
  }
  if (
    input.glyph === "reel" ||
    input.contentFormat === "REEL" ||
    input.contentFormat === "SHORTS"
  ) {
    return "reel";
  }
  if (input.glyph === "video") return "video";
  if (
    (input.glyph && TEXT_GLYPHS.has(input.glyph)) ||
    input.type === "CAPTION" ||
    input.type === "COPY" ||
    input.type === "CONTENT_PLAN"
  ) {
    return "text";
  }
  return "post";
}

export type OutputSort = "newest" | "oldest" | "updated" | "attention" | "date";

export const OUTPUT_SORTS: readonly { key: OutputSort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "updated", label: "Recently changed" },
  { key: "attention", label: "Needs me first" },
  { key: "date", label: "Publish date" },
  { key: "oldest", label: "Oldest" },
];

export type OutputFilter = {
  query: string;
  phases: ReadonlySet<OutputPhase>;
  sources: ReadonlySet<string>;
  kinds: ReadonlySet<OutputKind>;
};

export const EMPTY_OUTPUT_FILTER: OutputFilter = {
  query: "",
  phases: new Set(),
  sources: new Set(),
  kinds: new Set(),
};

function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").normalize("NFKD");
}

export function matchesOutputQuery(item: OutputItem, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  const haystack = normalize(
    [item.title, item.text ?? item.preview, item.label, item.source.label]
      .filter(Boolean)
      .join(" "),
  );
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

// `skip` verilen boyut yok sayılır: her şerit kendisi hariç diğer süzgeçlere
// göre sayar.
export function filterOutputs(
  items: readonly OutputItem[],
  filter: OutputFilter,
  skip?: "phases" | "sources" | "kinds",
): OutputItem[] {
  return items.filter(
    (item) =>
      matchesOutputQuery(item, filter.query) &&
      (skip === "phases" ||
        filter.phases.size === 0 ||
        filter.phases.has(item.phase)) &&
      (skip === "sources" ||
        filter.sources.size === 0 ||
        filter.sources.has(item.source.key)) &&
      (skip === "kinds" ||
        filter.kinds.size === 0 ||
        filter.kinds.has(item.kind)),
  );
}

export function activeOutputFilters(filter: OutputFilter): number {
  return (
    filter.phases.size +
    filter.sources.size +
    filter.kinds.size +
    (filter.query.trim() ? 1 : 0)
  );
}

const PHASE_RANK = new Map(PHASE_ORDER.map((phase, index) => [phase, index]));

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortOutputs(
  items: readonly OutputItem[],
  sort: OutputSort,
): OutputItem[] {
  const list = [...items];
  const newest = (a: OutputItem, b: OutputItem) =>
    cmp(b.createdAt, a.createdAt);
  switch (sort) {
    case "oldest":
      return list.sort((a, b) => cmp(a.createdAt, b.createdAt));
    case "updated":
      return list.sort((a, b) => cmp(b.updatedAt, a.updatedAt));
    case "attention":
      return list.sort(
        (a, b) =>
          (PHASE_RANK.get(a.phase) ?? 99) - (PHASE_RANK.get(b.phase) ?? 99) ||
          newest(a, b),
      );
    case "date":
      // Günü olanlar yayın sırasıyla önde, olmayanlar en yeniden eskiye.
      return list.sort((a, b) => {
        if (a.scheduledFor && b.scheduledFor) {
          return cmp(a.scheduledFor, b.scheduledFor);
        }
        if (a.scheduledFor) return -1;
        if (b.scheduledFor) return 1;
        return newest(a, b);
      });
    default:
      return list.sort(newest);
  }
}

export function countOutputs<K>(
  items: readonly OutputItem[],
  key: (item: OutputItem) => K,
): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
