import {
  gaGlobalWorkAllowedHere,
  gaSyncAllowedFor,
} from "@/lib/website-analytics/flags";

// GA-F8 ajans ve ileri ölçek bayrakları (docs/website-agency.md). Değerler
// çağrı anında okunur, hiçbir şey önbelleğe alınmaz; yalnız "true" açar.
// GaFlags.sync() env enjeksiyonunu desteklemediği için GA_SYNC burada doğrudan
// sınanır. Canlı veritabanını paylaşan yerel süreç yalnız GA_SYNC_DEV_PROJECTS
// listesindeki projeler için çalışır (gaSyncAllowedFor).

export type GaAgencyEnv = {
  GA_AGENCY?: string;
  GA_SYNC?: string;
  GA_BIGQUERY?: string;
  GA_FUNNEL?: string;
  GA_FUNNEL_ALPHA?: string;
  GOOGLE_RISC?: string;
  GOOGLE_TOKEN_KEYS?: string;
  AGENTELSE_PROVIDER_MODE?: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

// Genel anahtar: kapalıyken GA-F8'in hiçbir giriş noktası sorgu atmaz.
export function gaAgencyEnabled(env: GaAgencyEnv = process.env): boolean {
  return env.GA_AGENCY === "true" && env.GA_SYNC === "true";
}

export function gaAgencyEnabledFor(
  projectId: string,
  env: GaAgencyEnv = process.env,
): boolean {
  return gaAgencyEnabled(env) && gaSyncAllowedFor(projectId, env);
}

// GA4 BigQuery dışa aktarma okuyucusu (GA_AGENCY + GA_SYNC ister).
export function gaBigQueryEnabled(env: GaAgencyEnv = process.env): boolean {
  return gaAgencyEnabled(env) && env.GA_BIGQUERY === "true";
}

export function gaBigQueryEnabledFor(
  projectId: string,
  env: GaAgencyEnv = process.env,
): boolean {
  return gaBigQueryEnabled(env) && gaSyncAllowedFor(projectId, env);
}

// Huni raporu (GA_AGENCY + GA_SYNC ister).
export function gaFunnelEnabled(env: GaAgencyEnv = process.env): boolean {
  return gaAgencyEnabled(env) && env.GA_FUNNEL === "true";
}

export function gaFunnelEnabledFor(
  projectId: string,
  env: GaAgencyEnv = process.env,
): boolean {
  return gaFunnelEnabled(env) && gaSyncAllowedFor(projectId, env);
}

// v1alpha için ayrı acil kapatma anahtarı: kapalıyken gerçek runFunnelReport
// çağrısı hiç yapılmaz (mock kip yine çalışır).
export function gaFunnelLiveAllowed(env: GaAgencyEnv = process.env): boolean {
  return env.GA_FUNNEL_ALPHA === "true";
}

// RISC alıcısı GA_AGENCY'den bağımsızdır (Search Console bağlantılarını da
// korur).
export function googleRiscEnabled(env: GaAgencyEnv = process.env): boolean {
  return env.GOOGLE_RISC === "true";
}

export function gaAgencyMockMode(env: GaAgencyEnv = process.env): boolean {
  return env.AGENTELSE_PROVIDER_MODE === "mock";
}

// Sorguların proje kapsamı: canlıda ve yerel tek kullanımlık veritabanında
// null (kapsam yok); canlı veritabanını paylaşan geliştirme sürecinde
// GA_SYNC_DEV_PROJECTS (boş olabilir: hiçbir proje).
export function gaAgencyDevProjectScope(
  env: GaAgencyEnv = process.env,
): string[] | null {
  if (gaGlobalWorkAllowedHere(env)) return null;
  return (env.GA_SYNC_DEV_PROJECTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
