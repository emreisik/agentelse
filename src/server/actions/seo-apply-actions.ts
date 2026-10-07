"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { isRateLimited } from "@/lib/rate-limit";
import { SEO_APPLY_REFUSAL_MESSAGES } from "@/lib/seo/apply/copy";
import { seoApplyEnabledFor, seoIndexNowEnabled } from "@/lib/seo/apply/flags";
import { APPLY_LIMITS } from "@/lib/seo/apply/validate";
import { applyApprovalDecision } from "@/server/commands/approval-decisions";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  ensureActionForFinding,
  listApplyCandidates,
  remainingLinksOf,
} from "@/server/seo/apply/action-link";
import { SeoIndexNow } from "@/server/seo/apply/indexnow";
import { saveApplySettings } from "@/server/seo/apply/settings";
import { SeoApply } from "@/server/seo/apply/seo-apply";
import { getChangeInProject } from "@/server/seo/apply/store";
import type { ProposeSeoChangeResult } from "@/server/seo/apply/types";

// Search sayfasındaki "Website changes" bölümü ve makale/fırsat düğmelerinin
// eylemleri (SC-F8, docs/website-apply.md). Hepsi önce oturumu ve proje
// erişimini doğrular, sonra SEO_APPLY bayrağını (IndexNow için SEO_INDEXNOW'u)
// yeniden denetler; kapalıyken sabit mesaj döner ve hiçbir iş yapmaz.
// Öneri herkese açıktır, ONAY yalnız OWNER/ADMIN'e (kapı ApprovalRepository.decide
// içinde de vardır; burada karar öncesi ayrıca denetlenir). Ret ve revizyon da
// aynı kapıdan geçer: ApprovalRepository.decide CRITICAL_CHANGE_APPROVAL için
// iptal dışındaki her kararı OWNER/ADMIN'e bırakır.
// İstemciye WordPress'ten ya da sırdan gelen hiçbir değer dönmez: yalnız sabit
// İngilizce mesajlar.

export type ActionResult =
  | { ok: true; message?: string; changeId?: string }
  | { ok: false; message: string };

const NOT_ON = "Website changes are not switched on for this project.";
const INVALID = "Something is missing. Reload the page and try again.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const TOO_MANY = "You are doing that too fast. Try again in a minute.";
const APPROVE_MANAGERS_ONLY =
  "Only a workspace owner or admin can approve this.";
const REJECT_MANAGERS_ONLY = "Only a workspace owner or admin can reject this.";
const UNDO_MANAGERS_ONLY = "Only a workspace owner or admin can undo this.";
const MANAGERS_ONLY = "Only a workspace owner or admin can do this.";
const NOT_WAITING = "This change is no longer waiting for a decision.";
const NOT_FOUND = "This change was not found.";
const INDEXNOW_OFF = "IndexNow is not switched on for this project.";
const NO_TEXT = "Add a title or a description.";
const NO_ACTION =
  "We could not prepare this change. Open it from the opportunity first.";
const DAILY_LIMIT_INVALID = `Pick a number from ${APPLY_LIMITS.dailyMin} to ${APPLY_LIMITS.dailyMax}.`;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROPOSE_BUCKET = { max: 20, windowMs: 10 * 60_000 } as const;
const WRITE_BUCKET = { max: 40, windowMs: 10 * 60_000 } as const;

type Access = {
  userId: string;
  workspaceId: string;
  brandId: string;
  projectId: string;
};

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

// Boş alan "yok", biçimi bozuk alan "geçersiz" sayılır.
function optionalId(
  formData: FormData,
  name: string,
): { ok: true; id: string | null } | { ok: false } {
  const value = field(formData, name);
  if (value === "") return { ok: true, id: null };
  return ID_PATTERN.test(value) ? { ok: true, id: value } : { ok: false };
}

async function signedIn(formData: FormData): Promise<Access> {
  const projectId = field(formData, "projectId");
  const { userId } = await requireUser();
  const { workspaceId, defaultBrandId } = await requireProjectAccess(
    userId,
    projectId,
  );
  return { userId, workspaceId, brandId: defaultBrandId, projectId };
}

// Hata metni istemciye aynen gitmez: erişim hataları proje ve çalışma alanı
// kimliği, veritabanı hataları iç ayrıntı taşır.
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
    "[seo-apply] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

function revalidate(projectId: string): void {
  revalidatePath(`/projects/${projectId}/arama`);
  revalidatePath(`/projects/${projectId}/integrations`);
  revalidatePath(`/projects/${projectId}`);
}

