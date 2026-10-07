// Meta Ads bayrakları (docs/meta-ads-plan.md §9). Her faz kendi bayrağıyla
// açılır; değerler çağrı anında process.env'den okunur (tick adımları bayrağı
// her turda yeniden okur). Yalnız "true" açar (büyük / küçük harf ve baştaki
// ya da sondaki boşluk fark etmez: Railway'de "TRUE" yazmak bayrağı sessizce
// kapalı bırakmasın); optimizer üç değerlidir.

export function flagValue(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function on(name: string): boolean {
  return flagValue(process.env[name]) === "true";
}

export type OptimizerMode = "off" | "shadow" | "on";

export const AdsFlags = {
  // F2: ayna + sürekli denetim; okuyucular aynadan okur.
  sync: () => on("META_ADS_SYNC"),
  // F3: güvenli lansman v2 (tek onay, META_LAUNCH).
  launchV2: () => on("META_ADS_LAUNCH_V2"),
  // F4: optimizasyon kuralları ve karar kaydı.
  optimizer: (): OptimizerMode => {
    const value = flagValue(process.env.META_ADS_OPTIMIZER);
    return value === "on" || value === "shadow" ? value : "off";
  },
  // F5: planlama motoru ve yeni amaçlar.
  planner: () => on("META_ADS_PLANNER"),
  // F6: haftalık / aylık raporlar ve öğrenmeler.
  reports: () => on("META_ADS_REPORTS"),
  // F7: webhook'lar, Guarded/Full auto, isteğe bağlı Ad Rules sigortası.
  webhooks: () => on("META_ADS_WEBHOOKS"),
  autopilot: () => on("META_ADS_AUTOPILOT"),
  adRules: () => on("META_ADS_RULES"),
  // F8+: Library videosuyla video reklam (modül akışı).
  video: () => on("META_ADS_VIDEO"),
  // F8: ajans ölçeği (FLfB + BISU, çoklu hesap).
  agency: () => on("META_ADS_AGENCY"),
  // Acil durdurma: yalnız PAUSE geçer (docs/meta-ads-plan.md §3.9).
  writesDisabled: () => on("META_ADS_WRITES_DISABLED"),
};
