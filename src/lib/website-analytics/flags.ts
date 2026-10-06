import { isLocalDatabaseUrl } from "@/lib/local-worker-policy";

// Google Analytics ambarı bayrakları (docs/google-analytics-plan.md GA-F2).
// Değerler çağrı anında process.env'den okunur (tick adımları bayrağı her
// turda yeniden okur); yalnız "true" açar.

function on(name: string): boolean {
  return process.env[name] === "true";
}

export const GaFlags = {
  // Senkron + okuyucuların ambara geçişi. Kapalıyken eski canlı yollar çalışır.
  sync: () => on("GA_SYNC"),
  // "Website" sayfası (/projects/[projectId]/site).
  websitePage: () => on("GA_WEBSITE_PAGE"),
};

type GaSyncEnvironment = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

// Bütün projeleri ilgilendiren işler (saklama temizliği): yerel geliştirme
// süreci canlı veritabanını paylaşırken hiç çalışmaz.
export function gaGlobalWorkAllowedHere(
  env: GaSyncEnvironment = process.env,
): boolean {
  return env.NODE_ENV !== "development" || isLocalDatabaseUrl(env.DATABASE_URL);
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken müşteri kotasını ve
// verisini tüketmesin diye yalnız GA_SYNC_DEV_PROJECTS'teki (virgülle ayrılmış
// proje kimlikleri) projeleri senkronlar. Canlıda ve yerel tek kullanımlık
// veritabanında her proje senkronlanır.
export function gaSyncAllowedFor(
  projectId: string,
  env: GaSyncEnvironment = process.env,
): boolean {
  if (env.NODE_ENV !== "development" || isLocalDatabaseUrl(env.DATABASE_URL)) {
    return true;
  }
  return (env.GA_SYNC_DEV_PROJECTS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(projectId);
}
