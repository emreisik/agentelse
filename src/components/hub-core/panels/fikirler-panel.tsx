import { Lightbulb } from "lucide-react";
import type { CreativeLens, DepartmentKey } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { timeAgo } from "@/lib/dates";
import {
  AGENCY_DECISION_TYPE,
  COUNCIL_RECOMMENDATION,
  COUNCIL_TYPE,
  CREATIVE_LENS,
  DEPARTMENT_COLOR,
  DEPARTMENT_KEY,
  IDEA_STATUS,
  councilDimensionLabel,
} from "@/lib/labels";
import {
  approveIdeaAction,
  archiveIdeaAction,
  rejectIdeaAction,
} from "@/server/actions/agency-strategy-actions";
import { IDEA_TRANSITIONS } from "@/server/state-machine/transitions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { NbaScoreChip } from "@/components/shared/nba-score-chip";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { EntityDetailSheet } from "../primitives/entity-detail-sheet";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { IdeaLensBoard, type IdeaBoardItem } from "./idea-lens-board";
import type { PanelProps } from "./panel-props";

type IdeaConcept = {
  bigIdea?: string;
  executionSketch?: string;
  departmentsInvolved?: string[];
};

function parseConcept(concept: unknown): IdeaConcept | null {
  return concept && typeof concept === "object"
    ? (concept as IdeaConcept)
    : null;
}

// Kart/liste görünümünde hızlı taramaya yetecek TEK bir departman —
// concept.departmentsInvolved birden fazla taşıyabilir, ilki kullanılır.
// Detay görünümü hepsini badge olarak listeler (bkz. IdeaDetail).
function primaryDepartment(
  concept: IdeaConcept | null,
): DepartmentKey | undefined {
  const key = concept?.departmentsInvolved?.[0];
  return key && key in DEPARTMENT_KEY ? (key as DepartmentKey) : undefined;
}

// Referans: src/app/projects/[projectId]/fikirler/page.tsx (sayfa+IdeaSheet).
// HUB CORE'da lens filtresi + kanban `IdeaLensBoard` client bileşenine
// taşındı (bkz. o dosyadaki yorum); burası yalnızca veri çeker ve
// entity=idea:ID geldiğinde tam detayı render eder.
export async function FikirlerPanel({ projectId, entity }: PanelProps) {
  const ideaId = entity && entity.kind === "idea" ? entity.id : null;
  return (
    <>
      <IdeaListView projectId={projectId} />
      {ideaId ? (
        <EntityDetailSheet
          title="Fikir detayı"
          closeHref={buildHubHref(projectId, {
            panel: "fikirler",
            entity: null,
          })}
        >
          <IdeaDetail projectId={projectId} ideaId={ideaId} />
        </EntityDetailSheet>
      ) : null}
    </>
  );
}

