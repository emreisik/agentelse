import { cn } from "@/lib/utils";
import type { PlanItemStage } from "@/lib/journey";

// The dot on a saved piece: one colour per stage, the same ones the status line
// under a plan uses.
const STAGE_COLOR: Record<PlanItemStage, string> = {
  PLANNED: "var(--ws-text-3)",
  PRODUCING: "var(--ws-olive)",
  FAILED: "var(--destructive)",
  IN_REVIEW: "var(--ws-accent)",
  REJECTED: "var(--destructive)",
  APPROVED: "var(--ws-approved)",
  PUBLISHED: "var(--ws-approved)",
};

export function StageDot({ stage }: { stage: PlanItemStage }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        stage === "PRODUCING" && "animate-pulse",
      )}
      style={{ background: STAGE_COLOR[stage] }}
    />
  );
}
