"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { crawlUrlHash, normalizeCrawlUrl } from "@/lib/seo/crawl-url";
import { SeoFlags, seoWorkAllowedFor } from "@/lib/seo/health-flags";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { muteSearchAlert } from "@/server/seo/health/alerts";
import { SeoInspection } from "@/server/seo/health/inspection";
import { SeoSites } from "@/server/seo/site/sites";
import { checkSiteVerification } from "@/server/seo/site/verify";

// Search sayfasındaki "Index & technical health" bölümünün eylemleri (SC-F3,
// docs/search-health.md): Inspect, doğrulama kontrolü, tarama ayarı, "Check
// again now", 7 gün susturma ve "Delete audit data". Hepsi oturumu ve proje
// erişimini doğrular, SEO_HEALTH kapalıyken ya da açılış listesi dışındaki
// projede hiçbir iş yapmaz, kaydı denetim günlüğüne yazar ve hiç fırlatmaz.

export type ActionResult = { ok: true } | { ok: false; message: string };

const NOT_AVAILABLE = "Search health is not available.";
const NOT_ENABLED = "Search health is not enabled for this project yet.";
const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const INVALID = "Something is missing. Reload the page and try again.";

const INSPECTION_MESSAGES = {
  out_of_scope: "This page is outside your Search Console property.",
  no_link: "Connect Search Console to check pages with Google.",
  full: "Up to 20 pages can wait for inspection.",
  already_queued: "This page is already waiting for inspection.",
} as const;

const VERIFICATION_MESSAGES = {
  not_found:
    "We couldn't find the tag or DNS record yet. DNS changes can take a while.",
  no_domain: "Add your website address to this project first.",
  unreachable: "We couldn't reach your website. Try again in a few minutes.",
  unavailable: NOT_ENABLED,
} as const;

const RECRAWL_MESSAGES = {
  too_soon: "The audit ran less than a day ago. Try again tomorrow.",
  unavailable: "The site audit can't run for this project right now.",
} as const;

const MUTE_DAYS = 7;

const ProjectSchema = z.object({ projectId: z.string().trim().min(1).max(64) });
const InspectSchema = ProjectSchema.extend({
  url: z.string().trim().min(1).max(2048),
});
const CrawlSchema = ProjectSchema.extend({
  crawlEnabled: z.boolean(),
  // CRAWL_PAGE_LIMITS (audit-constants) ile aynı üç değer
  pageLimit: z.coerce
    .number()
    .pipe(z.union([z.literal(100), z.literal(250), z.literal(500)])),
});
const MuteSchema = ProjectSchema.extend({
  alertId: z.string().trim().min(1).max(64),
});

type Access = { userId: string; workspaceId: string; projectId: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Ortak giriş: oturum → proje erişimi → doğrulama → SEO_HEALTH → izin listesi.
async function gate<T extends { projectId: string }>(
  formData: FormData,
  schema: z.ZodType<T>,
  input: Record<string, unknown>,
): Promise<
  { ok: true; access: Access; data: T } | { ok: false; message: string }
> {
  const projectId = field(formData, "projectId");
  const { userId } = await requireUser();
  const { workspaceId } = await requireProjectAccess(userId, projectId);
  const parsed = schema.safeParse({ projectId, ...input });
  if (!parsed.success) return { ok: false, message: INVALID };
  if (!SeoFlags.health()) return { ok: false, message: NOT_AVAILABLE };
  if (!seoWorkAllowedFor(projectId)) return { ok: false, message: NOT_ENABLED };
  return {
    ok: true,
    access: { userId, workspaceId, projectId },
    data: parsed.data,
  };
}

function failure(error: unknown, fallback: string): ActionResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : fallback,
  };
}

function revalidateSearch(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
}

function record(
  access: Access,
  action: string,
  metadata?: Record<string, unknown>,
) {
  return AuditLogRepository.record({
    workspaceId: access.workspaceId,
    projectId: access.projectId,
    actorType: "USER",
    actorId: access.userId,
    action,
    entityType: "SeoSite",
    entityId: access.projectId,
    ...(metadata ? { metadata } : {}),
  });
}

