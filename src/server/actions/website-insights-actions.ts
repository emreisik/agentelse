"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { ActionResult } from "@/components/shared/action-form";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { isPlatformOperator } from "@/server/security/operator";
import {
  GaFindingActions,
  type GaFindingActionResult,
} from "@/server/website-analytics/analysis/lifecycle";

// Website sayfasındaki "Insights" eylemleri (GA-F4, docs/website-insights.md
// "Yüzeyler"): Accept / Dismiss / Mark done ve gölge inceleme (Useful / Not
// useful). Hepsi oturumu ve proje erişimini doğrular; inceleme ayrıca platform
// operatörü ister. Bayrak ve durum kapıları GaFindingActions'ta; burada
// yalnız sonuç mesaja çevrilir. Hiç fırlatmaz.

const INVALID_INPUT = "Something is missing. Reload the page and try again.";
const OPERATOR_ONLY = "Only the platform operator can review findings.";
const SIGN_IN_AGAIN = "Please sign in again.";
const PROJECT_UNAVAILABLE = "This project isn't available.";

const RESULT_MESSAGES: Record<Exclude<GaFindingActionResult, "ok">, string> = {
  not_found: "This finding no longer exists.",
  invalid: "This finding has already changed. Refresh the page.",
  off: "Website insights are turned off.",
};

const FindingSchema = z.object({
  projectId: z.string().trim().min(1).max(64),
  findingId: z.string().trim().min(1).max(64),
});
const ReviewSchema = FindingSchema.extend({
  verdict: z.enum(["USEFUL", "NOT_USEFUL"]),
});

type FindingInput = z.infer<typeof FindingSchema>;
type Access = FindingInput & { userId: string };

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function finish(
  projectId: string,
  result: GaFindingActionResult,
): ActionResult {
  if (result !== "ok") return { ok: false, message: RESULT_MESSAGES[result] };
  revalidatePath(`/projects/${projectId}/site`);
  return { ok: true };
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
    "[website-insights] action failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return { ok: false, message: fallback };
}

// Ortak giriş: doğrulama → oturum → proje erişimi.
async function access(
  formData: FormData,
): Promise<{ ok: true; input: Access } | { ok: false; result: ActionResult }> {
  const parsed = FindingSchema.safeParse({
    projectId: field(formData, "projectId"),
    findingId: field(formData, "findingId"),
  });
  if (!parsed.success) {
    return { ok: false, result: { ok: false, message: INVALID_INPUT } };
  }
  const { userId } = await requireUser();
  await requireProjectAccess(userId, parsed.data.projectId);
  return { ok: true, input: { ...parsed.data, userId } };
}

async function run(
  formData: FormData,
  apply: (input: Access) => Promise<GaFindingActionResult>,
  fallback: string,
): Promise<ActionResult> {
  try {
    const gate = await access(formData);
    if (!gate.ok) return gate.result;
    return finish(gate.input.projectId, await apply(gate.input));
  } catch (error) {
    return failure(error, fallback);
  }
}

const OpenIdsSchema = z.object({
  projectId: z.string().trim().min(1).max(64),
  findingIds: z.array(z.string().trim().min(1).max(64)).max(20),
});

// Rapor kartındaki bulguların hangileri hâlâ OPEN (Accept / Dismiss
// gösterilebilir). Hata ve yetkisizlikte boş döner: düğme gizli kalır.
export async function loadOpenGaFindingIdsAction(
  projectId: string,
  findingIds: string[],
): Promise<string[]> {
  try {
    const parsed = OpenIdsSchema.safeParse({ projectId, findingIds });
    if (!parsed.success) return [];
    const { userId } = await requireUser();
    await requireProjectAccess(userId, parsed.data.projectId);
    return await GaFindingActions.openLiveIds(
      parsed.data.projectId,
      parsed.data.findingIds,
    );
  } catch {
    return [];
  }
}

export async function acceptGaFindingAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(
    formData,
    (input) => GaFindingActions.accept(input),
    "Accept failed",
  );
}

export async function dismissGaFindingAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(
    formData,
    (input) => GaFindingActions.dismiss(input),
    "Dismiss failed",
  );
}

export async function markGaFindingDoneAction(
  formData: FormData,
): Promise<ActionResult> {
  return run(
    formData,
    (input) => GaFindingActions.markDone(input),
    "Mark done failed",
  );
}

// Gölge inceleme (?insights=review): yalnız platform operatörü, yalnız üyesi
// olduğu projede (requireProjectAccess'in operatör ayrıcalığı yok).
export async function reviewGaFindingAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const parsed = ReviewSchema.safeParse({
      projectId: field(formData, "projectId"),
      findingId: field(formData, "findingId"),
      verdict: field(formData, "verdict"),
    });
    if (!parsed.success) return { ok: false, message: INVALID_INPUT };
    const { projectId, findingId, verdict } = parsed.data;
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);
    if (!isPlatformOperator(userId)) {
      return { ok: false, message: OPERATOR_ONLY };
    }
    const result = await GaFindingActions.review({
      projectId,
      findingId,
      userId,
      verdict,
    });
    return finish(projectId, result);
  } catch (error) {
    return failure(error, "Review failed");
  }
}
