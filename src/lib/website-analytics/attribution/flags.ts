import { gaSyncAllowedFor } from "@/lib/website-analytics/flags";

// GA-F6 atıf bayrakları (docs/website-attribution.md "Amaç ve bayraklar").
// Değerler çağrı anında okunur; yalnız "true" açar. Atıf görünümleri, MH25,
// sonuç API'si ve öğrenmeler GA_UTM + GA_SYNC ister; dış linklere etiket
// eklemek yalnız GA_UTM ister (lib/tracked-links/flags.ts).

export type GaAttributionEnv = {
  GA_UTM?: string;
  GA_SYNC?: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

export function gaAttributionEnabled(
  env: GaAttributionEnv = process.env,
): boolean {
  return env.GA_UTM === "true" && env.GA_SYNC === "true";
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken yalnız
// GA_SYNC_DEV_PROJECTS'teki projeler (gaSyncAllowedFor).
export function gaAttributionEnabledFor(
  projectId: string,
  env: GaAttributionEnv = process.env,
): boolean {
  return gaAttributionEnabled(env) && gaSyncAllowedFor(projectId, env);
}
