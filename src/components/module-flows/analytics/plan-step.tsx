"use client";

import { useId, useState } from "react";

import { Switch } from "@/components/ui/switch";
import {
  INSTAGRAM_WINDOW_DAYS,
  SOURCE_LABEL,
  type AnalyticsSource,
} from "@/lib/module-flows/analytics/catalog";
import {
  ANALYTICS_COPY as COPY,
  SECTION_DESCRIPTION,
} from "@/lib/module-flows/analytics/copy";
import type { AnalyticsFlowState } from "@/lib/module-flows/analytics/state";

import {
  GroupHeading,
  PrimaryButton,
  QuietButton,
  SourceMark,
  StepActions,
} from "./parts";

// Step 2, Plan: the report's sections, one per source of the brief, each a
// switch with one line on what it will show. "Build report" reads them.

export function PlanStep({
  flow,
  waiting,
  blockedReason,
  error,
  onBack,
  onBuild,
}: {
  flow: AnalyticsFlowState;
  // An action of the card runs (Build itself opens the Create step at once).
  waiting: boolean;
  blockedReason: string | null;
  error: string | null;
  onBack: () => void;
  onBuild: (sections: AnalyticsSource[]) => void;
}) {
  const headingId = useId();
  const reasonId = useId();
  const [on, setOn] = useState<AnalyticsSource[]>(flow.sections);
  const chosen = flow.sources.filter((source) => on.includes(source));
  const reason = chosen.length === 0 ? COPY.reasonKeepOne : blockedReason;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <GroupHeading id={headingId}>{COPY.sectionsHeading}</GroupHeading>
        <ul aria-labelledby={headingId} className="space-y-1.5">
          {flow.sources.map((source) => {
            const checked = chosen.includes(source);
            const name = SOURCE_LABEL[source];
            const capped =
              source === "instagram" && flow.period > INSTAGRAM_WINDOW_DAYS;
            return (
              <li
                key={source}
                className="flex items-start gap-2.5 rounded-xl border px-3 py-2.5"
                style={{
                  borderColor: "var(--ws-border)",
                  opacity: checked ? 1 : 0.7,
                }}
              >
                <SourceMark source={source} className="mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-sm font-medium"
                    style={{ color: "var(--ws-text)" }}
                  >
                    {name}
                  </span>
                  <span
                    className="block text-xs leading-5"
                    style={{ color: "var(--ws-text-2)" }}
                  >
                    {SECTION_DESCRIPTION[source]}
                    {capped
                      ? ` ${COPY.instagramWindow(INSTAGRAM_WINDOW_DAYS)}`
                      : ""}
                  </span>
                </span>
                <Switch
                  className="mt-1.5"
                  checked={checked}
                  aria-label={COPY.sectionAria(name)}
                  onCheckedChange={(next) =>
                    setOn(
                      next
                        ? [...chosen, source]
                        : chosen.filter((item) => item !== source),
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
        <p className="text-xs" style={{ color: "var(--ws-text-2)" }}>
          {COPY.summaryLine}
        </p>
      </div>

      <StepActions
        reason={reason}
        reasonId={reasonId}
        error={error}
        quiet={
          <QuietButton
            label={COPY.back}
            blockedReason={blockedReason}
            waiting={waiting}
            onClick={onBack}
          />
        }
        primary={
          <PrimaryButton
            label={COPY.build}
            waiting={waiting}
            blockedReason={reason}
            reasonId={reasonId}
            onClick={() => onBuild(chosen)}
          />
        }
      />
    </div>
  );
}
