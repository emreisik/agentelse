// Takvim öğelerinin saf dönüşümleri (IO yok): durumun ham olgulardan türetilmesi,
// yerel yeniden planlama ve sunucudan gelen taze verinin yerel değişikliklerle
// birleştirilmesi. Hepsi hem sunucuda (yükleyici) hem tarayıcıda (pano) çalışır.
//
// Neden var: bir parça başka güne taşınınca sayfanın sunucuda yeniden render
// edilmesi (kenar çubuğu rozetleri, journey snapshot... onlarca sorgu, çoğu
// seri) ekranı saniyelerce ağırlaştırıyordu. Artık yalnız tek bir yazma gider;
// yeni durum burada, aynı kurallarla istemcide yeniden hesaplanır.

import { zonedDateTimeToUtc } from "@/lib/timezone";

import { deriveStage, type StageResult } from "./stage";
import type { CalendarItem, CalendarPayload, ItemFacts } from "./types";

export function stageFromFacts(
  facts: ItemFacts,
  scheduledFor: Date | null,
  scheduleEnabled: boolean,
  now: Date,
): StageResult {
  return deriveStage({
    status: facts.status,
    hasContent: facts.hasContent,
    platform: facts.platform,
    channel: facts.channel,
    formatKey: facts.formatKey,
    scheduledFor,
    connected: facts.connected,
    scheduleEnabled,
    publishTask: facts.task
      ? {
          state: facts.task.state,
          error: facts.task.error,
          at: new Date(facts.task.at),
        }
      : null,
    now,
  });
}

export type RescheduleContext = {
  timezone: string;
  scheduleEnabled: boolean;
  now: Date;
};

// Parçayı yeni bir yerel gün+saate (ya da null: günü kaldır) taşınmış haliyle
// döndürür; durum, neden, gecikme ve taşınabilirlik yeniden türetilir.
export function rescheduleItem<T extends CalendarItem>(
  item: T,
  localDateTime: string | null,
  context: RescheduleContext,
): T {
  const scheduledFor = localDateTime
    ? zonedDateTimeToUtc(localDateTime, context.timezone)
    : null;
  const result = stageFromFacts(
    item.facts,
    scheduledFor,
    context.scheduleEnabled,
    context.now,
  );
  return {
    ...item,
    scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
    localDay: localDateTime ? localDateTime.slice(0, 10) : null,
    localTime: localDateTime ? localDateTime.slice(11, 16) : null,
    stage: result.stage,
    reason: result.reason,
    overdue: result.overdue,
    movable: result.movable,
  };
}

export type ItemCache = Map<string, { key: string; item: CalendarItem }>;

// Sunucudan her yeni yanıtta öğeler yeni nesnelerdir; içeriği değişmeyenleri
// ESKİ nesneyle değiştirir ki memo'lu kartlar yeniden render olmasın. Değişen
// ya da yeni öğeler olduğu gibi kalır; artık olmayanlar önbellekten düşer.
export function reuseUnchanged(
  next: readonly CalendarItem[],
  cache: ItemCache,
): CalendarItem[] {
  const seen = new Set<string>();
  const out = next.map((item) => {
    seen.add(item.id);
    const key = JSON.stringify(item);
    const hit = cache.get(item.id);
    if (hit && hit.key === key) return hit.item;
    cache.set(item.id, { key, item });
    return item;
  });
  for (const id of cache.keys()) {
    if (!seen.has(id)) cache.delete(id);
  }
  return out;
}

// Taze yanıtı yerel durumla birleştirir. `stamps`: bir parçaya en son kendi
// yazdığımız an (ms). Yanıt o andan ÖNCE okunmaya başlandıysa o parçanın yerel
// hali korunur, yoksa geç gelen eski bir yanıt kullanıcının değişikliğini
// kısa süre geri alırdı.
export function mergeFresh(
  local: readonly CalendarItem[],
  fresh: CalendarPayload,
  stamps: ReadonlyMap<string, number>,
): CalendarItem[] {
  const mine = new Map(local.map((item) => [item.id, item]));
  return fresh.items.map((item) => {
    const stamp = stamps.get(item.id);
    const own = mine.get(item.id);
    return stamp !== undefined && stamp > fresh.loadedAt && own ? own : item;
  });
}
