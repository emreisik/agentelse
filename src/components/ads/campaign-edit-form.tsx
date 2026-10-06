"use client";

import { toMajorUnits } from "@/lib/ads/money";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { updateMetaCampaignAction } from "@/server/actions/meta-ads-actions";
import type { MetaCampaignSummary } from "@/server/integrations/meta-client";

// Budget + status only — Meta doesn't allow changing a campaign's
// objective or name after creation. Same ActionForm+SubmitButton pattern
// as the existing single-screen forms (see CreateAdDialog in ads/page.tsx):
// no close-on-success, the user closes the sheet themselves once the toast
// confirms the edit was submitted for approval.
export function CampaignEditForm({
  projectId,
  campaign,
  currency,
}: {
  projectId: string;
  campaign: MetaCampaignSummary;
  currency?: string;
}) {
  // ABO: bütçe ad set'lerde; kampanyaya daily_budget yazmak yapıyı bozar,
  // bu yüzden alan yalnız kampanya bütçeli (CBO) iken görünür
  // (docs/meta-ads-plan.md F0b).
  const hasCampaignBudget = campaign.dailyBudgetCents !== undefined;
  return (
    <ActionForm
      action={updateMetaCampaignAction}
      successMessage="Campaign update submitted for approval"
      className="space-y-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="campaignId" value={campaign.campaignId} />
      {hasCampaignBudget ? (
        <Field label={currency ? `Daily budget (${currency})` : "Daily budget"}>
          <Input
            name="dailyBudget"
            type="number"
            min="1"
            step="0.01"
            required
            defaultValue={String(
              toMajorUnits(campaign.dailyBudgetCents ?? 0, currency),
            )}
          />
        </Field>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          This campaign&apos;s budget is set on its ad sets.
        </p>
      )}
      <Field label="Status">
        <select
          name="status"
          required
          defaultValue={
            campaign.status === "ACTIVE" || campaign.status === "PAUSED"
              ? campaign.status
              : "PAUSED"
          }
          className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-xs"
        >
          <option value="ACTIVE">ACTIVE</option>
          <option value="PAUSED">PAUSED</option>
        </select>
      </Field>
      <div className="flex justify-end pt-1">
        <SubmitButton size="sm">Save changes</SubmitButton>
      </div>
    </ActionForm>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
