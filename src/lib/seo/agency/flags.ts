import { gscSyncAllowedFor, type GscSyncEnvironment } from "@/lib/seo/flags";

// SC-F9 ajans bayrakları (docs/search-agency.md). Değerler çağrı anında
// process.env'den okunur; yalnız "true" açar. GSC_AGENCY tek başına yetmez:
// ambar senkronu (GSC_SYNC) da açık olmalı. Geliştirme koruması yalnız
// src/lib/seo/flags.ts'ten gelir (burada yeniden yazılmaz).

export type GscAgencyEnvironment = GscSyncEnvironment & {
  GSC_SYNC?: string;
  GSC_AGENCY?: string;
  GSC_BIGQUERY?: string;
};

// Projede (birincil dahil) en çok bu kadar Search Console sitesi izlenir.
export const MAX_SITES_PER_PROJECT = 5;

export function gscAgencyOn(env: GscAgencyEnvironment = process.env): boolean {
  return env.GSC_AGENCY === "true" && env.GSC_SYNC === "true";
}

// BigQuery dışa aktarımı ajans bayrağına bağlıdır.
export function gscBigQueryOn(env: GscAgencyEnvironment = process.env): boolean {
  return gscAgencyOn(env) && env.GSC_BIGQUERY === "true";
}

export const GscAgencyFlags = {
  on: () => gscAgencyOn(),
  bigQuery: () => gscBigQueryOn(),
};

// Proje başına: geliştirme sürecinde yalnız izin listesindeki projeler.
export function gscAgencyActiveFor(
  projectId: string,
  env: GscAgencyEnvironment = process.env,
): boolean {
  return gscAgencyOn(env) && gscSyncAllowedFor(projectId, env);
}

export function gscBigQueryActiveFor(
  projectId: string,
  env: GscAgencyEnvironment = process.env,
): boolean {
  return gscBigQueryOn(env) && gscSyncAllowedFor(projectId, env);
}
