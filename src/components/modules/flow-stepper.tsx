"use client";

import { Check } from "lucide-react";
import type { CSSProperties } from "react";

import type { ModuleFlowStep } from "@/lib/module-flows/card";
import { MODULES, type ModuleKey } from "@/lib/modules/catalog";
import {
  flowStatesOf,
  flowStepsOf,
  type FlowStep,
  type FlowStepState,
} from "@/lib/modules/flow";
import { cn } from "@/lib/utils";

// The steps every module walks, Brief -> Plan -> Create -> Review -> Deliver
// (src/lib/modules/flow.ts), in the plan pane's stepper look (PlanStepper in
// plan-pane/pane-parts.tsx): a numbered circle per step, a check once done, the
// current one dark. The last step says the module's own verb ("Publish",
// "Launch", "Share"). Five words do not fit a phone's line, so there only the
// current step keeps its word on screen; screen readers get every word, and
// the state of each step. Presentational: a step is a button only when
// `openable` says so and `onPick` is given. `steps` (isteğe bağlı) yalnız o
// adımları, verilen sırayla çizer ve numarayı alt kümedeki sıraya göre verir
// (SEO Manager'ın başlık düzeltme kipi üç adımlıdır); verilmezse beş adım.

export const FLOW_STEPPER_COPY = {
  done: "done",
} as const;

export function flowStepperAria(module: ModuleKey): string {
  return `${MODULES[module].label} steps`;
}

const CIRCLE: Readonly<Record<FlowStepState, CSSProperties>> = {
  current: {
    background: "var(--ws-text)",
    color: "var(--ws-surface)",
    border: "1px solid var(--ws-text)",
  },
  done: {
    background: "color-mix(in oklch, var(--ws-approved) 16%, transparent)",
    color: "var(--ws-approved)",
    border: "1px solid transparent",
  },
  todo: {
    background: "transparent",
    color: "var(--ws-text-3)",
    border: "1px solid var(--ws-border)",
  },
};

const LABEL_COLOR: Readonly<Record<FlowStepState, string>> = {
  current: "var(--ws-text)",
  done: "var(--ws-text-2)",
  todo: "var(--ws-text-3)",
};

export function FlowStepper({
  module,
  current,
  complete = false,
  openable,
  onPick,
  className,
  steps,
}: {
  module: ModuleKey;
  current: FlowStep;
  // Everything delivered: every step done, none current.
  complete?: boolean;
  openable?: Partial<Record<FlowStep, boolean>>;
  onPick?: (step: FlowStep) => void;
  className?: string;
  steps?: readonly ModuleFlowStep[];
}) {
  const states = flowStatesOf(current, { complete });
  const all = flowStepsOf(module);
  // Alt küme verilmişse sırası korunur; bilinmeyen anahtar atlanır.
  const shown = steps
    ? steps.flatMap((key) => all.filter((item) => item.key === key))
    : all;
  return (
    <nav aria-label={flowStepperAria(module)} className={className}>
      <ol
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-3.5 sm:gap-x-5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        {shown.map(({ key, label }, index) => {
          const state = states[key];
          const body = (
            <>
              <span
                className="grid size-5 shrink-0 place-items-center rounded-full text-[11px] leading-none font-semibold"
                style={CIRCLE[state]}
              >
                {state === "done" ? (
                  <Check aria-hidden="true" className="size-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={cn(
                  "text-xs whitespace-nowrap",
                  state === "current"
                    ? "font-semibold"
                    : "sr-only sm:not-sr-only",
                )}
                style={{ color: LABEL_COLOR[state] }}
              >
                {label}
                {state === "done" ? (
                  <span className="sr-only">, {FLOW_STEPPER_COPY.done}</span>
                ) : null}
              </span>
            </>
          );
          return (
            <li key={key}>
              {onPick && openable?.[key] && state !== "current" ? (
                <button
                  type="button"
                  onClick={() => onPick(key)}
                  className="inline-flex min-h-8 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {body}
                </button>
              ) : (
                <span
                  aria-current={state === "current" ? "step" : undefined}
                  className="inline-flex min-h-8 items-center gap-2"
                >
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