// Inspect: sayfa P1 kuyruğuna girer; bir sonraki inceleme turunda Google'a
// sorulur (günlük bütçe ve dakikada 10 sınırı korunur).
export async function requestInspectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, InspectSchema, {
      url: field(formData, "url"),
    });
    if (!entry.ok) return entry;
    const { access, data } = entry;
    const result = await SeoInspection.requestInspection({
      projectId: access.projectId,
      url: data.url,
      by: "user",
    });
    if (result !== "queued") {
      return { ok: false, message: INSPECTION_MESSAGES[result] };
    }
    // Denetim kaydında adresin kendisi değil, özeti durur.
    const normalized = normalizeCrawlUrl(data.url);
    await record(access, "seo_site.inspection_requested", {
      urlHash: normalized ? crawlUrlHash(normalized) : null,
    });
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The page could not be queued");
  }
}

// Meta etiketi ya da DNS TXT kaydı şimdi aranır.
export async function checkSiteVerificationAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, ProjectSchema, {});
    if (!entry.ok) return entry;
    const { access } = entry;
    const result = await checkSiteVerification(access.projectId);
    if (!result.ok) {
      return { ok: false, message: VERIFICATION_MESSAGES[result.reason] };
    }
    await record(access, "seo_site.verified", { method: result.method });
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The check could not run");
  }
}

// Tarama açık/kapalı ve sayfa sınırı: bütün ekibi etkiler; yalnız OWNER/ADMIN.
export async function setSiteCrawlAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, CrawlSchema, {
      crawlEnabled: field(formData, "crawlEnabled") === "on",
      pageLimit: field(formData, "pageLimit"),
    });
    if (!entry.ok) return entry;
    const { access, data } = entry;
    if (!(await isWorkspaceManager(access.userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const settings = {
      crawlEnabled: data.crawlEnabled,
      pageLimit: data.pageLimit,
    };
    await SeoSites.setCrawlSettings(access.projectId, settings);
    await record(access, "seo_site.crawl_settings_updated", settings);
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The setting could not be saved");
  }
}

// "Check again now": son tam taramadan 24 saat sonra; engel durumunu da siler.
export async function recrawlSiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, ProjectSchema, {});
    if (!entry.ok) return entry;
    const { access } = entry;
    if (!SeoFlags.crawl()) {
      return { ok: false, message: "The site audit is off." };
    }
    const result = await SeoSites.requestRecrawl(access.projectId);
    if (result !== "queued") {
      return { ok: false, message: RECRAWL_MESSAGES[result] };
    }
    await record(access, "seo_site.recrawl_requested");
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The audit could not be started");
  }
}

// "Mute for 7 days": yalnız bu projenin GSC/SEO uyarıları; her üye.
export async function muteSearchAlertAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, MuteSchema, {
      alertId: field(formData, "alertId"),
    });
    if (!entry.ok) return entry;
    const { access, data } = entry;
    const muted = await muteSearchAlert(
      data.alertId,
      access.projectId,
      MUTE_DAYS,
    );
    if (!muted) return { ok: false, message: "This alert was not found." };
    await record(access, "seo_site.alert_muted", {
      alertId: data.alertId,
      days: MUTE_DAYS,
    });
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "The alert could not be muted");
  }
}

// "Delete audit data": taranan sayfalar ve kontroller silinir; doğrulama ve
// ayarlar kalır (meta etiketi / TXT kaydı geçerli kalır). Yalnız OWNER/ADMIN.
export async function deleteSiteAuditDataAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(formData, ProjectSchema, {});
    if (!entry.ok) return entry;
    const { access } = entry;
    if (!(await isWorkspaceManager(access.userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const deleted = await SeoSites.deleteAuditData(access.projectId);
    await record(access, "seo_site.audit_data_deleted", { deleted });
    revalidateSearch(access.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error, "Audit data could not be deleted");
  }
}
