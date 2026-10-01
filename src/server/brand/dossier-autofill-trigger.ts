import "server-only";

import { after } from "next/server";

import {
  type DossierFillScope,
  suggestDossierFill,
} from "@/server/brand/dossier-suggest";

// Runs the dossier suggestion AFTER the response has gone out, so Approve never
// waits for a model and never fails because of one. Kept in its own module so
// the Server Action that calls it imports one small thing, and so a test can
// replace it. after() needs a request scope: outside one (a test, a script) it
// throws, and then there is simply nothing to schedule.
export function scheduleDossierAutofill(
  scope: DossierFillScope,
  userId: string,
): void {
  try {
    after(async () => {
      try {
        const result = await suggestDossierFill(scope, {
          trigger: "approve",
          userId,
        });
        if (result.status === "FAILED") {
          console.error("[dossier-autofill] the suggestion did not complete");
        }
      } catch (error) {
        console.error(
          "[dossier-autofill] failed:",
          error instanceof Error ? error.message : error,
        );
      }
    });
  } catch {
    // No request scope: nothing to schedule.
  }
}