async function IdeaListView({ projectId }: { projectId: string }) {
  const ideas = await prisma.idea.findMany({
    where: { projectId },
    orderBy: [{ nbaScore: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true,
      title: true,
      lens: true,
      status: true,
      nbaScore: true,
      isMock: true,
      concept: true,
      councilEvaluations: {
        select: { id: true, councilType: true, recommendation: true },
      },
    },
  });

  if (ideas.length === 0) {
    return (
      <div className="py-6">
        <EmptyState
          icon={Lightbulb}
          title="Fikir yok"
          hint="Fikir atölyesi fırsatları 16 kreatif mercekten geçirerek fikir üretir; kurulumun 10. aşamasında ilk portföy oluşur."
        />
      </div>
    );
  }

  const lensCounts = await prisma.idea.groupBy({
    by: ["lens"],
    where: { projectId },
    _count: { id: true },
  });
  const usedLenses = lensCounts
    .filter((l) => l.lens !== null)
    .map((l) => ({ lens: l.lens as CreativeLens, count: l._count.id }));

  const boardItems: IdeaBoardItem[] = ideas.map((idea) => ({
    id: idea.id,
    title: idea.title,
    lens: idea.lens,
    status: idea.status,
    nbaScore: idea.nbaScore,
    isMock: idea.isMock,
    department: primaryDepartment(parseConcept(idea.concept)),
    councilDots: idea.councilEvaluations,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col pb-6">
      <IdeaLensBoard
        projectId={projectId}
        ideas={boardItems}
        usedLenses={usedLenses}
      />
    </div>
  );
}

async function IdeaDetail({
  projectId,
  ideaId,
}: {
  projectId: string;
  ideaId: string;
}) {
  const idea = await prisma.idea.findFirst({
    where: { id: ideaId, projectId },
    include: {
      opportunity: { select: { id: true, title: true } },
      councilEvaluations: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!idea) {
    return (
      <div className="space-y-4 py-6">
        <EmptyState icon={Lightbulb} title="Fikir bulunamadı" />
      </div>
    );
  }

  const decision = await prisma.agencyDecision.findFirst({
    where: { projectId, subjectType: "IDEA", subjectId: idea.id },
    orderBy: { createdAt: "desc" },
  });

  const concept = parseConcept(idea.concept);
  const conceptDepartment = primaryDepartment(concept);

  const lensMeta = idea.lens ? CREATIVE_LENS[idea.lens] : null;
  const allowedIdeaTransitions = IDEA_TRANSITIONS[idea.status];
  const canApprove = allowedIdeaTransitions.includes("APPROVED");
  const canReject = allowedIdeaTransitions.includes("REJECTED");
  const canArchive = allowedIdeaTransitions.includes("ARCHIVED");

  const fields: FieldSpec[] = [
    { type: "badge", label: "Durum", meta: IDEA_STATUS[idea.status] },
    {
      type: "badge",
      label: "Mercek",
      meta: lensMeta ?? undefined,
      fallback: idea.lens ?? undefined,
    },
    {
      type: "text",
      label: "NBA Skoru",
      value: idea.nbaScore !== null ? idea.nbaScore.toFixed(2) : null,
    },
    { type: "boolean", label: "Demo (isMock)", value: idea.isMock },
    {
      type: "date",
      label: "Oluşturulma",
      value: idea.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: idea.updatedAt,
      relative: true,
    },
  ];

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="font-heading text-xl font-semibold text-foreground">
          {idea.title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{idea.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge meta={IDEA_STATUS[idea.status]} />
        {lensMeta ? <StatusBadge meta={lensMeta} showIcon /> : null}
        <NbaScoreChip value={idea.nbaScore} />
        {idea.isMock ? (
          <StatusBadge meta={{ label: "Demo", tone: "special" }} />
        ) : null}
      </div>

      {idea.opportunity ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "opportunity", id: idea.opportunity.id }}
          text={`Kaynak fırsat: ${idea.opportunity.title}`}
        />
      ) : null}

      {concept ? (
        <div
          className="space-y-3 rounded-lg border-l-[3px] border-l-transparent bg-secondary/50 p-3"
          style={
            conceptDepartment
              ? { borderLeftColor: DEPARTMENT_COLOR[conceptDepartment] }
              : undefined
          }
        >
          {concept.bigIdea ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Büyük Fikir
              </p>
              <p className="mt-0.5 text-sm">{concept.bigIdea}</p>
            </div>
          ) : null}
          {concept.executionSketch ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Uygulama Taslağı
              </p>
              <p className="mt-0.5 text-sm">{concept.executionSketch}</p>
            </div>
          ) : null}
          {concept.departmentsInvolved?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {concept.departmentsInvolved.map((dept) => (
                <StatusBadge
                  key={dept}
                  meta={DEPARTMENT_KEY[dept as DepartmentKey]}
                  accentColor={DEPARTMENT_COLOR[dept as DepartmentKey]}
                  fallback={dept}
                  className="h-4 px-1.5 text-[10px]"
                  showIcon
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <FieldGrid fields={fields} />

      {idea.councilEvaluations.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            Konsey değerlendirmeleri
          </p>
          {idea.councilEvaluations.map((evaluation) => {
            const scores =
              evaluation.scores && typeof evaluation.scores === "object"
                ? (evaluation.scores as Record<string, unknown>)
                : {};
            return (
              <Card key={evaluation.id} size="sm">
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge meta={COUNCIL_TYPE[evaluation.councilType]} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold tabular-nums">
                        {evaluation.overallScore.toFixed(1)}/10
                      </span>
                      <StatusBadge
                        meta={COUNCIL_RECOMMENDATION[evaluation.recommendation]}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {Object.entries(scores).map(([key, val]) =>
                      typeof val === "number" ? (
                        <ScoreBar
                          key={key}
                          value={val}
                          max={10}
                          label={councilDimensionLabel(key)}
                        />
                      ) : null,
                    )}
                  </div>
                  {evaluation.rationale ? (
                    <p className="text-xs text-muted-foreground">
                      {evaluation.rationale}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 font-mono text-[10px] text-muted-foreground">
                    <span>
                      {evaluation.isMock ? "Demo veri" : "Gerçek veri"}
                    </span>
                    <span>{timeAgo(evaluation.createdAt)}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}

      {decision ? (
        <div className="space-y-1.5 rounded-lg bg-accent/40 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Ajans kararı</span>
            <StatusBadge meta={AGENCY_DECISION_TYPE[decision.decision]} />
          </div>
          <p className="text-xs text-muted-foreground">{decision.rationale}</p>
        </div>
      ) : null}

      {idea.workPlanId ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "workPlan", id: idea.workPlanId }}
          text="İş planına git"
          sub="planlar"
        />
      ) : null}

      <div className="flex items-center justify-end gap-1.5 border-t border-border pt-3">
        {canArchive ? (
          <ActionForm
            action={archiveIdeaAction}
            successMessage="Fikir arşivlendi"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="ideaId" value={idea.id} />
            <SubmitButton variant="ghost" size="xs">
              Arşivle
            </SubmitButton>
          </ActionForm>
        ) : null}
        {canReject ? (
          <ActionForm
            action={rejectIdeaAction}
            successMessage="Fikir reddedildi"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="ideaId" value={idea.id} />
            <SubmitButton variant="outline" size="xs">
              Reddet
            </SubmitButton>
          </ActionForm>
        ) : null}
        {canApprove ? (
          <ActionForm
            action={approveIdeaAction}
            successMessage="Fikir onaylandı"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="ideaId" value={idea.id} />
            <SubmitButton size="xs">Onayla</SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
