// SC-F8: SEO eklentisinin (Yoast, Rank Math) başlık ve meta açıklama alanları.
// Alan anahtarları eklentilerin bilinen post meta adlarıdır (doğrulanmalı: gerçek
// sitelerde). Anahtarlar REST'te yalnız eklenti ya da tema register_meta ile
// show_in_rest verdiyse görünür; bu yüzden örnek bir yazıda gerçekten açıkta
// olanlar yoklanır (probeSeoFields) ve yazma yolu buna göre seçilir.
// Saf modül.

import type { SeoFieldsCapability } from "../types";

export const SEO_META_KEYS = {
  yoast: { title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc" },
  rankMath: { title: "rank_math_title", description: "rank_math_description" },
} as const;

type Plugin = SeoFieldsCapability["plugin"];

// Rank Math'in bilinen REST ad alanı "rankmath/v1", Yoast'ınki "yoast/v1".
export function detectSeoPlugin(namespaces: readonly string[]): Plugin {
  if (namespaces.includes("rankmath/v1")) return "RANK_MATH";
  if (namespaces.includes("yoast/v1")) return "YOAST";
  return "NONE";
}

function keysOf(
  plugin: Plugin,
): { title: string; description: string } | null {
  if (plugin === "YOAST") return SEO_META_KEYS.yoast;
  if (plugin === "RANK_MATH") return SEO_META_KEYS.rankMath;
  return null;
}

export function probeSeoFields(
  plugin: Plugin,
  input: { metaKeys: readonly string[]; namespaces: readonly string[] },
): SeoFieldsCapability {
  const keys = keysOf(plugin);
  if (!keys) {
    return {
      plugin: "NONE",
      titleVia: "POST_TITLE",
      descriptionVia: "NONE",
      verifiable: true,
    };
  }
  const titleExposed = input.metaKeys.includes(keys.title);
  const descriptionExposed = input.metaKeys.includes(keys.description);
  // Rank Math anahtarları gizliyse kendi uç noktası (updateMeta) kullanılır.
  const endpoint =
    plugin === "RANK_MATH" && input.namespaces.includes("rankmath/v1");

  const titleVia: SeoFieldsCapability["titleVia"] = titleExposed
    ? "META"
    : endpoint
      ? "RANKMATH_ENDPOINT"
      : "POST_TITLE";
  const descriptionVia: SeoFieldsCapability["descriptionVia"] =
    descriptionExposed ? "META" : endpoint ? "RANKMATH_ENDPOINT" : "NONE";

  return {
    plugin,
    titleVia,
    descriptionVia,
    // Uç nokta üzerinden yazılan alan geri okunamaz.
    verifiable:
      titleVia !== "RANKMATH_ENDPOINT" && descriptionVia !== "RANKMATH_ENDPOINT",
  };
}

// Yazıdan okunabilen SEO alanları; META dışındaki yolda null.
export function seoValuesOf(
  fields: SeoFieldsCapability,
  meta: Record<string, unknown>,
): { seoTitle: string | null; seoDescription: string | null } {
  const keys = keysOf(fields.plugin);
  if (!keys) return { seoTitle: null, seoDescription: null };
  const read = (key: string): string | null => {
    const value = meta[key];
    return typeof value === "string" ? value : null;
  };
  return {
    seoTitle: fields.titleVia === "META" ? read(keys.title) : null,
    seoDescription:
      fields.descriptionVia === "META" ? read(keys.description) : null,
  };
}

// Başlık/açıklama değerlerinin hangi yoldan yazılacağı. "" geçerli bir değerdir
// ("varsayılan şablona dön"). Açıklama için yazılabilir alan yoksa unsupported.
export function seoWritePlan(
  fields: SeoFieldsCapability,
  input: { title: string | null; description: string | null },
): {
  coreTitle: string | null;
  meta: Record<string, string>;
  endpointMeta: Record<string, string> | null;
  unsupported: "description" | null;
} {
  const keys = keysOf(fields.plugin);
  const meta: Record<string, string> = {};
  const endpoint: Record<string, string> = {};
  let coreTitle: string | null = null;
  let unsupported: "description" | null = null;

  if (input.title !== null) {
    if (keys && fields.titleVia === "META") meta[keys.title] = input.title;
    else if (keys && fields.titleVia === "RANKMATH_ENDPOINT") {
      endpoint[keys.title] = input.title;
    } else coreTitle = input.title;
  }

  if (input.description !== null) {
    if (keys && fields.descriptionVia === "META") {
      meta[keys.description] = input.description;
    } else if (keys && fields.descriptionVia === "RANKMATH_ENDPOINT") {
      endpoint[keys.description] = input.description;
    } else unsupported = "description";
  }

  return {
    coreTitle,
    meta,
    endpointMeta: Object.keys(endpoint).length ? endpoint : null,
    unsupported,
  };
}
