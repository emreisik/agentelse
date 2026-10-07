import { isLocalDatabaseUrl } from "@/lib/local-worker-policy";
import { GaFlags, gaSyncAllowedFor } from "@/lib/website-analytics/flags";

import type { GaFixKind } from "./types";

// GA-F7 (düzeltme eylemleri) bayrakları. Değerler çağrı anında process.env'den
// okunur; yalnız "true" açar. Kapalıyken hiçbir sorgu, öneri, yazma ya da
// izin isteği olmaz.

function on(name: string): boolean {
  return process.env[name] === "true";
}

type GaFixEnvironment = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

// v1alpha ailesi: ayrı kapatma anahtarına (GA_FIXES_ALPHA) bağlıdır.
export const GA_FIX_ALPHA_KINDS: readonly GaFixKind[] = [
  "ENHANCED_MEASUREMENT",
  "CHANNEL_GROUP_AI",
  "ANNOTATION_CREATE",
];

export const GaFixFlags = {
  // Ana anahtar; ayrıca GA_SYNC ister (gaFixesEnabled).
  fixes: () => on("GA_FIXES"),
  // v1alpha kinds için kapatma anahtarı.
  alpha: () => on("GA_FIXES_ALPHA"),
  // Başlatılan kampanyalar için otomatik not ÖNERİSİ.
  annotations: () => on("GA_FIXES_ANNOTATIONS"),
  // Haftalık "yeni gönderiler yayınlandı" notu önerisi.
  publishAnnotations: () => on("GA_FIXES_ANNOTATIONS_PUBLISH"),
};

export function gaFixesEnabled(): boolean {
  return GaFixFlags.fixes() && GaFlags.sync();
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken yalnız izin
// listesindeki projeler (GA_SYNC_DEV_PROJECTS) için açık.
export function gaFixesEnabledFor(
  projectId: string,
  env: GaFixEnvironment = process.env,
): boolean {
  return gaFixesEnabled() && gaSyncAllowedFor(projectId, env);
}

export function gaFixAlphaEnabled(): boolean {
  return gaFixesEnabled() && GaFixFlags.alpha();
}

export function gaFixKindEnabled(kind: GaFixKind): boolean {
  return GA_FIX_ALPHA_KINDS.includes(kind)
    ? gaFixAlphaEnabled()
    : gaFixesEnabled();
}

export function gaAutoAnnotationsEnabled(): boolean {
  return gaFixAlphaEnabled() && GaFixFlags.annotations();
}

export function gaPublishAnnotationsEnabled(): boolean {
  return gaAutoAnnotationsEnabled() && GaFixFlags.publishAnnotations();
}

// Aday sorguları LIMIT'in başına izin listesi dışı satır koymasın diye:
// null = her proje serbest (canlı / yerel tek kullanımlık veritabanı), aksi
// halde GA_SYNC_DEV_PROJECTS'teki kimlikler (ayarsızsa boş liste).
export function gaSyncProjectAllowList(
  env: GaFixEnvironment = process.env,
): string[] | null {
  if (env.NODE_ENV !== "development" || isLocalDatabaseUrl(env.DATABASE_URL)) {
    return null;
  }
  return (env.GA_SYNC_DEV_PROJECTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
