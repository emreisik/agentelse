import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { nextStepHref, type NextStep } from "@/lib/journey";
import { cn } from "@/lib/utils";

// The one thing to do next on the plan, with the button that does it (the chat
// runs the steps that need it). Same source as the chat's "next step" bar.
export function NextStepBanner({
  projectId,
  step,
  workId,
}: {
  projectId: string;
  step: NextStep;
  // The Work that holds the plan (Works on): the link opens that chat.
  workId?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3",
        step.tone === "blocker" ? "border-destructive/40" : "border-border",
      )}
    >
      <p className="flex min-w-0 items-center gap-2 text-sm">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            step.tone === "blocker" ? "bg-destructive" : "bg-success",
          )}
        />
        <span className="min-w-0">{step.title}</span>
      </p>
      <Link
        href={nextStepHref(projectId, step, { workId })}
        className={buttonVariants({ size: "sm" })}
      >
        {step.label}
      </Link>
    </div>
  );
}
