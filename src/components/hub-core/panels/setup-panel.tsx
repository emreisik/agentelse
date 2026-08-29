import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  PartyPopper,
  Rocket,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { SetupStage } from "@prisma/client";

import { cn } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { shortDate } from "@/lib/dates";
import { languageLabel, countryLabel } from "@/lib/locales";
import {
  PROJECT_GOAL_STATUS,
  PROJECT_STATUS,
  SETUP_STAGE,
  SETUP_STAGE_HINTS,
  SETUP_STAGE_ORDER_UI,
} from "@/lib/labels";
import {
  startAgencySetupAction,
  submitSetupDecisionAction,
} from "@/server/actions/agency-setup-actions";
import { MAX_STAGE_ATTEMPTS } from "@/server/agency/setup/project-setup-orchestrator";
import { ActionForm } from "@/components/shared/action-form";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { buildHubHref } from "../hub-core-params";
import { AssetPreviewGrid } from "../primitives/asset-preview";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { MarketsField } from "../primitives/markets-field";
import { SetupStageShow, type SetupStageEntry } from "./setup-stage-show";
import type { PanelProps } from "./panel-props";

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-sm font-medium text-foreground">{children}</p>;
}

function IconChip({
  icon: Icon,
  tone = "primary",
  iconClassName,
}: {
  icon: LucideIcon;
  tone?: "primary" | "success" | "muted";
  iconClassName?: string;
}) {
  const toneClass = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success/15 text-success",
    muted: "bg-muted text-foreground",
  }[tone];
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl",
        toneClass,
      )}
    >
      <Icon className={cn("size-5", iconClassName)} />
    </span>
  );
}

