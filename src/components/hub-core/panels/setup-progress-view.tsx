import type { ReactNode } from "react";
import { Target } from "lucide-react";
import type { SetupStage } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  PROJECT_GOAL_STATUS,
  SETUP_STAGE,
  SETUP_STAGE_HINTS,
  SETUP_STAGE_ORDER_UI,
} from "@/lib/labels";
import { submitSetupDecisionAction } from "@/server/actions/agency-setup-actions";
import { MAX_STAGE_ATTEMPTS } from "@/server/agency/setup/project-setup-orchestrator";
import { ActionForm } from "@/components/shared/action-form";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import type { SetupStageEntry } from "./setup-stage-show";

// The 12-stage ProjectSetupState/ProjectSetupStageRecord progress view
// (stages + percent + WAITING_CLIENT decision forms), shared between
// setup-panel.tsx (the full ?panel=setup page) and the condensed card
// embedded directly in the project chat screen (see project-chat's
// SetupProgressCard) — both render the SAME live data, just around
// different surrounding chrome. Returns null when setup hasn't started yet.
export type SetupProgressView = {
  activated: boolean;
  activatedAt: Date | null;
  createdAt: Date;
  percent: number;
  intake: {
    brandName?: string;
    domain?: string;
    description?: string;
    assetIds?: string[];
    autoApprove?: boolean;
  };
  stageEntries: SetupStageEntry[];
};

export async function getSetupProgressView(
  projectId: string,
): Promise<SetupProgressView | null> {
  const setupState = await prisma.projectSetupState.findUnique({
    where: { projectId },
    include: { stageRecords: true },
  });
  if (!setupState) return null;

  const waitingStage = setupState.stageRecords.find(
    (r) => r.status === "WAITING_CLIENT",
  );
  const proposedGoals =
    waitingStage?.stage === "GOAL_GENERATION"
      ? await prisma.projectGoal.findMany({
          where: { projectId, status: "PROPOSED" },
          orderBy: { priority: "asc" },
        })
      : [];
  const pendingPlans =
    waitingStage?.stage === "INITIAL_WORK_PLAN"
      ? await prisma.workPlan.findMany({
          where: { projectId, status: { in: ["DRAFT", "AWAITING_APPROVAL"] } },
          select: { id: true, title: true },
        })
      : [];

  const total = setupState.stageRecords.length || 12;
  const done = setupState.stageRecords.filter(
    (r) => r.status === "COMPLETED" || r.status === "SKIPPED",
  ).length;
  const percent = Math.round((done / total) * 100);
  const activated = Boolean(setupState.activatedAt);
  const intake = (setupState.intake ?? {}) as SetupProgressView["intake"];

  // Lightweight counts to show "what each stage found" — the orchestrator
  // doesn't write these to stage.output (only INTAKE does), so we count the
  // tables each stage actually produces directly.
  const [
    signalCount,
    constitution,
    signalProfileCount,
    auditCount,
    goalCount,
    opportunityCount,
    ideaCount,
    workPlanCount,
  ] = await Promise.all([
    prisma.signal.count({ where: { projectId } }),
    prisma.brandConstitution.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { summary: true },
    }),
    prisma.projectSignalProfile.count({ where: { projectId } }),
    prisma.baselineAudit.count({ where: { projectId } }),
    prisma.projectGoal.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId } }),
    prisma.idea.count({ where: { projectId } }),
    prisma.workPlan.count({ where: { projectId } }),
  ]);

  function findingFor(stage: SetupStage): string | null {
    switch (stage) {
      case "DEEP_DISCOVERY":
        return signalCount > 0 ? `${signalCount} signals found` : null;
      case "BRAND_CONSTITUTION":
        return constitution
          ? (constitution.summary ?? "Brand constitution written")
          : null;
      case "SIGNAL_PROFILE":
        return signalProfileCount > 0
          ? `${signalProfileCount} signal categories set up`
          : null;
      case "BASELINE_AUDITS":
        return auditCount > 0 ? `${auditCount} departments audited` : null;
      case "GOAL_GENERATION":
        return goalCount > 0 ? `${goalCount} goals proposed` : null;
      case "INITIAL_OPPORTUNITIES":
        return opportunityCount > 0
          ? `${opportunityCount} opportunities identified`
          : null;
      case "INITIAL_IDEA_PORTFOLIO":
        return ideaCount > 0 ? `${ideaCount} ideas generated` : null;
      case "INITIAL_WORK_PLAN":
        return workPlanCount > 0 ? `${workPlanCount} work plans created` : null;
      default:
        return null;
    }
  }

  function buildDecision(stage: SetupStage): ReactNode {
    const approveButton = (
      <ActionForm
        action={submitSetupDecisionAction}
        successMessage="Approved, setup continuing"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="stage" value={stage} />
        <input type="hidden" name="approve" value="true" />
        <SubmitButton size="sm">Approve and Continue</SubmitButton>
      </ActionForm>
    );

    if (stage === "GOAL_GENERATION") {
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium">Proposed goals</p>
          <div className="space-y-2">
            {proposedGoals.map((goal) => (
              <div
                key={goal.id}
                className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2"
              >
                <Target className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{goal.title}</p>
                  {goal.metricKey ? (
                    <p className="text-xs text-muted-foreground">
                      Metric: {goal.metricKey} · Priority P{goal.priority}
                    </p>
                  ) : null}
                </div>
                <StatusBadge
                  meta={
                    PROJECT_GOAL_STATUS[
                      goal.status as keyof typeof PROJECT_GOAL_STATUS
                    ]
                  }
                />
              </div>
            ))}
          </div>
          {approveButton}
        </div>
      );
    }

    if (stage === "INITIAL_WORK_PLAN") {
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium">Prepared work plan</p>
          <div className="flex flex-wrap gap-1.5">
            {pendingPlans.map((plan) => (
              <CrossLinkChip
                key={plan.id}
                projectId={projectId}
                entity={{ kind: "workPlan", id: plan.id }}
                text={plan.title}
              />
            ))}
          </div>
          {approveButton}
        </div>
      );
    }

    return <div>{approveButton}</div>;
  }

  const stageEntries: SetupStageEntry[] = SETUP_STAGE_ORDER_UI.map(
    (stage, index) => {
      const record = setupState.stageRecords.find((r) => r.stage === stage);
      const status = record?.status ?? "PENDING";
      return {
        stage,
        index,
        status,
        label: SETUP_STAGE[stage].label,
        hint: SETUP_STAGE_HINTS[stage],
        finding: status === "COMPLETED" ? findingFor(stage) : null,
        completedAt: record?.completedAt
          ? record.completedAt.toISOString()
          : null,
        error: record?.error ?? null,
        attemptCount: record?.attemptCount ?? 0,
        attemptsExhausted: (record?.attemptCount ?? 0) >= MAX_STAGE_ATTEMPTS,
        link: status === "COMPLETED" ? stageLink(stage, projectId) : null,
        decision: status === "WAITING_CLIENT" ? buildDecision(stage) : null,
        projectId,
      };
    },
  );

  return {
    activated,
    activatedAt: setupState.activatedAt,
    createdAt: setupState.createdAt,
    percent,
    intake,
    stageEntries,
  };
}

