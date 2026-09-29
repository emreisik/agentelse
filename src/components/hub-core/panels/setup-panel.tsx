import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, PartyPopper, Rocket, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { prisma } from "@/lib/prisma";
import { shortDate } from "@/lib/dates";
import { languageLabel, countryLabel } from "@/lib/locales";
import {
  PROJECT_STATUS,
  SETUP_STAGE,
  SETUP_STAGE_ORDER_UI,
} from "@/lib/labels";
import { startAgencySetupAction } from "@/server/actions/agency-setup-actions";
import { ActionForm } from "@/components/shared/action-form";
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
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { MarketsField } from "../primitives/markets-field";
import { getSetupProgressView } from "./setup-progress-view";
import { SetupStageShow } from "./setup-stage-show";
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
// must NOT be modified). The stage-list computation itself now lives in
// setup-progress-view.tsx, shared with the condensed card the project chat
// screen embeds while setup is running (see project-chat's use of it) — the
// primary way setup is now started is a conversation in chat (chat-turn.ts's
// NOT_STARTED phase), this form-based page stays as a manual fallback.
export async function SetupPanel({ projectId }: PanelProps) {
  const [project, view] = await Promise.all([
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
    getSetupProgressView(projectId),
  ]);

  if (!project) {
    return (
      <p className="py-8 text-sm text-muted-foreground">Project not found.</p>
    );
  }

  const intake = view?.intake ?? {};
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
  if (view) {
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
        value: view.createdAt,
        relative: true,
      },
    );
    if (view.activatedAt) {
      detailFields.push({
        type: "date",
        label: "Activated",
        value: view.activatedAt,
      });
    }
  }

  return (
    <div className="space-y-8 py-6">
      <section className="space-y-2">
        <SectionLabel>Project</SectionLabel>
        <FieldGrid fields={detailFields} />
        {view && intakeAssets.length > 0 ? (
          <div className="space-y-1.5 border-t border-border/60 pt-3">
            <p className="text-xs font-medium text-foreground">Assets</p>
            <AssetPreviewGrid assets={intakeAssets} />
          </div>
        ) : null}
      </section>

      {!view ? (
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
              plan. You can also just start describing your brand in the chat —
              it collects the same information conversationally.
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
          {view.activated ? (
            <Card className="ring-success/25">
              <CardContent className="flex items-center gap-4">
                <IconChip icon={PartyPopper} tone="success" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    Your agency is active! Setup was completed on{" "}
                    {shortDate(view.activatedAt)}.
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
              entries={view.stageEntries}
              percent={view.activated ? undefined : view.percent}
              autoApproveOn={view.activated ? undefined : intake.autoApprove}
            />
          </section>
        </>
      )}
    </div>
  );
}
