// GA-F6 bayrağı: GA_UTM. Çağrı anında okunur; yalnız tam "true" açar.
// Kapalıyken hiçbir link etiketlenmez ve yeni sorgu çalışmaz. Atıf okumaları
// ayrıca GA_SYNC ister (src/lib/website-analytics/attribution/flags.ts).

// Dizin imzası: process.env zayıf-tip denetiminden geçsin diye.
export type UtmEnv = { GA_UTM?: string; [key: string]: string | undefined };

export function utmFeatureOn(env: UtmEnv = process.env): boolean {
  return env.GA_UTM === "true";
}
