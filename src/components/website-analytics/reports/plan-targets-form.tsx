"use client";

import Link from "next/link";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatMetric } from "@/lib/module-flows/analytics/format";
import { reportHrefs } from "@/lib/website-analytics/reports/ids";
import type { PlanTargetProposal } from "@/lib/website-analytics/reports/types";
import { applyGaPlanTargetsAction } from "@/server/actions/website-report-actions";

// "Next month plan" kartındaki önerilen hedefler. Seçilenler "Use these
// targets" ile Goals'a yazılır; eylem değerleri istemciden değil, saklı
// karttan okur (yalnız metricKey seçimi ve commandId gider). commandId yoksa
// (örneğin bir önizleme) form çizilmez, yalnız liste kalır.

function signedPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function ProposalDetails({
  proposal,
  currency,
}: {
  proposal: PlanTargetProposal;
  currency: string | null;
}) {
  const money = (value: number) =>
    formatMetric(proposal.format, value, currency);
  return (
    <span className="block space-y-0.5">
      <span className="block text-sm font-medium">
        {proposal.label}: {money(proposal.suggested)}
      </span>
      <span className="block text-xs text-muted-foreground">
        Range {money(proposal.low)}–{money(proposal.high)}
      </span>
      <span className="block text-xs text-muted-foreground">
        Last {proposal.baselineMonths} months: baseline {money(proposal.baseline)}
        {proposal.seasonalPct !== null
          ? ` · seasonality ${signedPercent(proposal.seasonalPct)}`
          : ""}
      </span>
      {proposal.currentGoal && proposal.currentGoal.target !== null ? (
        <span className="block text-xs text-muted-foreground">
          Current target: {money(proposal.currentGoal.target)}
        </span>
      ) : null}
    </span>
  );
}

export function PlanTargetsForm({
  projectId,
  commandId,
  proposals,
  currency,
}: {
  projectId: string;
  commandId?: string;
  proposals: readonly PlanTargetProposal[];
  currency: string | null;
}) {
  if (proposals.length === 0) return null;

  if (!commandId) {
    return (
      <ul className="space-y-2">
        {proposals.map((proposal) => (
          <li key={proposal.metricKey}>
            <ProposalDetails proposal={proposal} currency={currency} />
          </li>
        ))}
      </ul>
    );
  }

  const goalsHref = reportHrefs(projectId, false).goals;
  return (
    <ActionForm
      action={applyGaPlanTargetsAction}
      successMessage="Targets saved to Goals"
      className="space-y-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="commandId" value={commandId} />
      <ul className="space-y-2.5">
        {proposals.map((proposal) => {
          const id = `plan-${commandId}-${proposal.metricKey}`;
          return (
            <li key={proposal.metricKey} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                name="metricKey"
                value={proposal.metricKey}
                defaultChecked
                className="mt-0.5"
              />
              <Label htmlFor={id} className="block cursor-pointer leading-normal">
                <ProposalDetails proposal={proposal} currency={currency} />
              </Label>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton size="sm">Use these targets</SubmitButton>
        <p className="text-xs text-muted-foreground">
          You can change targets anytime in{" "}
          <Link href={goalsHref} className="underline underline-offset-2">
            Brand Brain → Goals
          </Link>
          .
        </p>
      </div>
    </ActionForm>
  );
}
