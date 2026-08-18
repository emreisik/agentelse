import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Loader2,
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
import { ActionForm } from "@/components/shared/action-form";
import { LiveRefresh } from "@/components/shared/live-refresh";
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
import { Progress } from "@/components/ui/progress";
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

// "Kurulum" düğümü hiçbir `EntityKind`'in sahibi değil (ENTITY_PANEL'de
// hedef yok) — bu yüzden `entity` burada hiç kullanılmıyor.
// 12 aşamalı ProjectSetupState/ProjectSetupStageRecord makinesinin tamamı +
// WAITING_CLIENT karar formları (kurulum/page.tsx'in HUB CORE'a taşınmış
// hali, DEĞİŞTİRME yasak olan orchestrator/action'ları sadece çağırır).
export async function KurulumPanel({ projectId }: PanelProps) {
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
      <p className="py-8 text-sm text-muted-foreground">Proje bulunamadı.</p>
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

  // countries her zaman en az [country] içerir (bkz. ProjectRepository.create
  // ve project_countries_array migration'ındaki backfill) — birincil pazar
  // ("country") en başta, diğer seçili pazarlar onu takip eder.
  const markets = project.countries.length
    ? project.countries
    : [project.country];
  const projectFields: FieldSpec[] = [
    { type: "text", label: "Ad", value: project.name },
    { type: "text", label: "Slug", value: project.slug },
    { type: "text", label: "Domain", value: project.domain },
    { type: "badge", label: "Durum", meta: PROJECT_STATUS[project.status] },
    { type: "text", label: "Dil", value: languageLabel(project.language) },
    {
      type: "node",
      label: markets.length > 1 ? "Pazarlar" : "Pazar",
      node: <MarketsField labels={markets.map((code) => countryLabel(code))} />,
    },
  ];

  // Her aşamanın "ne bulduğunu" göstermek için hafif sayımlar — orchestrator
  // stage.output'a bunları yazmıyor (sadece INTAKE yazıyor), o yüzden
  // aşamanın gerçek ürettiği tabloları doğrudan sayıyoruz. Sadece kurulum
  // başladıysa çalışır.
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
        return signalCount > 0 ? `${signalCount} sinyal bulundu` : null;
      case "BRAND_CONSTITUTION":
        return constitution
          ? (constitution.summary ?? "Marka anayasası yazıldı")
          : null;
      case "SIGNAL_PROFILE":
        return signalProfileCount > 0
          ? `${signalProfileCount} sinyal kategorisi kuruldu`
          : null;
      case "BASELINE_AUDITS":
        return auditCount > 0 ? `${auditCount} departman denetlendi` : null;
      case "GOAL_GENERATION":
        return goalCount > 0 ? `${goalCount} hedef önerildi` : null;
      case "INITIAL_OPPORTUNITIES":
        return opportunityCount > 0
          ? `${opportunityCount} fırsat belirlendi`
          : null;
      case "INITIAL_IDEA_PORTFOLIO":
        return ideaCount > 0 ? `${ideaCount} fikir üretildi` : null;
      case "INITIAL_WORK_PLAN":
        return workPlanCount > 0
          ? `${workPlanCount} iş planı oluşturuldu`
          : null;
      default:
        return null;
    }
  }

  function buildDecision(stage: SetupStage): ReactNode {
    const approveButton = (
      <ActionForm
        action={submitSetupDecisionAction}
        successMessage="Onaylandı, kurulum devam ediyor"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="stage" value={stage} />
        <input type="hidden" name="approve" value="true" />
        <SubmitButton size="sm">Onayla ve Devam Et</SubmitButton>
      </ActionForm>
    );

    if (stage === "GOAL_GENERATION") {
      return (
        <div className="space-y-3">
          <p className="text-sm font-medium">Önerilen hedefler</p>
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
                      Metrik: {goal.metricKey} · Öncelik P{goal.priority}
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
          <p className="text-sm font-medium">Hazırlanan iş planları</p>
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
        link: status === "COMPLETED" ? stageLink(stage, projectId) : null,
        decision: status === "WAITING_CLIENT" ? buildDecision(stage) : null,
      };
    },
  );

  return (
    <div className="space-y-8 py-6">
      <section className="space-y-2">
        <SectionLabel>Proje</SectionLabel>
        <Card size="sm">
          <CardContent>
            <FieldGrid fields={projectFields} />
          </CardContent>
        </Card>
      </section>

      {!setupState ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3 text-base">
              <IconChip icon={Rocket} />
              Ajans Kurulumunu Başlat
            </CardTitle>
            <CardDescription>
              Sadece marka adı, domain ve kısa bir açıklama yeterli. Ajansınız
              markayı derinlemesine araştırır, anayasasını yazar, sinyal
              profilini kurar, hedefler önerir ve ilk iş planını üretir.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ActionForm
              action={startAgencySetupAction}
              successMessage="Kurulum başlatıldı"
              className="space-y-4"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <div className="space-y-1.5">
                <Label htmlFor="brandName">Marka Adı</Label>
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
                  placeholder="ornek.com"
                  defaultValue={project.domain ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Açıklama</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={3}
                  placeholder="Ne istediğinizi serbestçe anlatın: büyüme, marka bilinirliği, sosyal, SEO..."
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
                    Kararları otomatik onayla
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Hedefler ve ilk iş planı insan onayı beklemeden ilerler.
                  </span>
                </span>
              </label>
              <SubmitButton size="lg">
                Kurulumu Başlat
                <ArrowRight className="size-4" />
              </SubmitButton>
            </ActionForm>
            <div className="border-t border-border/60 pt-5">
              <p className="mb-2.5 text-xs font-medium text-muted-foreground">
                12 aşamalı süreç
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
                    Ajansınız aktif! Kurulum {shortDate(setupState.activatedAt)}{" "}
                    tarihinde tamamlandı.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Sürekli döngü çalışıyor: sinyaller toplanıyor, fırsatlar
                    değerlendiriliyor, işler üretiliyor.
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
                  Sohbete Dön
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex items-center gap-4">
                <IconChip icon={Loader2} iconClassName="animate-spin" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {SETUP_STAGE[setupState.currentStage].label}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {SETUP_STAGE_HINTS[setupState.currentStage]}
                      </p>
                    </div>
                    <span className="shrink-0 font-heading text-lg font-semibold tabular-nums">
                      %{percent}
                    </span>
                  </div>
                  <Progress value={percent} />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {done}/{total} aşama tamam ·{" "}
                      {intake.autoApprove
                        ? "Otomatik onay açık"
                        : "Kararlar sizin onayınızı bekleyecek"}
                    </p>
                    <LiveRefresh intervalMs={4000} />
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <section className="space-y-2">
            <SectionLabel>Alım Bilgileri</SectionLabel>
            <Card size="sm">
              <CardContent className="space-y-3">
                <FieldGrid
                  fields={[
                    {
                      type: "text",
                      label: "Marka Adı",
                      value: intake.brandName,
                    },
                    { type: "text", label: "Domain", value: intake.domain },
                    {
                      type: "text",
                      label: "Açıklama",
                      value: intake.description,
                    },
                    {
                      type: "boolean",
                      label: "Otomatik Onay",
                      value: intake.autoApprove,
                    },
                    {
                      type: "date",
                      label: "Oluşturuldu",
                      value: setupState.createdAt,
                      relative: true,
                    },
                    {
                      type: "date",
                      label: "Aktifleşti",
                      value: setupState.activatedAt,
                    },
                  ]}
                />
                {intakeAssets.length > 0 ? (
                  <div className="space-y-1.5 border-t border-border/60 pt-3">
                    <p className="text-xs font-medium text-foreground">
                      Varlıklar
                    </p>
                    <AssetPreviewGrid assets={intakeAssets} />
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </section>

          <section className="space-y-2">
            <SectionLabel>Aşamalar</SectionLabel>
            <SetupStageShow entries={stageEntries} />
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
        href: buildHubHref(projectId, { panel: "marka-beyni" }),
        label: "Anayasayı gör →",
      };
    case "SIGNAL_PROFILE":
      return {
        href: buildHubHref(projectId, { panel: "sinyaller" }),
        label: "Sinyal profilini gör →",
      };
    case "BASELINE_AUDITS":
      return {
        href: buildHubHref(projectId, { panel: "departmanlar" }),
        label: "Denetimleri gör →",
      };
    case "GOAL_GENERATION":
      return {
        href: buildHubHref(projectId, { panel: "hedefler" }),
        label: "Hedefleri gör →",
      };
    case "AGENCY_CONFIGURATION":
      return {
        href: buildHubHref(projectId, { panel: "departmanlar" }),
        label: "Departmanları gör →",
      };
    case "AUTONOMY_CONFIGURATION":
      return {
        href: buildHubHref(projectId, { panel: "ayarlar" }),
        label: "Otonomi ayarlarını gör →",
      };
    case "INITIAL_OPPORTUNITIES":
      return {
        href: buildHubHref(projectId, { panel: "icgoru-firsat" }),
        label: "Fırsatları gör →",
      };
    case "INITIAL_IDEA_PORTFOLIO":
      return {
        href: buildHubHref(projectId, { panel: "fikirler" }),
        label: "Fikirleri gör →",
      };
    case "INITIAL_WORK_PLAN":
      return {
        href: buildHubHref(projectId, { panel: "isler" }),
        label: "İş planlarını gör →",
      };
    case "DEEP_DISCOVERY":
      return {
        href: buildHubHref(projectId, { panel: "sinyaller" }),
        label: "Bulguları gör →",
      };
    default:
      return null;
  }
}
