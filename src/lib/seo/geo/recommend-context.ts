import { GEO_CHECKS } from "./catalog";
import type { GeoAuditResult, GeoCheckId } from "./types";

// Öneri metnini yazan modele giden bağlam (SC-F8): yalnız sabit kontrol
// kimlikleri ve başlıkları, durum ve sayı/boolean olgular. Sitenin kendi
// metni (başlık, sayfa yolu, kurum adı, adres) hiçbir zaman girmez.

export const GEO_RECOMMEND_MAX = 8;

export type GeoRecommendContext = {
  checks: {
    id: string;
    title: string;
    status: string;
    facts: Record<string, number | boolean>;
  }[];
};

// GEO3 yalnız bilgidir (karar kullanıcının): öneri yazılmaz.
const SKIPPED: ReadonlySet<GeoCheckId> = new Set(["GEO3"]);

export function geoRecommendContext(
  result: GeoAuditResult,
): GeoRecommendContext {
  const candidates = result.checks.filter(
    (check) =>
      (check.status === "WARN" || check.status === "INFO") &&
      !SKIPPED.has(check.id),
  );
  // Önce WARN, sonra ağırlık; eşitlikte katalog sırası korunur.
  const ranked = candidates
    .map((check, index) => ({ check, index }))
    .sort((a, b) => {
      const warn =
        Number(b.check.status === "WARN") - Number(a.check.status === "WARN");
      if (warn !== 0) return warn;
      const weight = GEO_CHECKS[b.check.id].weight - GEO_CHECKS[a.check.id].weight;
      return weight !== 0 ? weight : a.index - b.index;
    })
    .slice(0, GEO_RECOMMEND_MAX);
  return {
    checks: ranked.map(({ check }) => {
      const facts: Record<string, number | boolean> = {};
      for (const [key, value] of Object.entries(check.facts)) {
        if (typeof value === "number" || typeof value === "boolean") {
          facts[key] = value;
        }
      }
      return {
        id: check.id,
        title: GEO_CHECKS[check.id].title,
        status: check.status,
        facts,
      };
    }),
  };
}
