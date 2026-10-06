// Meta Ads bayrakları (docs/meta-ads-plan.md §9). Her faz kendi bayrağıyla
// açılır; değerler çağrı anında process.env'den okunur (tick adımları bayrağı
// her turda yeniden okur). Yalnız "true" açar; optimizer üç değerlidir.

function on(name: string): boolean {
  return process.env[name] === "true";
}

export type OptimizerMode = "off" | "shadow" | "on";

export const AdsFlags = {
  // F2: ayna + sürekli denetim; okuyucular aynadan okur.
  sync: () => on("META_ADS_SYNC"),
  // F3: güvenli lansman v2 (tek onay, META_LAUNCH).
  launchV2: () => on("META_ADS_LAUNCH_V2"),
  // F4: optimizasyon kuralları ve karar kaydı.
  optimizer: (): OptimizerMode => {
    const value = process.env.META_ADS_OPTIMIZER;
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
  // F8: ajans ölçeği (FLfB + BISU, çoklu hesap).
  agency: () => on("META_ADS_AGENCY"),
  // Acil durdurma: yalnız PAUSE geçer (docs/meta-ads-plan.md §3.9).
  writesDisabled: () => on("META_ADS_WRITES_DISABLED"),
};
