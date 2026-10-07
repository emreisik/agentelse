"use server";

import { revalidatePath } from "next/cache";

import { gaFunnelEnabledFor } from "@/lib/website-analytics/agency/flags";
import {
  FUNNEL_MAX_STEPS,
  funnelPreset,
  validateFunnelDefinition,
} from "@/lib/website-analytics/funnel/definition";
import { isAgentelseError } from "@/server/security/errors";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { runFunnel } from "@/server/website-analytics/funnel/run";
import {
  deleteFunnel,
  GA_MAX_FUNNELS_PER_LINK,
  saveFunnel,
} from "@/server/website-analytics/funnel/store";

export type ActionResult = { ok: true } | { ok: false; message: string };

// Huni raporu eylemleri (GA-F8, GA_FUNNEL): çalıştırmayı proje üyesi olan
// herkes yapabilir (sıklık ve günlük sınır run.ts'te); kaydetme ve silme
// OWNER/ADMIN'e aittir. Bayrak ve yerel geliştirme koruması her eylemde
// denetlenir. Hiç fırlatmaz; hata metni istemciye aynen gitmez.

const OFF_MESSAGE = "Funnels aren't available right now.";
const MANAGERS_ONLY = "Only workspace owners and admins can change funnels.";

function failure(error: unknown, fallback: string): ActionResult {
  if (isAgentelseError(error)) {
    if (error.code === "LOGIN_REQUIRED" || error.code === "SESSION_EXPIRED") {
      return { ok: false, message: "Please sign in again." };
    }
    if (
      error.code === "PERMISSION_DENIED" ||
      error.code === "NOT_FOUND" ||
      error.code === "PROJECT_MISMATCH"
    ) {
      return { ok: false, message: "This project isn't available." };
    }
  }
  console.error(
    "[website-funnels] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

const RUN_MESSAGES = {
  off: OFF_MESSAGE,
  not_found: "Funnel not found.",
  throttled: "Ran a moment ago. Try again in a few minutes.",
  daily_limit: "Daily funnel limit reached for this property.",
  quota: "Google Analytics is busy. Try again later.",
  unavailable: OFF_MESSAGE,
  auth: "Reconnect Google Analytics first.",
  failed: "The funnel could not be read. Try again later.",
} as const;

const SAVE_MESSAGES = {
  off: OFF_MESSAGE,
  invalid: "Check the funnel and try again.",
  limit: `You can save up to ${GA_MAX_FUNNELS_PER_LINK} funnels per property.`,
  no_link: "This property isn't available for funnels.",
  not_found: "Funnel not found.",
} as const;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Adım satırları: üç paralel alan; adı ve değeri boş satırlar atılır.
function stepsFromForm(formData: FormData): unknown[] {
  const names = formData.getAll("step_name");
  const kinds = formData.getAll("step_kind");
  const values = formData.getAll("step_value");
  const steps: unknown[] = [];
  const rows = Math.min(names.length, FUNNEL_MAX_STEPS + 4);
  for (let index = 0; index < rows; index += 1) {
    const name = String(names[index] ?? "").trim();
    const value = String(values[index] ?? "").trim();
    if (!name && !value) continue;
    const kind = String(kinds[index] ?? "event");
    steps.push({ name, kind, value });
  }
  return steps;
}

export async function saveFunnelAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    if (!gaFunnelEnabledFor(projectId)) {
      return { ok: false, message: OFF_MESSAGE };
    }
    const preset = funnelPreset(field(formData, "preset"));
    const id = field(formData, "id") || undefined;
    const typedName = field(formData, "name").trim();
    const raw = preset
      ? { ...preset.definition, name: typedName || preset.definition.name }
      : {
          name: typedName,
          isOpen: field(formData, "isOpen") === "on",
          periodDays: Number(field(formData, "periodDays") || 28),
          steps: stepsFromForm(formData),
        };
    const checked = validateFunnelDefinition(raw);
    if (!checked.ok) return { ok: false, message: checked.message };
    const result = await saveFunnel({
      projectId,
      linkId: field(formData, "linkId"),
      userId,
      id,
      definition: checked.definition,
    });
    if (!result.ok) {
      return {
        ok: false,
        message: result.message ?? SAVE_MESSAGES[result.reason],
      };
    }
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "The funnel could not be saved.");
  }
}

export async function deleteFunnelAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return { ok: false, message: MANAGERS_ONLY };
    }
    if (!gaFunnelEnabledFor(projectId)) {
      return { ok: false, message: OFF_MESSAGE };
    }
    const result = await deleteFunnel({
      projectId,
      funnelId: field(formData, "funnelId"),
    });
    if (result !== "ok") return { ok: false, message: RUN_MESSAGES.not_found };
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "The funnel could not be deleted.");
  }
}

export async function runFunnelAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = field(formData, "projectId");
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    if (!gaFunnelEnabledFor(projectId)) {
      return { ok: false, message: OFF_MESSAGE };
    }
    const result = await runFunnel({
      projectId,
      funnelId: field(formData, "funnelId"),
    });
    if (result !== "ok") return { ok: false, message: RUN_MESSAGES[result] };
    revalidatePath(`/projects/${projectId}/site`);
    return { ok: true };
  } catch (error) {
    return failure(error, "The funnel could not be read. Try again later.");
  }
}
