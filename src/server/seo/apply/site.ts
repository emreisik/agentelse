import "server-only";

import type { CmsSite } from "@prisma/client";

import {
  applyMockMode,
  mockMatchesSite,
  seoApplyEnabledFor,
} from "@/lib/seo/apply/flags";
import type {
  SeoApplyRefusal,
  SeoChangeErrorCode,
  SeoChangeKind,
  SeoFieldsCapability,
  WpCapabilities,
  WpType,
} from "@/lib/seo/apply/types";
import { capabilityAllows } from "@/lib/seo/apply/wp/capabilities";
import { inScope, type CrawlScope } from "@/lib/seo/crawl-url";
import { loadCmsSite } from "@/server/integrations/wordpress/connection";
import { SeoSites } from "@/server/seo/site/sites";

// Tek kapı: öneri, uygulama ve geri alma aynı kontrolden geçer (docs/website-apply.md).
// Sıra: bayrak + geliştirme koruması, site satırı, mock uyuşması, sağlık, kapsam
// (SeoSite) yeniden doğrulaması, yetenek. Hiçbir adım WordPress'e gitmez.

export type ApplySiteGate =
  | {
      ok: true;
      site: CmsSite;
      scope: CrawlScope;
      fields: SeoFieldsCapability;
      capabilities: WpCapabilities;
    }
  | { ok: false; code: SeoChangeErrorCode; refusal: SeoApplyRefusal };

function fail(
  code: SeoChangeErrorCode,
  refusal: SeoApplyRefusal,
): { ok: false; code: SeoChangeErrorCode; refusal: SeoApplyRefusal } {
  return { ok: false, code, refusal };
}

const TITLE_VIA = ["META", "RANKMATH_ENDPOINT", "POST_TITLE"] as const;
const DESCRIPTION_VIA = ["META", "RANKMATH_ENDPOINT", "NONE"] as const;
const PLUGINS = ["YOAST", "RANK_MATH", "NONE"] as const;

function pick<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return allowed.find((item) => item === value) ?? null;
}

// Saklı JSON'a güvenilmez: eksik ya da bozuksa null döner (kapı kapanır).
export function parseSeoFields(value: unknown): SeoFieldsCapability | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const plugin = pick(record.plugin, PLUGINS);
  const titleVia = pick(record.titleVia, TITLE_VIA);
  const descriptionVia = pick(record.descriptionVia, DESCRIPTION_VIA);
  if (!plugin || !titleVia || !descriptionVia) return null;
  return {
    plugin,
    titleVia,
    descriptionVia,
    verifiable: record.verifiable === true,
  };
}

export function parseWpCapabilities(value: unknown): WpCapabilities | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    draftPosts: record.draftPosts === true,
    publishPosts: record.publishPosts === true,
    editPublishedPosts: record.editPublishedPosts === true,
    editPages: record.editPages === true,
    editPublishedPages: record.editPublishedPages === true,
    editOthers: record.editOthers === true,
    deletePosts: record.deletePosts === true,
  };
}

export async function gateApplySite(
  projectId: string,
  kind: SeoChangeKind,
  options: {
    mock?: boolean;
    wpType?: WpType | null;
    // Tür henüz bilinmiyorsa (öneri): yazı VEYA sayfa düzenleme yetkisi yeter;
    // kesin tür denetimi prepare* adımında ve uygulamada yapılır.
    anyWpType?: boolean;
  } = {},
): Promise<ApplySiteGate> {
  if (!seoApplyEnabledFor(projectId)) return fail("not_enabled", "not_enabled");

  const mock = options.mock ?? applyMockMode();
  const site = await loadCmsSite(projectId, { mock });
  if (!site) return fail("not_connected", "not_connected");
  // Mock süreç gerçek siteye, gerçek süreç mock siteye asla yazmaz.
  if (!mockMatchesSite(mock, site.isMock)) {
    return fail("not_enabled", "not_allowed_here");
  }

  if (site.health !== "OK" && site.health !== "LIMITED") {
    switch (site.health) {
      case "AUTH":
        return fail("reconnect", "site_unhealthy");
      case "NO_PERMISSION":
        return fail("no_permission", "no_permission");
      case "DOMAIN_MISMATCH":
        return site.healthReason === "scope_changed"
          ? fail("scope_changed", "domain_mismatch")
          : fail("domain_mismatch", "domain_mismatch");
      default:
        return fail("site_unhealthy", "site_unhealthy");
    }
  }

  // Kapsam her yazımdan önce yeniden okunur: doğrulanan site değişmiş olabilir.
  const state = await SeoSites.readState(projectId);
  const scope = state?.scope ?? null;
  if (!scope) return fail("scope_changed", "domain_mismatch");
  if (!inScope(site.origin, scope)) {
    return fail("domain_mismatch", "domain_mismatch");
  }
  if (!site.scopeKey || scope.key !== site.scopeKey) {
    return fail("scope_changed", "domain_mismatch");
  }

  const fields = parseSeoFields(site.seoFields);
  const capabilities = parseWpCapabilities(site.capabilities);
  if (!fields || !capabilities) return fail("site_unhealthy", "site_unhealthy");
  const allowed = options.anyWpType
    ? capabilityAllows(capabilities, kind, "post") ||
      capabilityAllows(capabilities, kind, "page")
    : capabilityAllows(capabilities, kind, options.wpType ?? null);
  if (!allowed) {
    return fail("no_permission", "no_permission");
  }

  return { ok: true, site, scope, fields, capabilities };
}
