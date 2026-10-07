"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import { gscAgencyActiveFor } from "@/lib/seo/agency/flags";
import { ADD_SITE_MESSAGE } from "@/lib/seo/agency/copy";
import {
  validatePageGroupRules,
  type PageGroupPreview,
} from "@/lib/seo/agency/page-groups";
import { prisma } from "@/lib/prisma";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { GscPageGroups } from "@/server/seo/agency/page-groups";
import { GscSites } from "@/server/seo/agency/sites";

// Çok siteli Search Console ve sayfa grubu eylemleri (SC-F9). Sıra her
// eylemde aynı: oturum → proje erişimi → bayrak → workspace yöneticisi.
// Denetim kaydı ilgili store'larda yazılır (yalnız kimlikler).

const NOT_AVAILABLE = "Not available";
const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const OPERATION_FAILED = "Operation failed";
const MAX_RULES_JSON_BYTES = 20 * 1024;

type Guarded =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; message: string };

async function guard(projectId: string): Promise<Guarded> {
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (!gscAgencyActiveFor(projectId)) {
    return { ok: false, message: NOT_AVAILABLE };
  }
  if (!(await isWorkspaceManager(userId, access.workspaceId))) {
    return { ok: false, message: MANAGERS_ONLY };
  }
  return { ok: true, userId, workspaceId: access.workspaceId };
}

// Hata metni istemciye aynen gitmez: erişim hataları proje ve çalışma alanı
// kimliği, veritabanı hataları iç ayrıntı taşır.
function failure(error: unknown): { ok: false; message: string } {
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
    "[gsc-sites] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: OPERATION_FAILED };
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function refresh(projectId: string): void {
  revalidatePath(`/projects/${projectId}/arama`);
  revalidatePath("/search");
}

export async function addSecondarySiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = text(formData, "projectId");
    const siteUrl = text(formData, "siteUrl");
    const guarded = await guard(projectId);
    if (!guarded.ok) return guarded;
    const result = await GscSites.add({
      projectId,
      siteUrl,
      userId: guarded.userId,
    });
    if (!result.ok) {
      return { ok: false, message: ADD_SITE_MESSAGE[result.code] };
    }
    refresh(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function removeSecondarySiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = text(formData, "projectId");
    const linkId = text(formData, "linkId");
    const guarded = await guard(projectId);
    if (!guarded.ok) return guarded;
    const result = await GscSites.remove({
      projectId,
      linkId,
      userId: guarded.userId,
    });
    if (result.ok) refresh(projectId);
    return result;
  } catch (error) {
    return failure(error);
  }
}

export async function makePrimarySiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = text(formData, "projectId");
    const linkId = text(formData, "linkId");
    const guarded = await guard(projectId);
    if (!guarded.ok) return guarded;
    const result = await GscSites.makePrimary({
      projectId,
      linkId,
      userId: guarded.userId,
    });
    if (result.ok) {
      refresh(projectId);
      revalidatePath(`/projects/${projectId}/integrations`);
    }
    return result;
  } catch (error) {
    return failure(error);
  }
}

// Bağ bu projenin, geçerli kipin izlenen sitelerinden biri olmalı.
async function linkBelongs(projectId: string, linkId: string): Promise<boolean> {
  const link = await prisma.gscSiteLink.findFirst({
    where: {
      id: linkId,
      projectId,
      isMock: gscMockMode(),
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
    select: { id: true },
  });
  return link !== null;
}

function firstRuleMessage(
  errors: { index: number; message: string }[],
): string {
  const first = errors[0];
  return first ? `Rule ${first.index + 1}: ${first.message}` : "Invalid rules";
}

export async function savePageGroupRulesAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = text(formData, "projectId");
    const linkId = text(formData, "linkId");
    const raw = formData.get("rules");
    const guarded = await guard(projectId);
    if (!guarded.ok) return guarded;
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, message: "Invalid rules" };
    }
    if (new TextEncoder().encode(raw).length > MAX_RULES_JSON_BYTES) {
      return { ok: false, message: "The rules are too long." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, message: "Invalid rules" };
    }
    const checked = validatePageGroupRules(parsed);
    if (!checked.ok) {
      return { ok: false, message: firstRuleMessage(checked.errors) };
    }
    if (!(await linkBelongs(projectId, linkId))) {
      return { ok: false, message: "Site not found" };
    }
    const saved = await GscPageGroups.save({
      projectId,
      linkId,
      rules: checked.rules,
      userId: guarded.userId,
    });
    if (!saved.ok) return saved;
    refresh(projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function previewPageGroupRulesAction(input: {
  projectId: string;
  linkId: string;
  rules: { group: string; match: string; pattern: string }[];
}): Promise<
  { ok: true; preview: PageGroupPreview } | { ok: false; message: string }
> {
  try {
    const guarded = await guard(input.projectId);
    if (!guarded.ok) return guarded;
    const checked = validatePageGroupRules(input.rules);
    if (!checked.ok) {
      return { ok: false, message: firstRuleMessage(checked.errors) };
    }
    if (!(await linkBelongs(input.projectId, input.linkId))) {
      return { ok: false, message: "Site not found" };
    }
    const preview = await GscPageGroups.preview({
      linkId: input.linkId,
      rules: checked.rules,
    });
    return { ok: true, preview };
  } catch (error) {
    return failure(error);
  }
}
