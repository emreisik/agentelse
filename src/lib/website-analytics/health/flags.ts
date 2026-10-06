import { GaFlags } from "@/lib/website-analytics/flags";

// GA-F3 ölçüm sağlığı bayrağı (docs/measurement-health.md). Çağrı anında
// okunur; yalnız "true" açar ve ambar senkronu (GA_SYNC) olmadan hiçbir şey
// çalışmaz.
export function gaHealthEnabled(): boolean {
  return process.env.GA_HEALTH === "true" && GaFlags.sync();
}
