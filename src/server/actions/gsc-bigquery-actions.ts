"use server";

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/components/shared/action-form";
import {
  BQ_MESSAGE,
  type BqVerifyResult,
} from "@/lib/seo/agency/bq/copy";
import {
  MAX_BYTES_CHOICES_GB,
  MONTHLY_CHOICES_GB,
  gbToBytes,
} from "@/lib/seo/agency/bq/limits";
import { gscBigQueryActiveFor } from "@/lib/seo/agency/flags";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  findBqLink,
  saveBqSource,
  setBqSourceState,
} from "@/server/seo/agency/bq/source";
import { verifyBqSource } from "@/server/seo/agency/bq/verify";

// BigQuery dışa aktarımının eylemleri (docs/search-agency.md): kaydet,
// doğrula, aç/duraklat/kaldır. Hepsi oturum ve proje erişimini doğrular,
// bayrak/geliştirme listesi dışını reddeder, yalnız OWNER/ADMIN'e açıktır ve
// hiç fırlatmaz. Sahiplik (siteOwner) ayrıca kaynak katmanında denetlenir.

type Gate =
  | { ok: true; userId: string; projectId: string; linkId: string }
  | { ok: false; message: string };

async function gate(formData: FormData): Promise<Gate> {
  const projectId = String(formData.get("projectId") ?? "");
  const linkId = String(formData.get("linkId") ?? "");
  const { userId } = await requireUser();
  const { workspaceId } = await requireProjectAccess(userId, projectId);
  if (!gscBigQueryActiveFor(projectId)) {
    return { ok: false, message: BQ_MESSAGE.notAllowed };
  }
  if (!(await isWorkspaceManager(userId, workspaceId))) {
    return { ok: false, message: BQ_MESSAGE.managersOnly };
  }
  // Bağ bu projenin, geçerli kipteki birincil ya da ikincil bağı olmalı.
  if (!linkId || !(await findBqLink(projectId, linkId))) {
    return { ok: false, message: BQ_MESSAGE.noSite };
  }
  return { ok: true, userId, projectId, linkId };
}

function failure(error: unknown): { ok: false; message: string } {
  console.error(
    "[gsc-bigquery] action failed:",
    error instanceof Error ? error.name : "error",
  );
  return { ok: false, message: BQ_MESSAGE.failed };
}

function revalidate(projectId: string): void {
  revalidatePath(`/projects/${projectId}/arama`);
}

// Seçenek listesinden GB değeri (liste dışı: null).
function choice(
  value: FormDataEntryValue | null,
  allowed: readonly number[],
): number | null {
  const parsed = Number(value);
  return allowed.includes(parsed) ? parsed : null;
}

export async function saveBigQuerySourceAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const opened = await gate(formData);
    if (!opened.ok) return opened;
    const maxGb = choice(formData.get("maxGb"), MAX_BYTES_CHOICES_GB);
    const monthlyGb = choice(formData.get("monthlyGb"), MONTHLY_CHOICES_GB);
    if (maxGb === null || monthlyGb === null) {
      return { ok: false, message: BQ_MESSAGE.invalidCap };
    }
    const saved = await saveBqSource({
      projectId: opened.projectId,
      linkId: opened.linkId,
      bqProjectId: String(formData.get("bqProjectId") ?? ""),
      dataset: String(formData.get("dataset") ?? ""),
      maxBytesPerQuery: gbToBytes(maxGb),
      monthlyBudgetBytes: gbToBytes(monthlyGb),
      importAll: String(formData.get("importAll") ?? "") === "on",
      userId: opened.userId,
    });
    if (saved.ok) revalidate(opened.projectId);
    return saved;
  } catch (error) {
    return failure(error);
  }
}

export async function verifyBigQuerySourceAction(
  formData: FormData,
): Promise<{ ok: boolean; message?: string; result: BqVerifyResult | null }> {
  try {
    const opened = await gate(formData);
    if (!opened.ok) return { ok: false, message: opened.message, result: null };
    const result = await verifyBqSource({
      projectId: opened.projectId,
      linkId: opened.linkId,
      userId: opened.userId,
    });
    revalidate(opened.projectId);
    if (result.errorCode === "RATE_LIMIT" && result.steps.every((s) => s.state === "skipped")) {
      return { ok: false, message: BQ_MESSAGE.rateLimited, result };
    }
    return { ok: result.ok, result };
  } catch (error) {
    return { ...failure(error), result: null };
  }
}

export async function setBigQueryStateAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const opened = await gate(formData);
    if (!opened.ok) return opened;
    const state = String(formData.get("state") ?? "");
    if (state !== "ON" && state !== "PAUSE" && state !== "REMOVE") {
      return { ok: false, message: BQ_MESSAGE.failed };
    }
    const done = await setBqSourceState({
      projectId: opened.projectId,
      linkId: opened.linkId,
      state,
      userId: opened.userId,
    });
    if (done.ok) revalidate(opened.projectId);
    return done;
  } catch (error) {
    return failure(error);
  }
}