function limited(
  userId: string,
  bucket: string,
  spec: { max: number; windowMs: number },
): boolean {
  return isRateLimited(
    `seo-apply:${bucket}:${userId}`,
    spec.max,
    spec.windowMs,
  );
}

function proposeResult(
  result: ProposeSeoChangeResult,
  messages: { created: string; existing: string },
): ActionResult {
  if (!result.ok) {
    return {
      ok: false,
      message: result.message || SEO_APPLY_REFUSAL_MESSAGES.invalid,
    };
  }
  return {
    ok: true,
    changeId: result.changeId,
    message: result.created ? messages.created : messages.existing,
  };
}

const WAITING_MESSAGE =
  "Sent for approval. Nothing changes on your site until an owner or admin approves it.";
const ALREADY_OPEN_MESSAGE = "A request for this is already open.";

export async function proposePublishArticleAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const access = await signedIn(formData);
    if (!seoApplyEnabledFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const creative = optionalId(formData, "creativeId");
    if (!creative.ok || !creative.id) return { ok: false, message: INVALID };
    if (limited(access.userId, "propose", PROPOSE_BUCKET)) {
      return { ok: false, message: TOO_MANY };
    }
    const result = await SeoApply.propose({
      projectId: access.projectId,
      userId: access.userId,
      kind: "PUBLISH_ARTICLE",
      creativeId: creative.id,
    });
    revalidate(access.projectId);
    return proposeResult(result, {
      created: WAITING_MESSAGE,
      existing: ALREADY_OPEN_MESSAGE,
    });
  } catch (error) {
    return failure(error, "The draft could not be proposed. Try again.");
  }
}

export async function proposeMakeLiveAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const access = await signedIn(formData);
    if (!seoApplyEnabledFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const change = optionalId(formData, "changeId");
    if (!change.ok || !change.id) return { ok: false, message: INVALID };
    if (limited(access.userId, "propose", PROPOSE_BUCKET)) {
      return { ok: false, message: TOO_MANY };
    }
    const result = await SeoApply.propose({
      projectId: access.projectId,
      userId: access.userId,
      kind: "PUBLISH_LIVE",
      draftChangeId: change.id,
    });
    revalidate(access.projectId);
    return proposeResult(result, {
      created:
        "Sent for approval. The article becomes visible to everyone only after an owner or admin approves it.",
      existing: ALREADY_OPEN_MESSAGE,
    });
  } catch (error) {
    return failure(error, "The request could not be sent. Try again.");
  }
}

type LinkInput = { toUrl: string; anchor: string };

