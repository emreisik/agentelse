import {
  gaGlobalWorkAllowedHere,
  gaSyncAllowedFor,
} from "@/lib/website-analytics/flags";

// GA-F5 raporlama ve planlama bayrağı (docs/website-reports.md). Değer çağrı
// anında okunur, hiçbir şey önbelleğe alınmaz. GaFlags.sync() env enjeksiyonunu
// desteklemediği için GA_SYNC burada doğrudan sınanır.
// - GA_REPORTS=true ve GA_SYNC=true birlikte gerekir; yalnız "true" açar.
// - GA_SYNC_DEV_PROJECTS: canlı veritabanını paylaşan yerel süreç yalnız bu
//   projeler için rapor üretir.

export type GaReportsEnv = {
  GA_REPORTS?: string;
  GA_SYNC?: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

// Genel anahtar: kapalıyken GA-F5'in hiçbir giriş noktası sorgu atmaz.
export function gaReportsEnabled(env: GaReportsEnv = process.env): boolean {
  return env.GA_REPORTS === "true" && env.GA_SYNC === "true";
}

// Projeye özel kapı: ayar kartı, eylemler ve yenileme bunu kullanır.
export function gaReportsEnabledFor(
  projectId: string,
  env: GaReportsEnv = process.env,
): boolean {
  return gaReportsEnabled(env) && gaSyncAllowedFor(projectId, env);
}

// Sorguların where koşuluna eklenecek proje kapsamı: canlıda ve yerel tek
// kullanımlık veritabanında null (kapsam yok); canlı veritabanını paylaşan
// geliştirme sürecinde GA_SYNC_DEV_PROJECTS (boş olabilir: hiçbir proje).
export function gaReportsDevProjectScope(
  env: GaReportsEnv = process.env,
): string[] | null {
  if (gaGlobalWorkAllowedHere(env)) return null;
  return (env.GA_SYNC_DEV_PROJECTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
