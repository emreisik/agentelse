"use server";

import { revalidatePath } from "next/cache";

import { SeoActionFlags, seoActionsAllowedFor } from "@/lib/seo/action-flags";
import { GscFlags } from "@/lib/seo/flags";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import {
  SEO_DISMISS_REASONS,
  type SeoDismissReason,
  type SeoShadowVerdict,
} from "@/lib/seo/opportunity-types";
import type { SeoDecision } from "@/lib/seo/finding-lifecycle";
import { budgetMessageForProject } from "@/server/billing/budget-stop";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { isAgentelseError } from "@/server/security/errors";
import { isPlatformOperator } from "@/server/security/operator";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  acceptBrandTermSuggestion,
  dismissBrandTermSuggestion,
  suggestBrandTerms,
} from "@/server/seo/opportunities/brand-suggest";
import { trackFindingDone } from "@/server/seo/actions/fix-this";
import {
  decideFinding,
  reviewShadowFinding,
} from "@/server/seo/opportunities/findings-store";

// Search sayfasındaki "Opportunities" bölümünün eylemleri (SC-F4,
// docs/search-opportunities.md): Accept / Dismiss / Mark done, gölge
// inceleme (yalnız platform operatörü) ve marka terimi önerileri. Hepsi
// oturumu ve proje erişimini doğrular; GSC_SYNC, SEO_INSIGHTS ve açılış
// listesi dışındaki projede hiçbir iş yapmaz ve hiç fırlatmaz. Bulgu
// kararlarının denetim kaydını findings-store yazar (Google metni yok).

export type ActionResult =
  { ok: true; message?: string } | { ok: false; message: string };

const NOT_ON = "Search opportunities aren't turned on.";
const NOT_ALLOWED = "Search opportunities aren't set up for this project here.";
const NOT_OPEN = "This opportunity is no longer open.";
const INVALID = "Something is missing. Reload the page and try again.";
const OPERATORS_ONLY = "Only platform operators can review shadow findings.";
const NOT_CONNECTED = "Search Console isn't connected for this project.";
const NOT_SUGGESTED = "This suggestion is no longer available.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const BRAND_TERM_ADDED =
  "Brand term added. Brand and non-brand clicks update with the next sync.";

const SUGGEST_MESSAGES = {
  off: NOT_ON,
  no_link: NOT_CONNECTED,
  budget: "The AI budget for today is used up. Try again tomorrow.",
  failed: "We couldn't suggest brand terms right now. Try again later.",
  too_soon:
    "We looked at your searches for brand terms recently. Try again later.",
} as const;

const ACCEPT_TERM_MESSAGES = {
  no_link: NOT_CONNECTED,
  not_suggested: NOT_SUGGESTED,
  too_long:
    "Your brand terms would be too long together. Remove some or use shorter ones.",
} as const;

const DECISION_MESSAGE: Readonly<Record<SeoDecision, string>> = {
  ACCEPT: "Accepted",
  DISMISS: "Dismissed",
  DONE: "Marked as done",
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TERM_MAX = 100;

type Access = { userId: string; workspaceId: string; projectId: string };
type Gate = { ok: true; access: Access } | { ok: false; message: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// Oturum ve proje erişimi; bayraklar ve izin listesi yalnız ortamdan okunur.
async function signedIn(formData: FormData): Promise<Access> {
  const projectId = field(formData, "projectId");
  const { userId } = await requireUser();
  const { workspaceId } = await requireProjectAccess(userId, projectId);
  return { userId, workspaceId, projectId };
}

// Kullanıcı eylemleri: GSC_SYNC + SEO_INSIGHTS=on + açılış listesi.
async function userGate(formData: FormData): Promise<Gate> {
  const access = await signedIn(formData);
  if (!GscFlags.sync() || !SeoInsightFlags.userFacing()) {
    return { ok: false, message: NOT_ON };
  }
  if (!seoInsightsAllowedFor(access.projectId)) {
    return { ok: false, message: NOT_ALLOWED };
  }
  return { ok: true, access };
}

// Gölge inceleme: motor açık (shadow ya da on) ve platform operatörü.
async function reviewGate(formData: FormData): Promise<Gate> {
  const access = await signedIn(formData);
  if (!GscFlags.sync() || !SeoInsightFlags.active()) {
    return { ok: false, message: NOT_ON };
  }
  if (!isPlatformOperator(access.userId)) {
    return { ok: false, message: OPERATORS_ONLY };
  }
  if (!seoInsightsAllowedFor(access.projectId)) {
    return { ok: false, message: NOT_ALLOWED };
  }
  return { ok: true, access };
}

// Hata metni istemciye aynen gitmez: erişim hataları proje ve çalışma alanı
// kimliği, veritabanı hataları iç ayrıntı taşır. Yalnız sabit İngilizce mesaj.
function failure(error: unknown, fallback: string): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: SIGN_IN_AGAIN };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: PROJECT_UNAVAILABLE };
    }
  }
  console.error(
    "[search-opportunities] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function revalidateSearch(projectId: string) {
  revalidatePath(`/projects/${projectId}/arama`);
}

function findingIdOf(formData: FormData): string | null {
  const id = field(formData, "findingId");
  return ID_PATTERN.test(id) ? id : null;
}

function termOf(formData: FormData): string | null {
  const term = field(formData, "term");
  return term.length > 0 && term.length <= TERM_MAX ? term : null;
}

function dismissReasonOf(
  formData: FormData,
): { ok: true; reason: SeoDismissReason | undefined } | { ok: false } {
  const value = field(formData, "reason");
  if (value === "") return { ok: true, reason: undefined };
  const reason = SEO_DISMISS_REASONS.find((known) => known === value);
  return reason ? { ok: true, reason } : { ok: false };
}

