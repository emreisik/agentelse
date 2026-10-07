"use client";

import { useId, useState } from "react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Switch } from "@/components/ui/switch";
import { PLAN_MAX_CAP, PLAN_MIN_CAP } from "@/lib/seo/content-plan/cap";
import { PLAN_COPY } from "@/lib/seo/content-plan/copy";
import { savePlanSettingsAction } from "@/server/actions/seo-content-plan-actions";

// Aylık sınır (1..12) ve "her ay kendiliğinden plan" anahtarı (SC-F7). Ayar
// bölümün içinde durur: settings-panel ortak dosya olduğu için burada.

const CAPS = Array.from(
  { length: PLAN_MAX_CAP - PLAN_MIN_CAP + 1 },
  (_, index) => PLAN_MIN_CAP + index,
);

export function PlanSettingsForm({
  projectId,
  monthlyCap,
  autoPlan,
}: {
  projectId: string;
  monthlyCap: number;
  autoPlan: boolean;
}) {
  const capId = useId();
  const autoId = useId();
  const [auto, setAuto] = useState(autoPlan);
  return (
    <ActionForm
      action={savePlanSettingsAction}
      successMessage="Saved"
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="autoPlan" value={auto ? "true" : "false"} />
      <div className="flex items-center gap-2">
        <label htmlFor={capId} className="text-xs text-muted-foreground">
          {PLAN_COPY.limitLabel}
        </label>
        <select
          id={capId}
          name="monthlyCap"
          defaultValue={String(monthlyCap)}
          className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
        >
          {CAPS.map((cap) => (
            <option key={cap} value={cap}>
              {cap}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={autoId}
          size="sm"
          checked={auto}
          onCheckedChange={setAuto}
          aria-label={PLAN_COPY.autoLabel}
        />
        <label htmlFor={autoId} className="text-xs text-muted-foreground">
          {PLAN_COPY.autoLabel}
        </label>
      </div>
      <SubmitButton size="xs" variant="outline">
        Save
      </SubmitButton>
    </ActionForm>
  );
}