function stageLink(
  stage: SetupStage,
  projectId: string,
): { href: string; label: string } | null {
  switch (stage) {
    case "BRAND_CONSTITUTION":
      return {
        href: buildHubHref(projectId, { panel: "brand-brain" }),
        label: "View constitution →",
      };
    case "SIGNAL_PROFILE":
      return {
        href: buildHubHref(projectId, {
          panel: "brand-brain",
          sub: "intelligence",
        }),
        label: "View intelligence →",
      };
    case "BASELINE_AUDITS":
      return {
        href: buildHubHref(projectId, { panel: "departments" }),
        label: "View audits →",
      };
    case "GOAL_GENERATION":
      return {
        href: buildHubHref(projectId, { panel: "brand-brain", sub: "goals" }),
        label: "View goals →",
      };
    case "AGENCY_CONFIGURATION":
      return {
        href: buildHubHref(projectId, { panel: "departments" }),
        label: "View departments →",
      };
    case "AUTONOMY_CONFIGURATION":
      return {
        href: buildHubHref(projectId, { panel: "settings" }),
        label: "View autonomy settings →",
      };
    case "INITIAL_OPPORTUNITIES":
      return {
        href: buildHubHref(projectId, {
          panel: "brand-brain",
          sub: "intelligence",
        }),
        label: "View opportunities →",
      };
    case "INITIAL_IDEA_PORTFOLIO":
      return {
        href: buildHubHref(projectId, { panel: "ideas" }),
        label: "View ideas →",
      };
    case "INITIAL_WORK_PLAN":
      return {
        href: buildHubHref(projectId, { panel: "work" }),
        label: "View work plan →",
      };
    case "DEEP_DISCOVERY":
      return {
        href: buildHubHref(projectId, {
          panel: "brand-brain",
          sub: "intelligence",
        }),
        label: "View findings →",
      };
    default:
      return null;
  }
}
