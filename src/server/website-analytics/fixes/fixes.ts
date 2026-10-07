import "server-only";

import type { GaFixStatus } from "@/lib/website-analytics/fixes/types";

import { applyGaConfigChange } from "./apply";
import { cancelPendingGaFixesForCredential } from "./cleanup";
import { loadGaFixCounters } from "./counters";
import { onGaTaskApproved, syncGaFixApprovalState } from "./approval-hook";
import { proposeGaAnnotation, proposeGaFix } from "./propose";
import { listRecentGaConfigChanges, loadGaFixesView } from "./read";
import { runGaFixesDue } from "./reconcile";
import { undoGaConfigChange } from "./undo";
import type { GaFixDeps, ProposeInput, ProposeResult } from "./types";

// GA-F7 motorunun tek giriş kapısı (docs/website-fixes.md). Çağıranlar
// (server action'lar, task-planner, agency-wiring, diğer izler) bu nesneyi
// kullanır; alt modüllere doğrudan gitmez.
export const GaFixes = {
  propose(input: ProposeInput, deps?: GaFixDeps): Promise<ProposeResult> {
    return proposeGaFix(input, deps);
  },
  proposeAnnotation(
    input: { projectId: string; title: string; day?: string; dedupeKey: string },
    deps?: GaFixDeps,
  ): Promise<ProposeResult> {
    return proposeGaAnnotation(input, deps);
  },
  onTaskApproved(
    task: { id: string; projectId: string; workspaceId: string },
    deps?: GaFixDeps,
  ): Promise<void> {
    return onGaTaskApproved(task, deps);
  },
  syncApprovalState(
    changeId: string,
    deps?: GaFixDeps,
  ): Promise<GaFixStatus | null> {
    return syncGaFixApprovalState(changeId, deps);
  },
  undo(
    input: { projectId: string; changeId: string; userId: string },
    deps?: GaFixDeps,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return undoGaConfigChange(input, deps);
  },
  // tick adımı "ga-fixes"; bayrak kapalıyken sorgusuz 0 döner (reconcile içinde).
  runDue(limit?: number, now?: Date): Promise<number> {
    return runGaFixesDue(limit, now);
  },
};

export {
  applyGaConfigChange,
  cancelPendingGaFixesForCredential,
  listRecentGaConfigChanges,
  loadGaFixCounters,
  loadGaFixesView,
};
