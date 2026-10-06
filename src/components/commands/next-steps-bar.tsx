"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { NextStep } from "@/lib/journey";
import {
  dismissSteps,
  parseDismissal,
  visibleSteps,
} from "@/lib/journey-dismissal";
import { enablePlanPublishingAction } from "@/server/actions/plan-progress-actions";
import {
  approvePlansAction,
  type ApprovePlansResult,
} from "@/server/actions/work-approve-actions";

// The "what next" strip above the composer: the first step is the one to take
// (a button), the rest are quick alternatives. It only renders what the server
// worked out from the records (src/server/agency/journey/next-steps.ts), so it
// never offers something that cannot be done, and every click is an action the
// client could take piece by piece, just without typing.

const PULSE_MS = 1_800;

// "Hide for now" lives in the browser: a convenience that must never break the
// bar, so every storage access is guarded and the bar works without it.
const storageKey = (projectId: string) => `next-steps-dismissed:${projectId}`;
const DISMISS_EVENT = "next-steps-dismissed";

function readStored(projectId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(projectId));
  } catch {
    return null;
  }
}

function subscribeStored(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DISMISS_EVENT, onChange);
  };
}

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

// The toast for an approve_plan run. Copy comes from the Works design.
export function approvePlansToast(result: ApprovePlansResult): {
  kind: "success" | "error";
  text: string;
} {
  if (!result.ok) {
    return { kind: "error", text: result.message };
  }
  const { approved, failed, held, locked } = result;
  let text = `${approved} approved.`;
  if (failed > 0) text = `${approved} approved, ${failed} could not be.`;
  else if (held > 0)
    text = `${approved} approved. ${held} on hold until you set a time.`;
  if (locked > 0) text += ` ${locked} skipped: their Work is completed.`;
  return { kind: failed > 0 ? "error" : "success", text };
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
      case "approve_plan":
        startTransition(async () => {
          const result = await approvePlansAction(projectId, {
            planIds: action.planIds,
            creativeIds: action.creativeIds,
          });
          const { kind, text } = approvePlansToast(result);
          if (kind === "success") toast.success(text);
          else toast.error(text);
          // On success the action's revalidatePath already re-rendered the page.
          if (!result.ok || result.failed > 0) router.refresh();
        });
        return;
      case "connect_channel":
        router.push(`/projects/${projectId}/integrations`);
        return;
      case "plan_next":
        onSend(`Plan the next two weeks, starting after ${action.afterDate}.`);
        return;
      case "open_weekly_draft":
        router.push(
          `/projects/${projectId}?work=${encodeURIComponent(action.workId)}`,
        );
        return;
      case "plan_from_ideas":
        // The chat sees the pool (works-notes.ts) and links each post to its
        // idea; a named idea is asked for by title and id.
        onSend(
          action.idea
            ? `Plan a post from the pool idea "${action.idea.title}" (idea ${action.idea.id}).`
            : "Plan the next week from the ideas in the idea pool.",
        );
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
      case "connect_analytics":
        router.push(
          `/projects/${projectId}/integrations?integration=google_analytics`,
        );
        return;
      case "fix_tracking":
        router.push(action.href);
        return;
      case "fix_search_issue":
        router.push(
          `/projects/${projectId}/arama?issue=${encodeURIComponent(action.alertId)}#health`,
        );
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
  projectId,
  disabled = false,
  onAct,
}: {
  steps: readonly NextStep[];
  projectId: string;
  // A run or a turn is in progress: the buttons wait.
  disabled?: boolean;
  onAct: (step: NextStep) => void;
}) {
  // Server render and hydration see "nothing hidden"; the browser's own
  // record applies right after.
  const stored = useSyncExternalStore(
    subscribeStored,
    () => readStored(projectId),
    () => null,
  );
  const dismissal = useMemo(() => parseDismissal(stored), [stored]);
  const [now] = useState(() => Date.now());

  // The bar shows what is waiting. Quiet steps (an account that is not
  // connected) stay on the plan card and the calendar, and what the client
  // hid stays hidden until it grows or something new comes up.
  const shown = visibleSteps(
    steps.filter((step) => !step.quiet),
    dismissal,
    now,
  );
  const [primary, ...rest] = shown;
  if (!primary) return null;

  const hide = () => {
    try {
      window.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify(dismissSteps(shown, dismissal, Date.now())),
      );
    } catch {
      // No storage (private window): the bar simply stays.
      return;
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  };

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
        <span className="flex items-center gap-1">
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Hide for now"
            title="Hide for now"
            onClick={hide}
          >
            <X className="size-3.5" />
          </Button>
        </span>
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
