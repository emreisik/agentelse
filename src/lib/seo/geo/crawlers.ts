import {
  aiCrawlerAccess,
  isAllowedInGroup,
  starGroup,
  type ParsedRobots,
} from "@/lib/seo/robots-parser";

import type { GeoCrawlerRow } from "./types";

// AI tarayıcılarının robots.txt erişimi (SC-F8 GEO2, GEO3). Belirteç listesi
// ve eşleştirme robots-parser.ts'ten gelir; burada yeniden tanımlanmaz.

export function crawlerRows(robots: ParsedRobots | null): GeoCrawlerRow[] {
  return aiCrawlerAccess(robots).map((row) => ({
    token: row.token,
    owner: row.owner,
    purpose: row.purpose,
    allowed: row.allowed,
  }));
}

// Yanıt ve arama için kullanılan tarayıcılardan engellenenlerin belirteçleri.
export function searchBlocked(rows: readonly GeoCrawlerRow[]): string[] {
  return rows
    .filter((row) => row.purpose === "search" && !row.allowed)
    .map((row) => row.token);
}

export function trainingBlocked(rows: readonly GeoCrawlerRow[]): string[] {
  return rows
    .filter((row) => row.purpose === "training" && !row.allowed)
    .map((row) => row.token);
}

// "User-agent: *" grubu ana sayfayı kapatıyor mu (her şeyi engelleyen joker).
export function allBlockedByWildcard(robots: ParsedRobots | null): boolean {
  if (!robots) return false;
  const group = starGroup(robots);
  if (!group) return false;
  return !isAllowedInGroup(group, "/").allowed;
}
