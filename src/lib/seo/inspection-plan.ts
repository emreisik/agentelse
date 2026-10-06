import { addDays } from "./dates";

// URL Inspection örnekleyicisinin saf planı (docs/search-health.md "URL
// Inspection"). Öncelik sırası:
// - P1: kuyruk (kullanıcı + bekçi); her zaman, P6 payına bakmadan.
// - P2: taban çizgisinden sonra sitemap'e giren, en çok 14 gün önce görülen
//   URL'ler; en çok 3 kez, aralarında en az 3 gün.
// - P3: tıklamada ilk 50; 7 günde bir.
// - P4: tıklaması yarıdan fazla düşen sayfalar; 3 günde bir.
// - P5: tarayıcının şüphelendikleri (TA7/TA8); 7 günde bir.
// - P6: haftalık deterministik sitemap örneği; kalan yuvaları doldurur.
// P2–P5 toplamı nonP6Cap'i aşmaz: günün P6 payı bütçede ayrılmış kalır.
// Aynı URL bir kez, en yüksek önceliğiyle planlanır.

export type InspectionReason = "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

export type InspectionHistory = {
  lastInspectedAt: Date | null;
  inspectCount: number;
};

export type InspectionPlanInput = {
  now: Date;
  slots: number;
  nonP6Cap: number;
  p1: string[];
  p2: (InspectionHistory & { url: string; firstSeenAt: Date })[];
  p3: (InspectionHistory & { url: string })[];
  p4: (InspectionHistory & { url: string })[];
  p5: (InspectionHistory & { url: string })[];
  p6: { pool: string[]; seed: string };
};

const DAY_MS = 86_400_000;
export const P2_WINDOW_MS = 14 * DAY_MS;
export const P2_MAX_INSPECTIONS = 3;
export const P2_GAP_MS = 3 * DAY_MS;
export const P3_GAP_MS = 7 * DAY_MS;
export const P4_GAP_MS = 3 * DAY_MS;
export const P5_GAP_MS = 7 * DAY_MS;

function inspectedBefore(
  history: InspectionHistory,
  now: Date,
  gapMs: number,
): boolean {
  return (
    history.lastInspectedAt === null ||
    now.getTime() - history.lastInspectedAt.getTime() >= gapMs
  );
}

export function planInspections(
  input: InspectionPlanInput,
): { url: string; reason: InspectionReason }[] {
  const { now } = input;
  const slots = Math.max(0, Math.floor(input.slots));
  const nonP6Cap = Math.max(0, Math.floor(input.nonP6Cap));
  const plan: { url: string; reason: InspectionReason }[] = [];
  const seen = new Set<string>();
  let nonP6 = 0;

  const add = (url: string, reason: InspectionReason): boolean => {
    if (plan.length >= slots) return false;
    if (seen.has(url)) return true;
    if (reason !== "P1" && reason !== "P6" && nonP6 >= nonP6Cap) return false;
    seen.add(url);
    plan.push({ url, reason });
    if (reason !== "P6") nonP6 += 1;
    return true;
  };

  for (const url of input.p1) if (!add(url, "P1")) break;

  const p2 = input.p2.filter(
    (row) =>
      now.getTime() - row.firstSeenAt.getTime() <= P2_WINDOW_MS &&
      row.firstSeenAt.getTime() <= now.getTime() &&
      row.inspectCount < P2_MAX_INSPECTIONS &&
      inspectedBefore(row, now, P2_GAP_MS),
  );
  const ordered: [InspectionReason, string[]][] = [
    ["P2", p2.map((row) => row.url)],
    [
      "P3",
      input.p3
        .filter((row) => inspectedBefore(row, now, P3_GAP_MS))
        .map((row) => row.url),
    ],
    [
      "P4",
      input.p4
        .filter((row) => inspectedBefore(row, now, P4_GAP_MS))
        .map((row) => row.url),
    ],
    [
      "P5",
      input.p5
        .filter((row) => inspectedBefore(row, now, P5_GAP_MS))
        .map((row) => row.url),
    ],
  ];
  for (const [reason, urls] of ordered) {
    for (const url of urls) if (!add(url, reason)) break;
  }

  for (const url of sampleOrder(input.p6.pool, input.p6.seed)) {
    if (!add(url, "P6")) break;
  }
  return plan;
}

// Haftanın P6 hedefine yetişmek için bugün kalan örnek sayısı: günün
// başındaki eksik, haftanın kalan günlerine (bugün dahil) eşit bölünür.
export function dailyP6Target(input: {
  target: number;
  sampledThisWeek: number;
  sampledToday: number;
  today: string;
  weekStart: string;
}): number {
  const target = Math.max(0, Math.floor(input.target));
  const sampledToday = Math.max(0, input.sampledToday);
  const sampledThisWeek = Math.max(sampledToday, input.sampledThisWeek);
  let index = 0;
  while (index < 6 && addDays(input.weekStart, index) < input.today) {
    index += 1;
  }
  const daysLeft = 7 - index;
  const missingAtDayStart = Math.max(
    0,
    target - (sampledThisWeek - sampledToday),
  );
  const perDay = Math.ceil(missingAtDayStart / daysLeft);
  return Math.max(0, Math.min(perDay - sampledToday, target - sampledThisWeek));
}

// FNV-1a 32 bit: tohum + URL'den sabit bir sıra.
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Aynı tohum aynı sırayı verir (hafta boyunca örnek kaymaz); alt küme aynı
// göreli sırayı korur.
export function sampleOrder(urls: readonly string[], seed: string): string[] {
  return [...new Set(urls)]
    .map((url) => ({ url, key: fnv1a32(`${seed}|${url}`) }))
    .sort(
      (a, b) => a.key - b.key || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    )
    .map((entry) => entry.url);
}