// İstemciden gelen bağlantı listesi: en çok 3 öğe, iki metin alanı. İçeriğin
// doğrulaması (kapsam, uzunluk, tekrar) propose içindedir.
function parseLinks(raw: string): LinkInput[] | null {
  if (raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > APPLY_LIMITS.linksMax
  ) {
    return null;
  }
  const links: LinkInput[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const { toUrl, anchor } = item as { toUrl?: unknown; anchor?: unknown };
    if (typeof toUrl !== "string" || typeof anchor !== "string") return null;
    links.push({ toUrl, anchor });
  }
  return links;
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

export async function proposeApplyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const access = await signedIn(formData);
    if (!seoApplyEnabledFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const kind = field(formData, "kind");
    if (kind !== "TITLE_META" && kind !== "INTERNAL_LINKS") {
      return { ok: false, message: INVALID };
    }
    const actionField = optionalId(formData, "actionId");
    const findingField = optionalId(formData, "findingId");
    if (!actionField.ok || !findingField.ok) {
      return { ok: false, message: INVALID };
    }
    if (limited(access.userId, "propose", PROPOSE_BUCKET)) {
      return { ok: false, message: TOO_MANY };
    }

    // Bulgudan gelindiyse eylem (varsa) bulunur, yoksa "Fix this" yoluyla kurulur.
    let actionId = actionField.id;
    if (!actionId && findingField.id) {
      const ensured = await ensureActionForFinding({
        projectId: access.projectId,
        findingId: findingField.id,
        userId: access.userId,
        workspaceId: access.workspaceId,
        brandId: access.brandId,
      });
      if (!ensured.ok) return { ok: false, message: NO_ACTION };
      actionId = ensured.actionId;
    }

    let url = field(formData, "url");
    let title = nullable(field(formData, "title"));
    let metaDescription = nullable(field(formData, "metaDescription"));
    let links = parseLinks(field(formData, "links"));

    // Eksik alanlar eylem kaydından tamamlanır (sayfa adresi, seçilen metin,
    // karşılanmamış bağlantılar).
    if (
      actionId &&
      (url === "" || (kind === "TITLE_META" && !title && !metaDescription))
    ) {
      const [candidate] = await listApplyCandidates(access.projectId, {
        actionIds: [actionId],
      });
      if (candidate) {
        if (url === "" && candidate.targetUrl) url = candidate.targetUrl;
        if (
          kind === "TITLE_META" &&
          !title &&
          !metaDescription &&
          candidate.after
        ) {
          title = candidate.after.title;
          metaDescription = candidate.after.metaDescription;
        }
      }
    }

    let result: ProposeSeoChangeResult;
    if (kind === "TITLE_META") {
      if (url === "") return { ok: false, message: INVALID };
      if (!title && !metaDescription) return { ok: false, message: NO_TEXT };
      result = await SeoApply.propose({
        projectId: access.projectId,
        userId: access.userId,
        kind: "TITLE_META",
        url,
        title,
        metaDescription,
        actionId,
      });
    } else {
      if (!links && actionId) {
        // Bir değişiklik tek sayfaya ve en çok 3 bağlantıya dokunur: ilk
        // sayfanın karşılanmamış bağlantıları gönderilir.
        const remaining = await remainingLinksOf(access.projectId, actionId);
        const first = remaining[0];
        if (first) {
          const page = url !== "" ? url : first.fromUrl;
          links = remaining
            .filter((link) => link.fromUrl === page)
            .slice(0, APPLY_LIMITS.linksMax)
            .map(({ toUrl, anchor }) => ({ toUrl, anchor }));
          url = page;
        }
      }
      if (!links || links.length === 0 || url === "") {
        return { ok: false, message: INVALID };
      }
      result = await SeoApply.propose({
        projectId: access.projectId,
        userId: access.userId,
        kind: "INTERNAL_LINKS",
        url,
        links,
        actionId,
      });
    }
    revalidate(access.projectId);
    return proposeResult(result, {
      created: WAITING_MESSAGE,
      existing: ALREADY_OPEN_MESSAGE,
    });
  } catch (error) {
    return failure(error, "The change could not be proposed. Try again.");
  }
}

export async function decideSeoChangeAction(
  formData: FormData,
): Promise<ActionResult> {
  const rejecting = field(formData, "decision") === "reject";
  try {
    const access = await signedIn(formData);
    if (!seoApplyEnabledFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const decision = field(formData, "decision");
    const changeField = optionalId(formData, "changeId");
    if (
      (decision !== "approve" && decision !== "reject") ||
      !changeField.ok ||
      !changeField.id
    ) {
      return { ok: false, message: INVALID };
    }
    // Onay yalnız OWNER/ADMIN'in; kapı ApprovalRepository.decide içinde de var
    // ama kullanıcıya sabit mesaj burada verilir. Ret de yöneticiye aittir:
    // kapı iptal dışındaki her kararı yalnız OWNER/ADMIN'e bırakır.
    if (
      decision === "approve" &&
      !(await isWorkspaceManager(access.userId, access.workspaceId))
    ) {
      return { ok: false, message: APPROVE_MANAGERS_ONLY };
    }
    if (limited(access.userId, "decide", WRITE_BUCKET)) {
      return { ok: false, message: TOO_MANY };
    }

    const change = await getChangeInProject(access.projectId, changeField.id);
    if (!change) return { ok: false, message: NOT_FOUND };
    const approval = change.approvalId
      ? await prisma.approval.findFirst({
          where: { id: change.approvalId, projectId: access.projectId },
        })
      : null;
    if (!approval) return { ok: false, message: NOT_FOUND };
    if (change.status !== "PROPOSED" || approval.status !== "PENDING") {
      // Karar başka yoldan (sohbet, Telegram) verilmiş olabilir: satır hizalanır.
      await SeoApply.syncApprovalState(change.id).catch(() => null);
      revalidate(access.projectId);
      return { ok: false, message: NOT_WAITING };
    }

    await applyApprovalDecision({
      approval,
      to: decision === "approve" ? "APPROVED" : "REJECTED",
      reviewedByUserId: access.userId,
      actorType: "USER",
    });
    // Karar kaydedildi; satırı hizalamak (onayda uygulamayı başlatmak) hatası
    // kararı bozmaz: tick aynı hizalamayı yeniden yapar.
    await SeoApply.syncApprovalState(change.id).catch((error: unknown) => {
      console.error(
        "[seo-apply] sync after decision failed:",
        error instanceof Error ? error.name : "unknown",
      );
      return null;
    });
    revalidate(access.projectId);
    return {
      ok: true,
      changeId: change.id,
      message:
        decision === "approve"
          ? "Approved. Agentelse is applying it now."
          : "Rejected. Nothing was changed.",
    };
  } catch (error) {
    // Karar kapısı (ApprovalRepository.decide) rolü reddettiyse sabit mesaj.
    if (isAgentelseError(error) && error.code === "PERMISSION_DENIED") {
      return {
        ok: false,
        message: rejecting ? REJECT_MANAGERS_ONLY : APPROVE_MANAGERS_ONLY,
      };
    }
    return failure(error, "The decision could not be saved. Try again.");
  }
}

export async function undoSeoChangeAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const access = await signedIn(formData);
    if (!seoApplyEnabledFor(access.projectId)) {
      return { ok: false, message: NOT_ON };
    }
    const change = optionalId(formData, "changeId");
    if (!change.ok || !change.id) return { ok: false, message: INVALID };
    if (!(await isWorkspaceManager(access.userId, access.workspaceId))) {
      return { ok: false, message: UNDO_MANAGERS_ONLY };
    }
    if (limited(access.userId, "undo", WRITE_BUCKET)) {
      return { ok: false, message: TOO_MANY };
    }
    const result = await SeoApply.undo({
      projectId: access.projectId,
      changeId: change.id,
      userId: access.userId,
    });
    revalidate(access.projectId);
    return result.ok
      ? { ok: true, changeId: change.id, message: "Undone." }
      : { ok: false, message: result.message };
  } catch (error) {
    return failure(error, "The change could not be undone. Try again.");
  }
}

