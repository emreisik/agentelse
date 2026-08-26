"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

// The step-indicator <ol> from new-project-wizard.tsx, extracted so a
// second multi-step wizard (see adset-ad-wizard.tsx) doesn't reimplement
// the same done/current/upcoming state + connecting-line visuals. Purely
// presentational — the caller owns stepIndex and navigation.
export function WizardSteps({
  steps,
  currentIndex,
  onStepClick,
  disabled,
}: {
  steps: { id: string; title: string }[];
  currentIndex: number;
  onStepClick: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <ol className="mb-8 flex items-center justify-center">
      {steps.map((step, index) => {
        const state =
          index < currentIndex
            ? "done"
            : index === currentIndex
              ? "current"
              : "upcoming";
        return (
          <li key={step.id} className="flex items-center">
            <button
              type="button"
              onClick={() => index < currentIndex && onStepClick(index)}
              disabled={index > currentIndex || disabled}
              className={cn(
                "flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-xs font-medium transition-colors",
                state === "current" && "text-primary",
                state === "done" &&
                  "cursor-pointer text-foreground hover:opacity-80",
                state === "upcoming" &&
                  "cursor-default text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                  state === "done" &&
                    "border-primary bg-primary text-primary-foreground",
                  state === "current" && "border-primary text-primary",
                  state === "upcoming" &&
                    "border-border text-muted-foreground/50",
                )}
              >
                {state === "done" ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="hidden sm:inline">{step.title}</span>
            </button>
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px w-6 shrink-0 sm:w-10",
                  index < currentIndex ? "bg-primary" : "bg-border",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
