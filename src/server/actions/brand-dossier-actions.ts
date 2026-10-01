"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import {
  type DossierField,
  type DossierFillStatus,
  suggestDossierFill,
} from "@/server/brand/dossier-suggest";
import { isGuidedSetupEnabled } from "@/server/guided-setup/flag";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The "Suggest with AI" button on the Brand Dossier card: fills the fields that
// are still empty with suggestions built from what the brand already told us
// (see brand/dossier-suggest.ts). A person's own tap, so it is not capped by the
// automatic-run attempts, only rate limited, and it writes nothing into a field
// that already has a value.

export type SuggestDossierResult =
  | { ok: true; status: DossierFillStatus; filled: DossierField[] }
  | { ok: false; message: string };

const PER_WINDOW = 3;
const WINDOW_MS = 10 * 60_000;

const MESSAGE = {
  failed: "Couldn't get suggestions. Try again in a minute.",
  disabled: "AI suggestions aren't available.",
  rate: "You've asked for suggestions a few times already. Try again in a few minutes.",
} as const;

export async function suggestBrandDossierAction(
  projectId: string,
): Promise<SuggestDossierResult> {
  // A Server Action argument can be any type: check it before it is used.
  if (typeof projectId !== "string" || projectId.length < 1 || projectId.length > 64) {
    return { ok: false, message: MESSAGE.failed };
  }
  try {
    // A public POST: the flag is re-checked here, hiding the button is not a
    // security boundary.
    if (!isGuidedSetupEnabled()) return { ok: false, message: MESSAGE.disabled };

    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);
    if (!access.defaultBrandId) return { ok: false, message: MESSAGE.failed };

    if (isRateLimited(`dossier-suggest:${userId}:${projectId}`, PER_WINDOW, WINDOW_MS)) {
      return { ok: false, message: MESSAGE.rate };
    }

    const result = await suggestDossierFill(
      {
        workspaceId: access.workspaceId,
        projectId,
        brandId: access.defaultBrandId,
      },
      { trigger: "button", userId },
    );
    if (result.status === "FILLED") {
      try {
        revalidatePath(`/projects/${projectId}`);
      } catch (error) {
        console.error(
          "[dossier-suggest] revalidate failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    return { ok: true, status: result.status, filled: result.filled };
  } catch (error) {
    console.error(
      "[dossier-suggest] action failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: MESSAGE.failed };
  }
}
