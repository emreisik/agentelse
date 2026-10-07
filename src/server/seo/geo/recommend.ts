import "server-only";

import {
  allowedNumbersOf,
  keepSupportedSentences,
} from "@/lib/module-flows/analytics/number-check";
import { prisma } from "@/lib/prisma";
import { GEO_CHECKS } from "@/lib/seo/geo/catalog";
import { geoRecommendContext } from "@/lib/seo/geo/recommend-context";
import {
  isGeoCheckId,
  type GeoAuditResult,
  type GeoCheckId,
} from "@/lib/seo/geo/types";
import { seoGeoRecommendDef } from "@/server/reasoning/prompts/seo-geo-recommend";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// Uyarı veren GEO kontrolleri için öneri metni (SC-F8, docs/ai-search-
// visibility.md "LLM kullanımı"): yalnız metni model yazar (amaç
// seo.geo-recommend, katman lite, projenin içerik dili). Bağlamda yalnız sabit
// kontrol kimlikleri ve başlıkları ile sayı/boolean olgular vardır; Google ya
// da GA verisi yoktur. Her cümle verideki sayılarla süzülür. Mock kipte,
// bütçe dolunca ya da herhangi bir hatada kataloğun sabit İngilizce "how"
// metni (kaynak "template") kullanılır. Hiçbir zaman fırlatmaz.

const TEXT_MAX = 400;

// Model metni tek satıra iner: kontrol karakterleri, işaretleme, bağlantılar
// ve fazla boşluk gider (llms.txt gibi dosya adları kalır). Boşsa null.
function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const flat = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[*_`#<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length < 2) return null;
  return flat.length > TEXT_MAX ? flat.slice(0, TEXT_MAX).trimEnd() : flat;
}

export type GeoRecommendations = {
  source: "ai" | "template";
  language: string | null;
  items: { checkId: string; text: string }[];
};

function templateItems(
  ids: readonly string[],
): { checkId: string; text: string }[] {
  return ids.flatMap((id) =>
    isGeoCheckId(id) ? [{ checkId: id, text: GEO_CHECKS[id].how }] : [],
  );
}

// Model kullanılamadığında (ya da brand yokken) sabit metinler.
export function templateRecommendations(
  result: GeoAuditResult,
): GeoRecommendations {
  const context = geoRecommendContext(result);
  return {
    source: "template",
    language: null,
    items: templateItems(context.checks.map((check) => check.id)),
  };
}

export async function writeGeoRecommendations(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  result: GeoAuditResult;
}): Promise<GeoRecommendations> {
  const context = geoRecommendContext(input.result);
  const ids = context.checks.map((check) => check.id);
  const fallback = templateRecommendations(input.result);
  if (ids.length === 0 || ReasoningService.isMockMode()) return fallback;

  try {
    const { output } = await ReasoningService.run(seoGeoRecommendDef, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      context,
    });
    const allowed = allowedNumbersOf(context);
    const written = new Map<GeoCheckId, string>();
    for (const item of output.items) {
      if (!isGeoCheckId(item.id) || !ids.includes(item.id)) continue;
      if (written.has(item.id)) continue;
      const cleaned = cleanText(item.recommendation);
      if (!cleaned) continue;
      const checked = keepSupportedSentences(cleaned, allowed);
      if (checked) written.set(item.id, checked);
    }
    if (written.size === 0) return fallback;
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { language: true },
    });
    return {
      source: "ai",
      language: project?.language ?? null,
      items: ids.flatMap((id) => {
        if (!isGeoCheckId(id)) return [];
        return [{ checkId: id, text: written.get(id) ?? GEO_CHECKS[id].how }];
      }),
    };
  } catch (error) {
    // Hata mesajı modelin yazdığı metni taşıyabilir: yalnız hata adı loglanır.
    console.error(
      "[seo-geo] recommendation failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return fallback;
  }
}