async function decide(
  formData: FormData,
  decision: SeoDecision,
): Promise<ActionResult> {
  try {
    const gate = await userGate(formData);
    if (!gate.ok) return gate;
    const { userId, projectId } = gate.access;
    const findingId = findingIdOf(formData);
    if (!findingId) return { ok: false, message: INVALID };
    let reason: SeoDismissReason | undefined;
    if (decision === "DISMISS") {
      const parsed = dismissReasonOf(formData);
      if (!parsed.ok) return { ok: false, message: INVALID };
      reason = parsed.reason;
    }
    const result = await decideFinding({
      projectId,
      findingId,
      decision,
      ...(reason ? { reason } : {}),
      userId,
    });
    if (!result.ok) return { ok: false, message: NOT_OPEN };
    // SC-F6: "Done" ölçüm başlatır; hata Done kararını bozmaz (günlük doğrulayıcı kalanı tamamlar).
    if (
      decision === "DONE" &&
      SeoActionFlags.loop() &&
      seoActionsAllowedFor(projectId)
    ) {
      await trackFindingDone({
        projectId,
        findingId,
        userId,
        workspaceId: gate.access.workspaceId,
      }).catch((error: unknown) =>
        console.error(
          "[seo-actions] done tracking failed:",
          error instanceof Error ? error.message : error,
        ),
      );
    }
    revalidateSearch(projectId);
    return { ok: true, message: DECISION_MESSAGE[decision] };
  } catch (error) {
    return failure(error, "The opportunity could not be updated");
  }
}

export async function acceptOpportunityAction(
  formData: FormData,
): Promise<ActionResult> {
  return decide(formData, "ACCEPT");
}

export async function dismissOpportunityAction(
  formData: FormData,
): Promise<ActionResult> {
  return decide(formData, "DISMISS");
}

export async function markOpportunityDoneAction(
  formData: FormData,
): Promise<ActionResult> {
  return decide(formData, "DONE");
}

// Gölge inceleme: operatör bulgunun işe yarayıp yaramadığını işaretler;
// /health/search-opportunities kesinliği buradan hesaplar.
export async function reviewShadowFindingAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await reviewGate(formData);
    if (!gate.ok) return gate;
    const { userId, projectId } = gate.access;
    const findingId = findingIdOf(formData);
    const raw = field(formData, "verdict");
    const verdict: SeoShadowVerdict | null =
      raw === "USEFUL" || raw === "NOT_USEFUL" ? raw : null;
    if (!findingId || !verdict) return { ok: false, message: INVALID };
    const saved = await reviewShadowFinding({
      projectId,
      findingId,
      verdict,
      userId,
    });
    if (!saved) return { ok: false, message: NOT_OPEN };
    revalidateSearch(projectId);
    return { ok: true, message: "Thanks for the review" };
  } catch (error) {
    return failure(error, "The review could not be saved");
  }
}

function recordBrandAudit(
  access: Access,
  action: string,
  count: number,
): Promise<unknown> {
  // Denetim kaydında terimin kendisi değil, yalnız sayısı durur.
  return AuditLogRepository.record({
    workspaceId: access.workspaceId,
    projectId: access.projectId,
    actorType: "USER",
    actorId: access.userId,
    action,
    entityType: "GscSiteLink",
    entityId: access.projectId,
    metadata: { count },
  });
}

// "Suggest terms": aramalardan marka yazımları önerilir (lite LLM, ≤20
// maskeli sorgu); kullanıcı her birini tek tek onaylar.
export async function suggestBrandTermsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await userGate(formData);
    if (!gate.ok) return gate;
    const { access } = gate;
    const result = await suggestBrandTerms(access.projectId);
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === "budget"
            ? await budgetMessageForProject(
                access.projectId,
                SUGGEST_MESSAGES.budget,
              )
            : SUGGEST_MESSAGES[result.reason],
      };
    }
    await recordBrandAudit(
      access,
      "search_console.brand_terms_suggested",
      result.suggestions.length,
    );
    revalidateSearch(access.projectId);
    return { ok: true, message: "Looking at your searches for brand terms…" };
  } catch (error) {
    return failure(error, "Brand terms could not be suggested");
  }
}

// Öneri onayı: W1 saveBrandTerms ile terim listesine eklenir; sorgular hemen
// yeniden sınıflanır, marka serisi bir sonraki senkronda çekilir.
export async function acceptBrandTermSuggestionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await userGate(formData);
    if (!gate.ok) return gate;
    const { access } = gate;
    const term = termOf(formData);
    if (!term) return { ok: false, message: INVALID };
    // Denetim kaydını (yalnız sayı) brand-suggest kendisi yazar.
    const result = await acceptBrandTermSuggestion({
      projectId: access.projectId,
      term,
      userId: access.userId,
    });
    if (!result.ok) {
      return { ok: false, message: ACCEPT_TERM_MESSAGES[result.reason] };
    }
    revalidateSearch(access.projectId);
    return { ok: true, message: BRAND_TERM_ADDED };
  } catch (error) {
    return failure(error, "The brand term could not be added");
  }
}

export async function dismissBrandTermSuggestionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await userGate(formData);
    if (!gate.ok) return gate;
    const { access } = gate;
    const term = termOf(formData);
    if (!term) return { ok: false, message: INVALID };
    const dismissed = await dismissBrandTermSuggestion({
      projectId: access.projectId,
      term,
    });
    if (!dismissed) return { ok: false, message: NOT_SUGGESTED };
    revalidateSearch(access.projectId);
    return { ok: true, message: "Dismissed" };
  } catch (error) {
    return failure(error, "The suggestion could not be dismissed");
  }
}
