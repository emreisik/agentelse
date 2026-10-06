import { isLocalDatabaseUrl } from "@/lib/local-worker-policy";

// Search Console ambarı bayrakları (docs/google-search-console-plan.md SC-F2,
// docs/search-analytics.md). Değerler çağrı anında process.env'den okunur
// (tick adımları bayrağı her turda yeniden okur); yalnız "true" açar.

function on(name: string): boolean {
  return process.env[name] === "true";
}

export const GscFlags = {
  // Senkron + okuyucuların ambara geçişi. Kapalıyken eski canlı yollar çalışır.
  sync: () => on("GSC_SYNC"),
  // "Search" sayfası (/projects/[projectId]/arama).
  searchPage: () => on("GSC_SEARCH_PAGE"),
};

export type GscSyncEnvironment = {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GSC_SYNC_DEV_PROJECTS?: string;
  GSC_ROLLOUT_PROJECTS?: string;
};

// Virgülle ayrılmış proje kimlikleri; boşluklar kırpılır, boş öğeler atılır.
function projectList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Bütün projeleri ilgilendiren işler (saklama temizliği, heartbeat,
// claimPeriodic): yerel geliştirme süreci canlı veritabanını paylaşırken hiç
// çalışmaz.
export function gscGlobalWorkAllowedHere(
  env: GscSyncEnvironment = process.env,
): boolean {
  return env.NODE_ENV !== "development" || isLocalDatabaseUrl(env.DATABASE_URL);
}

// Yerel geliştirme süreci canlı veritabanını paylaşırken müşteri kotasını ve
// verisini tüketmesin diye yalnız GSC_SYNC_DEV_PROJECTS'teki projeleri
// senkronlar. GSC_ROLLOUT_PROJECTS (plan §9 kademeli açılış) doluysa her
// ortamda yalnız o projeler bağ, senkron, yenileme ve yazma eylemi alır.
export function gscSyncAllowedFor(
  projectId: string,
  env: GscSyncEnvironment = process.env,
): boolean {
  const here =
    gscGlobalWorkAllowedHere(env) ||
    projectList(env.GSC_SYNC_DEV_PROJECTS).includes(projectId);
  if (!here) return false;
  const rollout = projectList(env.GSC_ROLLOUT_PROJECTS);
  return rollout.length === 0 || rollout.includes(projectId);
}

// Geçerli izin listesi: geliştirme sürecinde dev listesi (açılış listesi
// varsa onunla kesişimi), aksi hâlde açılış listesi; null = bütün projeler.
export function gscRestrictedProjects(
  env: GscSyncEnvironment = process.env,
): string[] | null {
  const rollout = projectList(env.GSC_ROLLOUT_PROJECTS);
  if (!gscGlobalWorkAllowedHere(env)) {
    const dev = projectList(env.GSC_SYNC_DEV_PROJECTS);
    return rollout.length > 0 ? dev.filter((id) => rollout.includes(id)) : dev;
  }
  return rollout.length > 0 ? rollout : null;
}