// Ayarlar ve IndexNow: yalnız OWNER/ADMIN.
async function managerAccess(
  formData: FormData,
  options: { indexNow: boolean },
): Promise<{ ok: true; access: Access } | { ok: false; message: string }> {
  const access = await signedIn(formData);
  if (!seoApplyEnabledFor(access.projectId)) {
    return { ok: false, message: NOT_ON };
  }
  if (options.indexNow && !seoIndexNowEnabled()) {
    return { ok: false, message: INDEXNOW_OFF };
  }
  if (!(await isWorkspaceManager(access.userId, access.workspaceId))) {
    return { ok: false, message: MANAGERS_ONLY };
  }
  if (limited(access.userId, "settings", WRITE_BUCKET)) {
    return { ok: false, message: TOO_MANY };
  }
  return { ok: true, access };
}

export async function saveApplySettingsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await managerAccess(formData, { indexNow: false });
    if (!gate.ok) return gate;
    const raw = field(formData, "dailyLimit");
    const value = Number(raw);
    if (
      raw === "" ||
      !Number.isInteger(value) ||
      value < APPLY_LIMITS.dailyMin ||
      value > APPLY_LIMITS.dailyMax
    ) {
      return { ok: false, message: DAILY_LIMIT_INVALID };
    }
    const { access } = gate;
    await saveApplySettings({
      projectId: access.projectId,
      workspaceId: access.workspaceId,
      userId: access.userId,
      dailyLimit: value,
    });
    revalidate(access.projectId);
    return { ok: true, message: "Saved." };
  } catch (error) {
    return failure(error, "The setting could not be saved. Try again.");
  }
}

export async function indexNowEnableAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await managerAccess(formData, { indexNow: true });
    if (!gate.ok) return gate;
    const { access } = gate;
    const view = await SeoIndexNow.enable(
      access.projectId,
      access.workspaceId,
      access.userId,
    );
    revalidate(access.projectId);
    return view.key
      ? {
          ok: true,
          message: "IndexNow is on. Add the key file, then check it.",
        }
      : { ok: false, message: "Connect WordPress first." };
  } catch (error) {
    return failure(error, "IndexNow could not be switched on. Try again.");
  }
}

export async function indexNowVerifyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await managerAccess(formData, { indexNow: true });
    if (!gate.ok) return gate;
    const { access } = gate;
    const result = await SeoIndexNow.verify(access.projectId, access.userId);
    revalidate(access.projectId);
    return result.ok
      ? { ok: true, message: "The key file is in place." }
      : { ok: false, message: result.message };
  } catch (error) {
    return failure(error, "The key file could not be checked. Try again.");
  }
}

export async function indexNowDisableAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const gate = await managerAccess(formData, { indexNow: true });
    if (!gate.ok) return gate;
    const { access } = gate;
    await SeoIndexNow.disable(access.projectId, access.userId);
    revalidate(access.projectId);
    return { ok: true, message: "IndexNow is off." };
  } catch (error) {
    return failure(error, "IndexNow could not be switched off. Try again.");
  }
}
