import type { CapabilityKey } from "@prisma/client";

// Pure formatting — turns a Task's payload into human-readable rows for
// the approval-request chat card (see idea-event-card.tsx). Returns
// undefined for capabilities with nothing structured to show; callers
// (task-planner.ts) pass that straight through, so ordinary
// human-requested/creative approvals render exactly as before.
export function buildApprovalDetails(
  capability: CapabilityKey,
  payload: unknown,
): { label: string; value: string }[] | undefined {
  if (capability !== "META_CAMPAIGN_UPDATE") return undefined;
  const p = (payload ?? {}) as Record<string, unknown>;

  const details: { label: string; value: string }[] = [];
  const current =
    typeof p.currentDailyBudgetCents === "number"
      ? p.currentDailyBudgetCents
      : undefined;
  const proposed =
    typeof p.proposedDailyBudgetCents === "number"
      ? p.proposedDailyBudgetCents
      : undefined;
  if (current !== undefined && proposed !== undefined) {
    details.push({
      label: "Daily budget",
      value: `${(current / 100).toFixed(2)} → ${(proposed / 100).toFixed(2)}`,
    });
  }
  if (typeof p.proposedStatus === "string") {
    details.push({ label: "Proposed status", value: p.proposedStatus });
  }
  if (typeof p.reason === "string") {
    details.push({ label: "Reason", value: p.reason });
  }
  return details.length > 0 ? details : undefined;
}
