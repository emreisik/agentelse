// Bir parçanın "nereye gidiyor" kimliği (IO yok): kanal planından ya da
// (plansız eski parçalarda) yalnız platformdan türetilir. Süzgeç anahtarı,
// marka simgesi ve etiket tek yerden çıkar; takvimin hiçbir yeri kendi
// platform tablosunu tutmaz.

import { CHANNELS, isChannelKey } from "@/lib/content-channels";
import type { CalendarSource } from "./types";

type BrandedKey = NonNullable<CalendarSource["brand"]>;

const BRANDED: ReadonlySet<string> = new Set<BrandedKey>([
  "instagram",
  "facebook",
  "tiktok",
  "linkedin",
  "x",
]);

// Katalogda olmayan platformlar (kanal planı yok) için sabit görünüm.
const PLATFORM_FALLBACK: Record<
  string,
  { label: string; short: string; color: string }
> = {
  facebook: { label: "Facebook", short: "f", color: "#0866ff" },
  youtube: { label: "YouTube", short: "YT", color: "#dc2626" },
  pinterest: { label: "Pinterest", short: "Pin", color: "#e60023" },
};

const OTHER: CalendarSource = {
  key: "other",
  label: "Other",
  brand: null,
  short: "•",
  color: "#6b7280",
};

export function sourceOf(
  channel: string | null,
  platform: string | null,
): CalendarSource {
  if (isChannelKey(channel)) {
    const def = CHANNELS[channel];
    return {
      key: def.key,
      label: def.label,
      brand: BRANDED.has(def.key) ? (def.key as BrandedKey) : null,
      short: def.short,
      color: def.color,
    };
  }
  const key = platform?.toLowerCase();
  if (!key) return OTHER;
  const known = isChannelKey(key) ? CHANNELS[key] : null;
  if (known) {
    return {
      key,
      label: known.label,
      brand: BRANDED.has(key) ? (key as BrandedKey) : null,
      short: known.short,
      color: known.color,
    };
  }
  const fallback = PLATFORM_FALLBACK[key];
  if (!fallback) return { ...OTHER, key };
  return {
    key,
    label: fallback.label,
    brand: BRANDED.has(key) ? (key as BrandedKey) : null,
    short: fallback.short,
    color: fallback.color,
  };
}