// The "Setup" node doesn't own any `EntityKind` (no target in ENTITY_PANEL)
// — so `entity` is never used here.
// This covers the full 12-stage ProjectSetupState/ProjectSetupStageRecord
// state machine + WAITING_CLIENT decision forms (the HUB CORE-migrated
// version of setup/page.tsx; it only calls the orchestrator/actions, which
// must NOT be modified).
export async function SetupPanel({ projectId }: PanelProps) {
  const [project, setupState] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        domain: true,
        status: true,
        slug: true,
        language: true,
        country: true,
        countries: true,
      },
    }),
    prisma.projectSetupState.findUnique({
      where: { projectId },
      include: { stageRecords: true },
    }),
  ]);

  if (!project) {
    return (
      <p className="py-8 text-sm text-muted-foreground">Project not found.</p>
    );
  }

  const waitingStage = setupState?.stageRecords.find(
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

  const total = setupState?.stageRecords.length ?? 12;
  const done =
    setupState?.stageRecords.filter(
      (r) => r.status === "COMPLETED" || r.status === "SKIPPED",
    ).length ?? 0;
  const percent = Math.round((done / total) * 100);
  const activated = Boolean(setupState?.activatedAt);
  const intake = (setupState?.intake ?? {}) as {
    brandName?: string;
    domain?: string;
    description?: string;
    assetIds?: string[];
    autoApprove?: boolean;
  };

  const intakeAssets = intake.assetIds?.length
    ? await prisma.asset.findMany({
        where: { id: { in: intake.assetIds }, projectId },
        select: { id: true, filename: true, mimeType: true, size: true },
      })
    : [];

  // countries always contains at least [country] (see ProjectRepository.create
  // and the backfill in the project_countries_array migration) — the primary
  // market ("country") comes first, followed by any other selected markets.
  const markets = project.countries.length
    ? project.countries
    : [project.country];
  const detailFields: FieldSpec[] = [
    { type: "text", label: "Name", value: project.name },
    { type: "text", label: "Slug", value: project.slug },
    { type: "text", label: "Domain", value: project.domain },
    { type: "badge", label: "Status", meta: PROJECT_STATUS[project.status] },
    { type: "text", label: "Language", value: languageLabel(project.language) },
    {
      type: "node",
      label: markets.length > 1 ? "Markets" : "Market",
      node: <MarketsField labels={markets.map((code) => countryLabel(code))} />,
    },
  ];

  // Once setup has started, fold the intake snapshot into the same list
  // instead of a second near-duplicate block — only surface brand/domain
  // again if the user actually changed them from the project's own values.
  if (setupState) {
    if (intake.brandName && intake.brandName !== project.name) {
      detailFields.push({
        type: "text",
        label: "Requested Brand Name",
        value: intake.brandName,
      });
    }
    if (intake.domain && intake.domain !== project.domain) {
      detailFields.push({
        type: "text",
        label: "Requested Domain",
        value: intake.domain,
      });
    }
    detailFields.push(
      { type: "text", label: "Description", value: intake.description },
      { type: "boolean", label: "Auto-Approve", value: intake.autoApprove },
      {
        type: "date",
        label: "Setup Started",
        value: setupState.createdAt,
        relative: true,
      },
    );
    if (setupState.activatedAt) {
      detailFields.push({
        type: "date",
        label: "Activated",
        value: setupState.activatedAt,
      });
    }
  }

  // Lightweight counts to show "what each stage found" — the orchestrator
  // doesn't write these to stage.output (only INTAKE does), so we count the
  // tables each stage actually produces directly. Only runs once setup has
  // started.
  const [
    signalCount,
    constitution,
    signalProfileCount,
    auditCount,
    goalCount,
    opportunityCount,
    ideaCount,
    workPlanCount,
  ] = setupState
    ? await Promise.all([
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
      ])
    : ([0, null, 0, 0, 0, 0, 0, 0] as const);

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
      const record = setupState?.stageRecords.find((r) => r.stage === stage);
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

  return (
    <div className="space-y-8 py-6">
      <section className="space-y-2">
        <SectionLabel>Project</SectionLabel>
        <FieldGrid fields={detailFields} />
        {setupState && intakeAssets.length > 0 ? (
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <p className="text-xs font-medium text-foreground">Assets</p>
            <AssetPreviewGrid assets={intakeAssets} />
          </div>
        ) : null}
      </section>

      {!setupState ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-base">
              <IconChip icon={Rocket} />
              Start Agency Setup
            </CardTitle>
            <CardDescription>
              Just a brand name, domain, and a short description is enough. Your
              agency will research the brand in depth, write its constitution,
              set up a signal profile, propose goals, and produce the first work
              plan.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ActionForm
              action={startAgencySetupAction}
              successMessage="Setup started"
              className="space-y-4"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <div className="space-y-1.5">
                <Label htmlFor="brandName">Brand Name</Label>
                <Input
                  id="brandName"
                  name="brandName"
                  required
                  defaultValue={project.name}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="domain">Domain</Label>
                <Input
                  id="domain"
                  name="domain"
                  placeholder="example.com"
                  defaultValue={project.domain ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={3}
                  placeholder="Describe what you want in your own words: growth, brand awareness, social, SEO..."
                />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-muted/30 p-3 text-sm transition-colors hover:bg-muted/50">
                <input
                  type="checkbox"
                  name="autoApprove"
                  value="true"
                  className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
                />
                <span>
                  <span className="block font-medium">
                    Auto-approve decisions
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Goals and the initial work plan proceed without waiting for
                    human approval.
                  </span>
                </span>
              </label>
              <SubmitButton size="lg">
                Start Setup
                <ArrowRight className="size-4" />
              </SubmitButton>
            </ActionForm>
            <div className="border-t border-border/60 pt-5">
              <p className="mb-2.5 text-xs font-medium text-muted-foreground">
                12-stage process
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SETUP_STAGE_ORDER_UI.map((stage, i) => (
                  <span
                    key={stage}
                    className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground"
                  >
                    {i + 1}. {SETUP_STAGE[stage].label}
                  </span>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {activated ? (
            <Card className="ring-success/25">
              <CardContent className="flex items-center gap-4">
                <IconChip icon={PartyPopper} tone="success" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    Your agency is active! Setup was completed on{" "}
                    {shortDate(setupState.activatedAt)}.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The continuous loop is running: signals are being collected,
                    opportunities are being evaluated, work is being produced.
                  </p>
                </div>
                <Button
                  render={
                    <Link
                      href={buildHubHref(projectId, { panel: null })}
                      scroll={false}
                    />
                  }
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  Back to Chat
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <section className="space-y-2">
            <SectionLabel>Stages</SectionLabel>
            <SetupStageShow
              entries={stageEntries}
              percent={activated ? undefined : percent}
              autoApproveOn={activated ? undefined : intake.autoApprove}
            />
          </section>
        </>
      )}
    </div>
  );
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
        href: buildHubHref(projectId, { panel: "signals" }),
        label: "View signal profile →",
      };
    case "BASELINE_AUDITS":
      return {
        href: buildHubHref(projectId, { panel: "departments" }),
        label: "View audits →",
      };
    case "GOAL_GENERATION":
      return {
        href: buildHubHref(projectId, { panel: "goals" }),
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
        href: buildHubHref(projectId, { panel: "insights-opportunities" }),
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
        href: buildHubHref(projectId, { panel: "signals" }),
        label: "View findings →",
      };
    default:
      return null;
  }
}
