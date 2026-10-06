import {
  gaGlobalWorkAllowedHere,
  gaSyncAllowedFor,
} from "@/lib/website-analytics/flags";

// GA-F4 analiz motoru bayrakları (docs/google-analytics-plan.md §3.6, §9
// GA-F4; ayrıntı docs/website-insights.md). Değerler çağrı anında okunur,
// hiçbir şey önbelleğe alınmaz.
// - GA_INSIGHTS=off|shadow|on (boş ya da bilinmeyen = off); GA_SYNC=true
//   olmadan etkin mod daima off.
// - GA_INSIGHTS_PROJECTS: GA_INSIGHTS=shadow iken "on" davranan projeler
//   (kademeli açılış listesi).
// - GA_SYNC_DEV_PROJECTS: canlı veritabanını paylaşan yerel süreç yalnız bu
//   projeleri analiz eder.

export type GaInsightsMode = "off" | "shadow" | "on";

export type GaInsightsEnv = {
  GA_INSIGHTS?: string;
  GA_INSIGHTS_PROJECTS?: string;
  GA_SYNC?: string;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  GA_SYNC_DEV_PROJECTS?: string;
};

function idList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

// Genel mod: ambar senkronu kapalıyken analiz edilecek veri yok.
export function gaInsightsMode(
  env: GaInsightsEnv = process.env,
): GaInsightsMode {
  if (env.GA_SYNC !== "true") return "off";
  const value = (env.GA_INSIGHTS ?? "").trim().toLowerCase();
  return value === "shadow" || value === "on" ? value : "off";
}

export function gaInsightsProjects(env: GaInsightsEnv = process.env): string[] {
  return idList(env.GA_INSIGHTS_PROJECTS);
}

// Projenin etkin modu: genel mod kapalıysa kapalı; geliştirme sürecinde
// listede olmayan proje kapalı; gölge modda listedeki proje "on".
export function gaInsightsModeFor(
  projectId: string,
  env: GaInsightsEnv = process.env,
): GaInsightsMode {
  const base = gaInsightsMode(env);
  if (base === "off") return "off";
  if (!gaSyncAllowedFor(projectId, env)) return "off";
  if (base === "shadow" && gaInsightsProjects(env).includes(projectId)) {
    return "on";
  }
  return base;
}

// Sohbet araçları listelensin mi: genel "on" ya da gölge modda en az bir
// proje "on" (çalıştırma anında proje modu yeniden sınanır).
export function gaInsightsListed(env: GaInsightsEnv = process.env): boolean {
  const base = gaInsightsMode(env);
  return (
    base === "on" || (base === "shadow" && gaInsightsProjects(env).length > 0)
  );
}

// Eski google-analytics-scanner'ın GA kısmı genel olarak devre dışı mı (proje
// başına atlama scanner-gate.ts'te).
export function gaInsightsReplacesScanner(
  env: GaInsightsEnv = process.env,
): boolean {
  return gaInsightsMode(env) === "on";
}

// Sorguların where koşuluna eklenecek proje kapsamı: canlıda ve yerel tek
// kullanımlık veritabanında null (kapsam yok); canlı veritabanını paylaşan
// geliştirme sürecinde GA_SYNC_DEV_PROJECTS (boş olabilir: hiçbir proje).
export function gaInsightsDevProjectScope(
  env: GaInsightsEnv = process.env,
): string[] | null {
  if (gaGlobalWorkAllowedHere(env)) return null;
  return idList(env.GA_SYNC_DEV_PROJECTS);
}
