import Link from "next/link";
import {
  ArrowLeft,
  Compass,
  Hourglass,
  Lightbulb,
  XCircle,
} from "lucide-react";
import type {
  IdeaStatus,
  Opportunity,
  OpportunityStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { shortDate, timeAgo } from "@/lib/dates";
import {
  AGENCY_DECISION_TYPE,
  APPROVAL_LEVEL,
  COUNCIL_RECOMMENDATION,
  COUNCIL_TYPE,
  IDEA_STATUS,
  INSIGHT_STATUS,
  OPPORTUNITY_STATUS,
  SIGNAL_CATEGORY,
  councilDimensionLabel,
  stripCapabilityPrefix,
} from "@/lib/labels";
import { dismissOpportunityAction } from "@/server/actions/agency-strategy-actions";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { NbaScoreChip } from "@/components/shared/nba-score-chip";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { buildHubHref, entityHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import type { PanelProps } from "./panel-props";

const OPPORTUNITY_GROUPS: Array<{
  label: string;
  statuses: OpportunityStatus[];
}> = [
  {
    label: "Açık fırsatlar",
    statuses: ["NEW", "REVIEWING", "EVALUATED", "ACCEPTED"],
  },
  {
    label: "Diğer",
    statuses: [
      "DISMISSED",
      "CONVERTED_TO_TASK",
      "CONVERTED_TO_IDEA",
      "EXPIRED",
      "DUPLICATE",
    ],
  },
];

// İçgörü & Fırsat paneli — İçgörü'den Fırsat'a tek yönlü türetim
// (Opportunity.insightId) burada aynı panelde iki bölüm olarak yaşıyor.
// `entity` bu panelin sahip olduğu bir kaydı (insight/opportunity) işaret
// ediyorsa, ilgili bölüm listenin yerine o kaydın tam detayını gösterir.
export async function IcgoruFirsatPanel({ projectId, entity }: PanelProps) {
  const [insightCount, opportunityCount] = await Promise.all([
    prisma.insight.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId } }),
  ]);

  return (
    <div className="space-y-8 py-6">
      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">
          İçgörüler{" "}
          <span className="text-muted-foreground">({insightCount})</span>
        </p>
        {entity?.kind === "insight" ? (
          <InsightDetail projectId={projectId} insightId={entity.id} />
        ) : (
          <InsightsSection projectId={projectId} />
        )}
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">
          Fırsatlar{" "}
          <span className="text-muted-foreground">({opportunityCount})</span>
        </p>
        {entity?.kind === "opportunity" ? (
          <OpportunityDetail projectId={projectId} opportunityId={entity.id} />
        ) : (
          <OpportunitiesSection projectId={projectId} />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function BackToList({ projectId }: { projectId: string }) {
  return (
    <Link
      href={buildHubHref(projectId, {
        panel: "icgoru-firsat",
        sub: null,
        entity: null,
      })}
      className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
    >
      <ArrowLeft className="size-3" />
      Listeye dön
    </Link>
  );
}

// ---------------------------------------------------------------------------

async function InsightsSection({ projectId }: { projectId: string }) {
  const insights = await prisma.insight.findMany({
    where: { projectId },
    orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
    take: 100,
    include: {
      opportunities: { select: { id: true, title: true, status: true } },
    },
  });

  if (insights.length === 0) {
    return (
      <EmptyState
        icon={Lightbulb}
        title="İçgörü yok"
        hint="Zeka motoru bulgular ve sinyaller biriktikçe içgörüler üretir."
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {insights.map((insight) => (
        <Card
          key={insight.id}
          size="sm"
          className="transition-colors hover:bg-muted/40"
        >
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <Link
                href={entityHref(projectId, {
                  kind: "insight",
                  id: insight.id,
                })}
                className="text-sm leading-snug font-medium underline-offset-2 hover:underline"
              >
                {insight.title}
              </Link>
              <StatusBadge
                meta={INSIGHT_STATUS[insight.status]}
                className="shrink-0"
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="line-clamp-3 text-xs text-muted-foreground">
              {insight.summary}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {insight.category ? (
                <StatusBadge
                  meta={SIGNAL_CATEGORY[insight.category]}
                  className="h-4 px-1.5 text-[10px]"
                  showIcon
                />
              ) : null}
              <span>{insight.findingIds.length} bulgu</span>
              <span>{insight.signalIds.length} sinyal</span>
              {insight.isMock ? (
                <StatusBadge
                  meta={{ label: "Demo", tone: "special" }}
                  className="h-4 px-1.5 text-[10px]"
                />
              ) : null}
              <span>{timeAgo(insight.createdAt)}</span>
            </div>
            <ScoreBar value={insight.importance} label="Önem" />
            {insight.opportunities.length > 0 ? (
              <div className="space-y-1">
                {insight.opportunities.map((opportunity) => (
                  <Link
                    key={opportunity.id}
                    href={entityHref(projectId, {
                      kind: "opportunity",
                      id: opportunity.id,
                    })}
                    className="flex items-center justify-between gap-2 rounded-lg bg-accent/50 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">
                      {opportunity.title}
                    </span>
                    <StatusBadge
                      meta={OPPORTUNITY_STATUS[opportunity.status]}
                      className="h-4 shrink-0 px-1.5 text-[10px]"
                    />
                  </Link>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

async function InsightDetail({
  projectId,
  insightId,
}: {
  projectId: string;
  insightId: string;
}) {
  const insight = await prisma.insight.findFirst({
    where: { id: insightId, projectId },
    include: {
      opportunities: { select: { id: true, title: true, status: true } },
    },
  });

  if (!insight) {
    return (
      <div className="space-y-4">
        <BackToList projectId={projectId} />
        <EmptyState
          icon={Lightbulb}
          title="İçgörü bulunamadı"
          hint="Bu kayıt silinmiş olabilir."
        />
      </div>
    );
  }

  const [findings, signals] = await Promise.all([
    insight.findingIds.length
      ? prisma.finding.findMany({
          where: { id: { in: insight.findingIds } },
          select: { id: true, statement: true },
        })
      : Promise.resolve([]),
    insight.signalIds.length
      ? prisma.signal.findMany({
          where: { id: { in: insight.signalIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  const fields: FieldSpec[] = [
    { type: "boolean", label: "Demo verisi", value: insight.isMock },
    {
      type: "date",
      label: "Oluşturulma",
      value: insight.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: insight.updatedAt,
      relative: true,
    },
    {
      type: "node",
      label: "Kaynak bulgular",
      node:
        findings.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {findings.map((f) => (
              <CrossLinkChip
                key={f.id}
                projectId={projectId}
                entity={{ kind: "finding", id: f.id }}
                text={f.statement}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      type: "node",
      label: "Kaynak sinyaller",
      node:
        signals.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {signals.map((s) => (
              <CrossLinkChip
                key={s.id}
                projectId={projectId}
                entity={{ kind: "signal", id: s.id }}
                text={s.title}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <BackToList projectId={projectId} />
      <Card>
        <CardContent className="space-y-4">
          <div>
            <p className="font-heading text-lg font-semibold">
              {insight.title}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {insight.summary}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge meta={INSIGHT_STATUS[insight.status]} />
            {insight.category ? (
              <StatusBadge meta={SIGNAL_CATEGORY[insight.category]} showIcon />
            ) : null}
          </div>
          <ScoreBar value={insight.importance} label="Önem" />
          <FieldGrid fields={fields} />
          {insight.opportunities.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Türetilen fırsatlar
              </p>
              <div className="flex flex-wrap gap-1.5">
                {insight.opportunities.map((o) => (
                  <CrossLinkChip
                    key={o.id}
                    projectId={projectId}
                    entity={{ kind: "opportunity", id: o.id }}
                    text={o.title}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

type OpportunityCardData = Pick<
  Opportunity,
  | "id"
  | "title"
  | "description"
  | "status"
  | "category"
  | "goalIds"
  | "valueScore"
  | "urgencyScore"
  | "confidenceScore"
  | "riskScore"
  | "evidenceStrength"
  | "nbaScore"
  | "timeWindowEnd"
  | "isMock"
  | "createdAt"
> & {
  insight: { id: string; title: string } | null;
  ideas: { id: string; title: string; status: IdeaStatus }[];
};

async function OpportunitiesSection({ projectId }: { projectId: string }) {
  const opportunities = await prisma.opportunity.findMany({
    where: { projectId },
    orderBy: [{ nbaScore: "desc" }, { createdAt: "desc" }],
    take: 150,
    include: {
      insight: { select: { id: true, title: true } },
      ideas: { select: { id: true, title: true, status: true }, take: 5 },
    },
  });

  if (opportunities.length === 0) {
    return (
      <EmptyState
        icon={Compass}
        title="Fırsat yok"
        hint="Fırsat motoru içgörüleri değerlendirdikçe fırsatlar burada NBA skoruna göre sıralanır."
      />
    );
  }

  const goalIds = [...new Set(opportunities.flatMap((o) => o.goalIds))];
  const goals = goalIds.length
    ? await prisma.projectGoal.findMany({
        where: { projectId, id: { in: goalIds } },
        select: { id: true, title: true },
      })
    : [];
  const goalTitle = new Map(goals.map((g) => [g.id, g.title]));
  const now = new Date();

  return (
    <div className="space-y-6">
      {OPPORTUNITY_GROUPS.map((group) => {
        const groupOpportunities = opportunities.filter((o) =>
          group.statuses.includes(o.status),
        );
        if (groupOpportunities.length === 0) return null;
        return (
          <div key={group.label} className="space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              {group.label} ({groupOpportunities.length})
            </h3>
            <div className="grid gap-4 lg:grid-cols-2">
              {groupOpportunities.map((opportunity) => (
                <OpportunityCard
                  key={opportunity.id}
                  projectId={projectId}
                  opportunity={opportunity}
                  goalTitle={goalTitle}
                  now={now}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OpportunityCard({
  projectId,
  opportunity,
  goalTitle,
  now,
}: {
  projectId: string;
  opportunity: OpportunityCardData;
  goalTitle: Map<string, string>;
  now: Date;
}) {
  const windowClosing =
    opportunity.timeWindowEnd &&
    opportunity.timeWindowEnd > now &&
    opportunity.timeWindowEnd.getTime() - now.getTime() < 72 * 60 * 60 * 1000;
  const canDismiss =
    opportunity.status === "NEW" ||
    opportunity.status === "REVIEWING" ||
    opportunity.status === "EVALUATED";

  return (
    <Card size="sm" className="transition-colors hover:bg-muted/40">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <Link
            href={entityHref(projectId, {
              kind: "opportunity",
              id: opportunity.id,
            })}
            className="min-w-0 text-sm leading-snug font-medium underline-offset-2 hover:underline"
          >
            {opportunity.title}
          </Link>
          <div className="flex shrink-0 items-center gap-1.5">
            <NbaScoreChip value={opportunity.nbaScore} />
            <StatusBadge meta={OPPORTUNITY_STATUS[opportunity.status]} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {opportunity.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {opportunity.description}
          </p>
        ) : null}

        <div className="grid grid-cols-5 gap-2">
          <ScoreBar value={opportunity.valueScore} label="Değer" />
          <ScoreBar value={opportunity.urgencyScore} label="Aciliyet" />
          <ScoreBar value={opportunity.confidenceScore} label="Güven" />
          <ScoreBar value={opportunity.riskScore} label="Risk" invert />
          <ScoreBar value={opportunity.evidenceStrength} label="Kanıt" />
        </div>

        {windowClosing ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
            <Hourglass className="size-3.5" />
            Zaman penceresi daralıyor — {shortDate(
              opportunity.timeWindowEnd!,
            )}{" "}
            sonuna kadar
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {opportunity.category ? (
            <StatusBadge
              meta={SIGNAL_CATEGORY[opportunity.category]}
              className="h-4 px-1.5 text-[10px]"
              showIcon
            />
          ) : null}
          {opportunity.goalIds.map((goalId) => (
            <CrossLinkChip
              key={goalId}
              projectId={projectId}
              entity={{ kind: "goal", id: goalId }}
              text={goalTitle.get(goalId) ?? "Hedef"}
              className="h-5 text-[10px]"
            />
          ))}
          {opportunity.insight ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "insight", id: opportunity.insight.id }}
              text={`İçgörü: ${opportunity.insight.title}`}
              className="h-5 text-[10px]"
            />
          ) : null}
          {opportunity.isMock ? (
            <StatusBadge
              meta={{ label: "Demo", tone: "special" }}
              className="h-4 px-1.5 text-[10px]"
            />
          ) : null}
          <span>{timeAgo(opportunity.createdAt)}</span>
        </div>

        {opportunity.ideas.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {opportunity.ideas.map((idea) => (
              <CrossLinkChip
                key={idea.id}
                projectId={projectId}
                entity={{ kind: "idea", id: idea.id }}
                text={idea.title}
                className="h-5 text-[10px]"
              />
            ))}
          </div>
        ) : null}

        {canDismiss ? (
          <ActionForm
            action={dismissOpportunityAction}
            successMessage="Fırsat yoksayıldı"
            className="flex justify-end"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="opportunityId" value={opportunity.id} />
            <SubmitButton variant="ghost" size="xs">
              <XCircle className="size-3" />
              Yoksay
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function OpportunityDetail({
  projectId,
  opportunityId,
}: {
  projectId: string;
  opportunityId: string;
}) {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, projectId },
    include: {
      insight: { select: { id: true, title: true } },
    },
  });

  if (!opportunity) {
    return (
      <div className="space-y-4">
        <BackToList projectId={projectId} />
        <EmptyState
          icon={Compass}
          title="Fırsat bulunamadı"
          hint="Bu kayıt silinmiş olabilir."
        />
      </div>
    );
  }

  const [decision, duplicateOf, generatedIdeas, goals] = await Promise.all([
    prisma.agencyDecision.findFirst({
      where: {
        projectId,
        subjectType: "OPPORTUNITY",
        subjectId: opportunity.id,
      },
      orderBy: { createdAt: "desc" },
    }),
    opportunity.duplicateOfId
      ? prisma.opportunity.findUnique({
          where: { id: opportunity.duplicateOfId },
          select: { id: true, title: true },
        })
      : Promise.resolve(null),
    prisma.idea.findMany({
      where: { opportunityId: opportunity.id },
      include: { councilEvaluations: true },
      orderBy: { createdAt: "desc" },
    }),
    opportunity.goalIds.length
      ? prisma.projectGoal.findMany({
          where: { projectId, id: { in: opportunity.goalIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  let decisionWorkPlan: { id: string; title: string } | null = null;
  let decisionTasks: { id: string; title: string }[] = [];
  if (decision?.workPlanId) {
    decisionWorkPlan = await prisma.workPlan.findUnique({
      where: { id: decision.workPlanId },
      select: { id: true, title: true },
    });
  }
  if (decision?.taskIds.length) {
    decisionTasks = await prisma.task.findMany({
      where: { id: { in: decision.taskIds } },
      select: { id: true, title: true },
    });
  }

  const breakdown =
    decision?.scoreBreakdown && typeof decision.scoreBreakdown === "object"
      ? (decision.scoreBreakdown as Record<string, unknown>)
      : null;

  const fields: FieldSpec[] = [
    {
      type: "date",
      label: "Bekleme (cooldown)",
      value: opportunity.cooldownUntil,
    },
    { type: "boolean", label: "Demo verisi", value: opportunity.isMock },
    {
      type: "date",
      label: "Oluşturulma",
      value: opportunity.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: opportunity.updatedAt,
      relative: true,
    },
    {
      type: "node",
      label: "Mükerrer",
      node: duplicateOf ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "opportunity", id: duplicateOf.id }}
          text={duplicateOf.title}
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Hedefler",
      node:
        goals.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {goals.map((g) => (
              <CrossLinkChip
                key={g.id}
                projectId={projectId}
                entity={{ kind: "goal", id: g.id }}
                text={g.title}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <BackToList projectId={projectId} />
      <Card>
        <CardContent className="space-y-4">
          <div>
            <p className="font-heading text-lg font-semibold">
              {opportunity.title}
            </p>
            {opportunity.description ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {opportunity.description}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <NbaScoreChip value={opportunity.nbaScore} />
            <StatusBadge meta={OPPORTUNITY_STATUS[opportunity.status]} />
            {opportunity.category ? (
              <StatusBadge
                meta={SIGNAL_CATEGORY[opportunity.category]}
                showIcon
              />
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ScoreBar value={opportunity.valueScore} label="Değer" />
            <ScoreBar value={opportunity.urgencyScore} label="Aciliyet" />
            <ScoreBar value={opportunity.confidenceScore} label="Güven" />
            <ScoreBar value={opportunity.riskScore} label="Risk" invert />
            <ScoreBar value={opportunity.evidenceStrength} label="Kanıt" />
          </div>
          {opportunity.timeWindowStart || opportunity.timeWindowEnd ? (
            <p className="text-xs text-muted-foreground">
              Zaman penceresi:{" "}
              {opportunity.timeWindowStart
                ? shortDate(opportunity.timeWindowStart)
                : "—"}{" "}
              →{" "}
              {opportunity.timeWindowEnd
                ? shortDate(opportunity.timeWindowEnd)
                : "—"}
            </p>
          ) : null}
          {opportunity.insight ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "insight", id: opportunity.insight.id }}
              text={`Kaynak içgörü: ${opportunity.insight.title}`}
            />
          ) : null}
          <FieldGrid fields={fields} />

          {decision ? (
            <div className="space-y-2 rounded-lg bg-accent/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">Ajans kararı</span>
                <StatusBadge meta={AGENCY_DECISION_TYPE[decision.decision]} />
                {decision.approvalLevel ? (
                  <StatusBadge meta={APPROVAL_LEVEL[decision.approvalLevel]} />
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {decision.rationale}
              </p>
              {breakdown ? (
                <div className="space-y-1 pt-1">
                  {Object.entries(breakdown).map(([key, val]) =>
                    typeof val === "number" ? (
                      <ScoreBar
                        key={key}
                        value={val}
                        label={councilDimensionLabel(key)}
                      />
                    ) : null,
                  )}
                </div>
              ) : null}
              {decisionWorkPlan ? (
                <CrossLinkChip
                  projectId={projectId}
                  entity={{ kind: "workPlan", id: decisionWorkPlan.id }}
                  text={decisionWorkPlan.title}
                />
              ) : null}
              {decisionTasks.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {decisionTasks.map((t) => (
                    <CrossLinkChip
                      key={t.id}
                      projectId={projectId}
                      entity={{ kind: "task", id: t.id }}
                      text={stripCapabilityPrefix(t.title)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {generatedIdeas.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Üretilen fikirler
              </p>
              <div className="space-y-1.5">
                {generatedIdeas.map((idea) => (
                  <div
                    key={idea.id}
                    className="rounded-lg bg-accent/50 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <CrossLinkChip
                        projectId={projectId}
                        entity={{ kind: "idea", id: idea.id }}
                        text={idea.title}
                      />
                      <StatusBadge
                        meta={IDEA_STATUS[idea.status]}
                        className="shrink-0"
                      />
                    </div>
                    {idea.councilEvaluations.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {idea.councilEvaluations.map((ce) => (
                          <span
                            key={ce.id}
                            className="inline-flex items-center gap-1"
                          >
                            <StatusBadge
                              meta={COUNCIL_TYPE[ce.councilType]}
                              className="h-4 px-1.5 text-[10px]"
                            />
                            <StatusBadge
                              meta={COUNCIL_RECOMMENDATION[ce.recommendation]}
                              className="h-4 px-1.5 text-[10px]"
                            />
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
