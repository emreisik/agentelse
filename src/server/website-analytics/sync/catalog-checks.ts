import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  applyGaCatalogCheck,
  evaluateGaMetadata,
  gaCatalogRequiredFields,
  type GaRequiredFields,
} from "@/lib/website-analytics/catalog-fields";
import {
  gaDisabledReports,
  parseGaCatalogState,
  serializeGaCatalogState,
  type GaCatalogState,
  type GaOptionalReportKey,
  type GaOptionalState,
} from "@/lib/website-analytics/catalog-state";
import {
  checkGaCompatibility,
  fetchGaMetadata,
} from "@/server/integrations/google-analytics/metadata-api";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";

import type { GaSyncContext } from "./context";

// Haftalık katalog denetimi (docs/google-analytics-plan.md §3.3
// "getMetadata / checkCompatibility"; GA_CATALOG_CHECKS). Mülkün alan listesi
// okunur: eksik alanı olan rapor düşer, alan geri gelince açılır. İsteğe bağlı
// raporlar (google_ads, search_console) yalnız alanları listede ve birlikte
// istenebiliyorsa açılır. Sonuç GaPropertyLink.catalog'a v2 olarak yazılır.
// Kota kapısı yok: getMetadata/checkCompatibility runReport token'ı harcamaz.
// Kullanıcının düzeltmesi gereken hatalar yükselir (runner'ın sağlık durumu
// uygulanır); diğerleri (429 dahil) check.error olarak kaydedilir ve denetim
// 24 saat sonra yeniden dener.

const RETHROWN = new Set<GoogleErrorClass>([
  "AUTH",
  "SCOPE_MISSING",
  "PERMISSION",
  "NOT_FOUND",
  "API_DISABLED",
]);

async function optionalReportState(
  ctx: GaSyncContext,
  key: GaOptionalReportKey,
  input: {
    at: string;
    missing: Record<string, string[]>;
    required: GaRequiredFields;
  },
): Promise<GaOptionalState> {
  const { at, missing, required } = input;
  if (key === "google_ads") {
    const ads =
      (ctx.link.linkedProducts as { googleAds?: number } | null)?.googleAds ??
      0;
    if (ads <= 0) return { enabled: false, at, reason: "NO_ADS_LINK" };
  }
  const absent = missing[key];
  if (absent?.length) {
    return {
      enabled: false,
      at,
      reason: `FIELD_MISSING: ${absent.join(", ")}`,
    };
  }
  const fields = required[key];
  if (!fields) return { enabled: false, at, reason: "FIELD_MISSING" };
  const compatibility = await checkGaCompatibility(
    ctx.accessToken,
    ctx.link.propertyId,
    fields,
  );
  return compatibility.compatible
    ? { enabled: true, at, reason: null }
    : {
        enabled: false,
        at,
        reason: `INCOMPATIBLE: ${compatibility.incompatible.join(", ")}`,
      };
}

async function runCheck(
  ctx: GaSyncContext,
  previous: GaCatalogState,
  at: string,
): Promise<GaCatalogState> {
  const required = gaCatalogRequiredFields();
  const metadata = await fetchGaMetadata(ctx.accessToken, ctx.link.propertyId);
  const result = evaluateGaMetadata(metadata, required);
  const state = applyGaCatalogCheck(previous, {
    at,
    now: ctx.now,
    result,
    required,
  });
  const optional = { ...state.optional };
  for (const key of ["google_ads", "search_console"] as const) {
    optional[key] = await optionalReportState(ctx, key, {
      at,
      missing: result.missing,
      required,
    });
  }
  if (result.deprecated.length > 0) {
    // Yalnız alan adları; mülk kimliği loglanmaz.
    console.warn(
      `[ga-sync] deprecated GA fields in use: ${result.deprecated.join(", ")}`,
    );
  }
  return { ...state, optional };
}

export async function syncCatalogChecks(ctx: GaSyncContext): Promise<void> {
  const at = ctx.now.toISOString();
  const previous = parseGaCatalogState(ctx.link.catalog);
  let state: GaCatalogState;
  try {
    state = await runCheck(ctx, previous, at);
  } catch (error) {
    if (error instanceof GoogleApiError && RETHROWN.has(error.errorClass)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Düşmüş raporlar ve isteğe bağlı durum olduğu gibi kalır.
    state = {
      ...previous,
      check: {
        at,
        missing: {},
        deprecated: [],
        blocked: [],
        error: message.slice(0, 200),
      },
    };
  }

  const catalog = serializeGaCatalogState(state);
  ctx.link = await prisma.gaPropertyLink.update({
    where: { id: ctx.link.id },
    data: { catalog: catalog as Prisma.InputJsonValue },
  });
  ctx.disabled.clear();
  for (const key of gaDisabledReports(catalog)) ctx.disabled.add(key);
}
