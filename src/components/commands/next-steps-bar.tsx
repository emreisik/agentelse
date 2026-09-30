"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { NextStep } from "@/lib/journey";
import { enablePlanPublishingAction } from "@/server/actions/plan-progress-actions";

// The "what next" strip above the composer: the first step is the one to take
// (a button), the rest are quick alternatives. It only renders what the server
// worked out from the records (src/server/agency/journey/next-steps.ts), so it
// never offers something that cannot be done, and every click is an action the
// client could take piece by piece, just without typing.

const PULSE_MS = 1_800;

// Brings the newest card of a creative into view and rings it for a moment.
// false when no card of it is on the page.
function revealCreative(creativeId: string): boolean {
  const cards = document.querySelectorAll<HTMLElement>(
    `[data-creative-id="${CSS.escape(creativeId)}"]`,
  );
  const card = cards[cards.length - 1];
  if (!card) return false;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.style.boxShadow = "0 0 0 2px var(--ws-accent)";
  setTimeout(() => {
    card.style.boxShadow = "";
  }, PULSE_MS);
  return true;
}

// Runs a step: what a click on the bar does, and what `?next=<kind>` does on
// landing. Every branch is something the client could do piece by piece.
export function useRunNextStep({
  projectId,
  onProducePlan,
  onSend,
}: {
  projectId: string;
  onProducePlan: (planId: string) => void;
  onSend: (text: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The pieces the client is posting themselves, while their dialog is open.
  const [manual, setManual] = useState<string[] | null>(null);
  // The measurement results dialog.
  const [results, setResults] = useState(false);

  const run = (step: NextStep) => {
    const { action } = step;
    switch (action.kind) {
      case "produce_plan":
        onProducePlan(action.planId);
        return;
      case "review_queue":
        if (!revealCreative(action.creativeId)) {
          router.push(
            `/projects/${projectId}/takvim?creative=${action.creativeId}`,
          );
        }
        return;
      case "connect_channel":
        router.push(`/projects/${projectId}/integrations`);
        return;
      case "plan_next":
        onSend(`Plan the next two weeks, starting after ${action.afterDate}.`);
        return;
      case "enable_scheduled_publish":
        startTransition(async () => {
          const result = await enablePlanPublishingAction(projectId);
          if (result.ok) {
            toast.success(
              `Scheduled posting is on (${result.times.join(", ")}).`,
            );
          } else {
            toast.error(result.message);
          }
          router.refresh();
        });
        return;
      case "publish_manual":
        setManual(action.creativeIds);
        return;
      case "show_results":
        setResults(true);
        return;
    }
  };

  return {
    run,
    pending,
    manual,
    closeManual: () => setManual(null),
    results,
    closeResults: () => setResults(false),
  };
}

export function NextStepsBar({
  steps,
  disabled = false,
  onAct,
}: {
  steps: readonly NextStep[];
  // A run or a turn is in progress: the buttons wait.
  disabled?: boolean;
  onAct: (step: NextStep) => void;
}) {
  const [primary, ...rest] = steps;
  if (!primary) return null;

  return (
    <section
      aria-label="Next steps"
      className="flex flex-col gap-2 rounded-xl border px-3 py-2.5"
      style={{
        borderColor: "var(--ws-border)",
        background: "var(--ws-surface)",
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p
          className="flex min-w-0 flex-1 items-center gap-2 text-xs"
          style={{ color: "var(--ws-text-2)" }}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{
              background:
                primary.tone === "blocker"
                  ? "var(--destructive)"
                  : "var(--ws-olive)",
            }}
          />
          <span className="min-w-0">{primary.title}</span>
        </p>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={() => onAct(primary)}
          className="rounded-[10px]"
          style={{
            background: "var(--ws-accent)",
            color: "var(--ws-on-accent)",
          }}
        >
          {disabled ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {primary.label}
        </Button>
      </div>
      {rest.length > 0 ? (
        <div className="scrollbar-none flex gap-2 overflow-x-auto">
          {rest.map((step) => (
            <button
              key={step.key}
              type="button"
              disabled={disabled}
              title={step.title}
              onClick={() => onAct(step)}
              className="shrink-0 rounded-[7px] border px-3 py-1.5 text-[11px] font-medium whitespace-nowrap transition-colors hover:bg-[var(--ws-hover)] disabled:opacity-50 sm:text-xs"
              style={{
                borderColor: "var(--ws-border)",
                background: "var(--ws-surface)",
                color: "var(--ws-text-2)",
              }}
            >
              {step.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
