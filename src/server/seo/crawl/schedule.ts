import {
  CRAWL_MIN_RELEASE_MS,
  ROBOTS_CACHE_MS,
  SITEMAP_EVERY_MS,
} from "@/lib/seo/audit-constants";
import { hourInTimezone, safeTimezone } from "@/lib/website-analytics/days";

// Site tarayıcısının zamanlaması (docs/search-health.md "Tarayıcı"). Saf
// modül: her bırakış crawlNextAt'i açıkça ≥ now + 1 dk'ya kurar, böylece
// hiçbir site (robots hatası, gündüz bekleyen tam tarama) aday sorgusunu
// tıkayamaz. Boştaki siteler (kapsamsız, kapalı) crawlNextAt = null taşır ve
// aday bile olmaz.

// Tam tarama proje saatiyle gece penceresinde başlar: [01:00, 06:00).
export const NIGHT_START_HOUR = 1;
export const NIGHT_END_HOUR = 6;

const RUNNING_STEP_MS = 60_000;
const QUARTER_MS = 15 * 60_000;
// Bir sonraki yerel saat en çok iki gün içindedir (yaz saati geçişleri dahil).
const SEARCH_STEPS = (49 * 3_600_000) / QUARTER_MS;

export function inNightWindow(now: Date, timezone: string): boolean {
  const hour = hourInTimezone(now, safeTimezone(timezone));
  return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

// now'dan sonraki ilk yerel `hour`:00. Bütün IANA saat dilimlerinin farkı 15
// dakikanın katı olduğundan UTC çeyrek sınırlarını taramak yerel tam saati
// tam yakalar. Yaz saatinde o saat atlanırsa saate girilen ilk çeyrek döner.
export function nextLocalHour(now: Date, timezone: string, hour: number): Date {
  const zone = safeTimezone(timezone);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
  });
  const start = Math.floor(now.getTime() / QUARTER_MS) * QUARTER_MS;
  for (let step = 1; step <= SEARCH_STEPS; step += 1) {
    const at = start + step * QUARTER_MS;
    if (at <= now.getTime()) continue;
    // Saate girilen ilk çeyrek (normalde :00).
    const local = Number(format.format(at)) % 24;
    const before = Number(format.format(at - QUARTER_MS)) % 24;
    if (local === hour && before !== hour) return new Date(at);
  }
  return new Date(now.getTime() + 86_400_000);
}

export type NextCrawlInput = {
  now: Date;
  pausedUntil: Date | null;
  robotsRetryAt: Date | null;
  regressionDueAt: Date | null;
  robotsFetchedAt: Date | null;
  sitemapsCheckedAt: Date | null;
  fullCrawlDueAt: Date | null;
  fullRunning: boolean;
  crawlBlocked: boolean;
  hasFullCrawl: boolean;
  timezone: string;
};

// Bırakışta kurulacak bir sonraki koşu. Sıra: duraklatma (429/503) →
// robots geri çekilmesi → en erkeni (bekçi, robots önbelleği, sitemap,
// tam tarama terimi). null terim "şimdi" sayılır; sonuç en az now + 1 dk.
export function nextCrawlAt(input: NextCrawlInput): Date {
  const now = input.now.getTime();
  const floor = now + CRAWL_MIN_RELEASE_MS;
  const clamp = (value: number) => new Date(Math.max(value, floor));
  if (input.pausedUntil && input.pausedUntil.getTime() > now) {
    return clamp(input.pausedUntil.getTime());
  }
  if (input.robotsRetryAt && input.robotsRetryAt.getTime() > now) {
    return clamp(input.robotsRetryAt.getTime());
  }
  const at = (value: Date | null) => (value ? value.getTime() : now);
  const terms = [
    at(input.regressionDueAt),
    input.robotsFetchedAt
      ? input.robotsFetchedAt.getTime() + ROBOTS_CACHE_MS
      : now,
    input.sitemapsCheckedAt
      ? input.sitemapsCheckedAt.getTime() + SITEMAP_EVERY_MS
      : now,
  ];
  if (!input.crawlBlocked) {
    if (input.fullRunning) {
      terms.push(now + RUNNING_STEP_MS);
    } else {
      const due = at(input.fullCrawlDueAt);
      if (
        due <= now &&
        input.hasFullCrawl &&
        !inNightWindow(input.now, input.timezone)
      ) {
        terms.push(
          nextLocalHour(input.now, input.timezone, NIGHT_START_HOUR).getTime(),
        );
      } else {
        terms.push(due);
      }
    }
  }
  return clamp(Math.min(...terms));
}
