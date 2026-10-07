"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import { gscAgencyActiveFor } from "@/lib/seo/agency/flags";
import type { SplitEligibility } from "@/lib/seo/agency/split/assign";
import { isSplitChangeKind } from "@/lib/seo/agency/split/types";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { GscSplitTests } from "@/server/seo/agency/split/store";

// Bölünmüş SEO testi eylemleri (docs/search-agency.md). Hepsi oturumu ve proje
// erişimini doğrular, GSC_AGENCY kapalıyken hiçbir iş yapmaz ve hiç fırlatmaz.
// Hata metni istemciye aynen gitmez; yalnız sabit İngilizce mesajlar döner.
// CMS yolu ek olarak çalışma alanı sahibi ya da yöneticisi ister.

const NOT_AVAILABLE = "Not available";
const MANAGERS_ONLY = "Only workspace owners and admins can change this.";
const INVALID = "Something is missing. Reload the page and try again.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";
const GONE = "This test no longer exists.";
const TOO_SOON = "We checked this a few minutes ago. Try again shortly.";
const FAILED = "That didn't work. Try again.";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_MAX = 80;
const GROUPS_MAX = 5;

type Gate =
  | { ok: true; userId: string; workspaceId: string; projectId: string }
  | { ok: false; message: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

// Oturum, proje erişimi ve bayrak (açılış listesi dahil).
async function gate(projectIdInput: unknown): Promise<Gate> {
  const projectId = idOf(projectIdInput);
  if (!projectId) return { ok: false, message: INVALID };
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (!gscAgencyActiveFor(projectId)) {
    return { ok: false, message: NOT_AVAILABLE };
  }
  return { ok: true, userId, workspaceId: access.workspaceId, projectId };
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
    "[gsc-split] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: FAILED };
}

function revalidate(projectId: string): void {
  try {
    revalidatePath(`/projects/${projectId}/arama`);
  } catch {
    console.error("[gsc-split] revalidate failed");
  }
}

function groupsOf(values: readonly unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= GROUP_MAX)
    .slice(0, GROUPS_MAX);
}

export async function previewSplitPopulationAction(input: {
  projectId: string;
  linkId: string;
  pageGroups: string[];
}): Promise<
  | {
      ok: true;
      eligibility: SplitEligibility;
      pages: number;
      capped: boolean;
      groups: { group: string; pages: number }[];
    }
  | { ok: false; message: string }
> {
  try {
    const entry = await gate(input?.projectId);
    if (!entry.ok) return entry;
    const linkId = idOf(input.linkId);
    if (!linkId || !Array.isArray(input.pageGroups)) {
      return { ok: false, message: INVALID };
    }
    return await GscSplitTests.populationPreview({
      projectId: entry.projectId,
      linkId,
      pageGroups: groupsOf(input.pageGroups),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function createSplitTestAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const linkId = idOf(field(formData, "linkId"));
    const changeKind = field(formData, "changeKind");
    if (!linkId || !isSplitChangeKind(changeKind)) {
      return { ok: false, message: INVALID };
    }
    const result = await GscSplitTests.create({
      projectId: entry.projectId,
      linkId,
      userId: entry.userId,
      name: field(formData, "name"),
      changeKind,
      description: field(formData, "description") || null,
      pageGroups: groupsOf(formData.getAll("pageGroups")),
      change: {
        titlePattern: field(formData, "titlePattern") || null,
        metaPattern: field(formData, "metaPattern") || null,
        schemaType: field(formData, "schemaType") || null,
        note: field(formData, "note") || null,
      },
    });
    if (!result.ok) return { ok: false, message: result.message };
    revalidate(entry.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function markSplitTestAppliedAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const testId = idOf(field(formData, "testId"));
    if (!testId) return { ok: false, message: INVALID };
    const result = await GscSplitTests.markApplied({
      projectId: entry.projectId,
      testId,
      userId: entry.userId,
      appliedOn: field(formData, "appliedOn"),
    });
    if (!result.ok) return result;
    revalidate(entry.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function applySplitTestViaCmsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    if (!(await isWorkspaceManager(entry.userId, entry.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    const testId = idOf(field(formData, "testId"));
    if (!testId) return { ok: false, message: INVALID };
    const result = await GscSplitTests.applyViaCms({
      projectId: entry.projectId,
      testId,
      userId: entry.userId,
    });
    if (!result.ok) return result;
    revalidate(entry.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelSplitTestAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const testId = idOf(field(formData, "testId"));
    if (!testId) return { ok: false, message: INVALID };
    const result = await GscSplitTests.cancel({
      projectId: entry.projectId,
      testId,
      userId: entry.userId,
    });
    if (!result.ok) return result;
    revalidate(entry.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function checkSplitTestNowAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const entry = await gate(field(formData, "projectId"));
    if (!entry.ok) return entry;
    const testId = idOf(field(formData, "testId"));
    if (!testId) return { ok: false, message: INVALID };
    const queued = await GscSplitTests.checkNow(entry.projectId, testId);
    if (queued === "too_soon") return { ok: false, message: TOO_SOON };
    if (queued === "not_found") return { ok: false, message: GONE };
    revalidate(entry.projectId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
