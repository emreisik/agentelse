import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Gavel,
  Infinity as InfinityIcon,
  ShieldCheck,
} from "lucide-react";

import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { shortDate, timeAgo } from "@/lib/dates";
import {
  AGENCY_DECISION_SUBJECT,
  AGENCY_DECISION_TYPE,
  AGENCY_TRIGGER_STATUS,
  AGENCY_TRIGGER_TYPE,
  APPROVAL_LEVEL,
  councilDimensionLabel,
} from "@/lib/labels";
import { updateAutonomyPolicyAction } from "@/server/actions/agency-config-actions";
import { ProjectDeletionService } from "@/server/projects/project-deletion.service";
import { ActionForm } from "@/components/shared/action-form";
import { DeleteProjectCard } from "@/components/projects/delete-project-card";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveRefresh } from "@/components/shared/live-refresh";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AYARLAR_SUB_KEYS,
  buildHubHref,
  type AyarlarSubKey,
} from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import type { PanelProps } from "./panel-props";

const SUB_LABEL: Record<AyarlarSubKey, string> = {
  otonomi: "Otonomi",
  kararlar: "Kararlar",
  aktivite: "Aktivite",
  tehlike: "Tehlikeli Bölge",
};

const WEIGHT_LABELS: Record<string, string> = {
  impact: "Etki",
  goalAlignment: "Hedef Uyumu",
  urgency: "Aciliyet",
  evidence: "Kanıt",
  confidence: "Güven",
  timing: "Zamanlama",
  originality: "Özgünlük",
  costPenalty: "Maliyet Cezası",
  effortPenalty: "Efor Cezası",
  riskPenalty: "Risk Cezası",
};

export async function AyarlarPanel({ projectId, sub, entity }: PanelProps) {
  const activeSub: AyarlarSubKey =
    sub && (AYARLAR_SUB_KEYS as readonly string[]).includes(sub)
      ? (sub as AyarlarSubKey)
      : "otonomi";

  const [decisionCount, triggerCount] = await Promise.all([
    prisma.agencyDecision.count({ where: { projectId } }),
    prisma.agencyTrigger.count({ where: { projectId } }),
  ]);

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 border-b border-foreground/10">
          {AYARLAR_SUB_KEYS.map((key) => {
            const isActive = key === activeSub;
            const count =
              key === "kararlar"
                ? decisionCount
                : key === "aktivite"
                  ? triggerCount
                  : undefined;
            return (
              <Link
                key={key}
                href={buildHubHref(projectId, {
                  panel: "ayarlar",
                  sub: key,
                  entity: null,
                })}
                scroll={false}
                className={cn(
                  "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {SUB_LABEL[key]}
                {count !== undefined ? (
                  <span
                    className={cn(
                      "flex h-4 min-w-4 items-center justify-center rounded-4xl px-1 text-[10px] font-medium tabular-nums",
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
        {activeSub !== "otonomi" ? <LiveRefresh /> : null}
      </div>

      {activeSub === "kararlar" ? (
        <DecisionsTab projectId={projectId} entity={entity} />
      ) : activeSub === "aktivite" ? (
        <ActivityTab projectId={projectId} />
      ) : activeSub === "tehlike" ? (
        <DangerTab projectId={projectId} />
      ) : (
        <AutonomyTab projectId={projectId} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

async function AutonomyTab({ projectId }: { projectId: string }) {
  const policy = await prisma.autonomyPolicy.findUnique({
    where: { projectId },
  });

  if (!policy) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Otonomi politikası yok"
        hint="Politika kurulumun 8. aşamasında oluşturulur; ajansın günlük limitlerini buradan yönetirsiniz."
      />
    );
  }

  const weights =
    policy.scoringWeights && typeof policy.scoringWeights === "object"
      ? (policy.scoringWeights as Record<string, number>)
      : {};

  const limitFields: Array<{
    name: string;
    label: string;
    value: number;
    hint: string;
  }> = [
    {
      name: "maxTasksPerDay",
      label: "Günlük görev limiti",
      value: policy.maxTasksPerDay,
      hint: "Ajansın bir günde oluşturabileceği en fazla görev",
    },
    {
      name: "maxReasoningCallsPerDay",
      label: "Günlük akıl yürütme limiti",
      value: policy.maxReasoningCallsPerDay,
      hint: "Bir günde yapılabilecek AI çağrısı sayısı",
    },
    {
      name: "maxConcurrentResearchTasks",
      label: "Eşzamanlı araştırma limiti",
      value: policy.maxConcurrentResearchTasks,
      hint: "Aynı anda yürüyen araştırma görevi sayısı",
    },
    {
      name: "maxOpenOpportunities",
      label: "Açık fırsat limiti",
      value: policy.maxOpenOpportunities,
      hint: "Aynı anda açık tutulabilecek fırsat sayısı",
    },
    {
      name: "maxActiveIdeas",
      label: "Aktif fikir limiti",
      value: policy.maxActiveIdeas,
      hint: "Aynı anda yaşayan fikir sayısı",
    },
    {
      name: "taskCooldownHours",
      label: "Görev soğuma süresi (saat)",
      value: policy.taskCooldownHours,
      hint: "Aynı işin tekrar oluşturulması için beklenecek süre",
    },
  ];

  return (
    <ActionForm
      action={updateAutonomyPolicyAction}
      successMessage="Otonomi politikası güncellendi"
      className="space-y-4"
    >
      <input type="hidden" name="projectId" value={projectId} />

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">Günlük Limitler</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {limitFields.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={`policy-${field.name}`}>{field.label}</Label>
              <Input
                id={`policy-${field.name}`}
                name={field.name}
                type="number"
                min={0}
                defaultValue={field.value}
                required
              />
              <p className="text-xs text-muted-foreground">{field.hint}</p>
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="policy-dailyBudgetUsd">
              Günlük bütçe (USD, boş = sınırsız)
            </Label>
            <Input
              id="policy-dailyBudgetUsd"
              name="dailyBudgetUsd"
              type="number"
              step="0.01"
              min={0}
              defaultValue={policy.dailyBudgetUsd ?? ""}
            />
            <p className="text-xs text-muted-foreground">
              Günlük AI akıl yürütme harcaması tavanı
            </p>
          </div>
          <div className="flex items-center gap-3 pt-6">
            <Switch
              key={`setupAutoApprove-${policy.setupAutoApprove}`}
              id="policy-setupAutoApprove"
              name="setupAutoApprove"
              defaultChecked={policy.setupAutoApprove}
            />
            <div>
              <Label htmlFor="policy-setupAutoApprove">
                Kurulum otomatik onayı
              </Label>
              <p className="text-xs text-muted-foreground">
                Kurulum aşamalarındaki kararları sistem onaylar
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card
        size="sm"
        className={policy.unlimitedMode ? "ring-1 ring-warning/40" : undefined}
      >
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <span className="flex size-7 items-center justify-center rounded-lg bg-warning/15">
            <InfinityIcon className="size-4 text-warning" />
          </span>
          <CardTitle className="text-base">Sınırsız Mod</CardTitle>
        </CardHeader>
        <CardContent className="flex items-start gap-3">
          <Switch
            key={`unlimitedMode-${policy.unlimitedMode}`}
            id="policy-unlimitedMode"
            name="unlimitedMode"
            defaultChecked={policy.unlimitedMode}
          />
          <div className="space-y-1">
            <Label htmlFor="policy-unlimitedMode">
              Günlük sınırları devre dışı bırak
            </Label>
            <p className="text-xs text-muted-foreground">
              Yukarıdaki tüm tavanlar ve günlük bütçe yok sayılır: ajans
              durmadan çalışır. Sayaçlar işlemeye devam eder, yalnızca engelleme
              kalkar — harcamayı Aktivite sekmesinden takip edebilirsiniz.
            </p>
            {policy.unlimitedMode ? (
              <p className="text-xs font-medium text-warning">
                Şu anda açık — sağlayıcı maliyetinde üst sınır yok.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">NBA Skor Ağırlıkları</CardTitle>
          <p className="text-xs text-muted-foreground">
            0-1 arası; boş bırakılan alan motorun varsayılanını kullanır.
            Cezalar skoru düşürür.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          {Object.entries(WEIGHT_LABELS).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`weight-${key}`} className="text-xs">
                {label}
              </Label>
              <Input
                id={`weight-${key}`}
                name={`weight_${key}`}
                type="number"
                step="0.05"
                min={0}
                max={1}
                defaultValue={weights[key] ?? ""}
                placeholder="varsayılan"
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="sticky bottom-4 flex justify-end">
        <SubmitButton>Kaydet</SubmitButton>
      </div>
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------

async function DecisionsTab({
  projectId,
  entity,
}: {
  projectId: string;
  entity: PanelProps["entity"];
}) {
  if (entity && entity.kind === "decision") {
    return <DecisionDetail projectId={projectId} decisionId={entity.id} />;
  }

  const decisions = await prisma.agencyDecision.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (decisions.length === 0) {
    return (
      <EmptyState
        icon={Gavel}
        title="Karar yok"
        hint="Ajans direktörü fırsat ve fikirler hakkında karar verdikçe gerekçeleriyle burada günlüklenir."
      />
    );
  }

  const opportunityIds = decisions
    .filter((d) => d.subjectType === "OPPORTUNITY")
    .map((d) => d.subjectId);
  const ideaIds = decisions
    .filter((d) => d.subjectType === "IDEA")
    .map((d) => d.subjectId);
  const [opportunities, ideas] = await Promise.all([
    opportunityIds.length
      ? prisma.opportunity.findMany({
          where: { id: { in: opportunityIds } },
          select: { id: true, title: true },
        })
      : [],
    ideaIds.length
      ? prisma.idea.findMany({
          where: { id: { in: ideaIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const subjectTitle = new Map([
    ...opportunities.map((o) => [o.id, o.title] as const),
    ...ideas.map((i) => [i.id, i.title] as const),
  ]);

  return (
    <Card size="sm">
      <CardContent className="divide-y divide-foreground/5">
        {decisions.map((decision) => {
          const breakdown =
            decision.scoreBreakdown &&
            typeof decision.scoreBreakdown === "object"
              ? (decision.scoreBreakdown as Record<string, unknown>)
              : null;
          return (
            <div key={decision.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge meta={AGENCY_DECISION_TYPE[decision.decision]} />
                <StatusBadge
                  meta={AGENCY_DECISION_SUBJECT[decision.subjectType]}
                  className="h-4 px-1.5 text-[10px]"
                />
                {decision.approvalLevel ? (
                  <StatusBadge
                    meta={APPROVAL_LEVEL[decision.approvalLevel]}
                    className="h-4 px-1.5 text-[10px]"
                  />
                ) : null}
                {decision.isMock ? (
                  <StatusBadge
                    meta={{ label: "Demo", tone: "special" }}
                    className="h-4 px-1.5 text-[10px]"
                  />
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {timeAgo(decision.createdAt)}
                </span>
              </div>
              <Link
                href={buildHubHref(projectId, {
                  panel: "ayarlar",
                  sub: "kararlar",
                  entity: { kind: "decision", id: decision.id },
                })}
                scroll={false}
                className="block text-sm font-medium underline-offset-2 hover:underline"
              >
                {subjectTitle.get(decision.subjectId) ??
                  `${AGENCY_DECISION_SUBJECT[decision.subjectType].label} kaydı`}
              </Link>
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Gerekçe
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">
                  {decision.rationale}
                </p>
                {breakdown ? (
                  <div className="mt-2 grid max-w-md grid-cols-2 gap-x-4 gap-y-1">
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
              </details>
              {decision.workPlanId ? (
                <CrossLinkChip
                  projectId={projectId}
                  entity={{ kind: "workPlan", id: decision.workPlanId }}
                  text="Oluşturulan iş planı"
                  sub="planlar"
                />
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

async function DecisionDetail({
  projectId,
  decisionId,
}: {
  projectId: string;
  decisionId: string;
}) {
  const decision = await prisma.agencyDecision.findUnique({
    where: { id: decisionId },
  });

  if (!decision || decision.projectId !== projectId) {
    return (
      <EmptyState
        icon={Gavel}
        title="Karar bulunamadı"
        hint="Silinmiş olabilir."
      />
    );
  }

  const subjectTitle = await (async () => {
    if (decision.subjectType === "OPPORTUNITY") {
      const o = await prisma.opportunity.findUnique({
        where: { id: decision.subjectId },
        select: { title: true },
      });
      return o?.title;
    }
    if (decision.subjectType === "IDEA") {
      const i = await prisma.idea.findUnique({
        where: { id: decision.subjectId },
        select: { title: true },
      });
      return i?.title;
    }
    return undefined;
  })();

  const fields: FieldSpec[] = [
    {
      type: "badge",
      label: "Karar",
      meta: AGENCY_DECISION_TYPE[decision.decision],
    },
    {
      type: "badge",
      label: "Konu Türü",
      meta: AGENCY_DECISION_SUBJECT[decision.subjectType],
    },
    {
      type: "badge",
      label: "Onay Seviyesi",
      meta: decision.approvalLevel
        ? APPROVAL_LEVEL[decision.approvalLevel]
        : undefined,
      fallback: "—",
    },
    { type: "boolean", label: "Demo Verisi (mock)", value: decision.isMock },
    {
      type: "date",
      label: "Oluşturuldu",
      value: decision.createdAt,
      relative: true,
    },
    { type: "text", label: "Gerekçe", value: decision.rationale },
  ];

  return (
    <div className="space-y-6">
      <Link
        href={buildHubHref(projectId, {
          panel: "ayarlar",
          sub: "kararlar",
          entity: null,
        })}
        scroll={false}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Listeye dön
      </Link>

      <Card size="sm">
        <CardContent className="space-y-3">
          <h3 className="font-heading text-lg font-semibold text-foreground">
            {subjectTitle ??
              `${AGENCY_DECISION_SUBJECT[decision.subjectType].label} kaydı`}
          </h3>
          <FieldGrid fields={fields} />
          {decision.workPlanId ? (
            <CrossLinkChip
              projectId={projectId}
              entity={{ kind: "workPlan", id: decision.workPlanId }}
              text="Oluşturulan iş planı"
              sub="planlar"
            />
          ) : null}
          {decision.taskIds.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {decision.taskIds.map((taskId) => (
                <CrossLinkChip
                  key={taskId}
                  projectId={projectId}
                  entity={{ kind: "task", id: taskId }}
                  text={`Görev ${taskId.slice(0, 8)}`}
                  sub="gorevler"
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function ActivityTab({ projectId }: { projectId: string }) {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [stats, reasoningGroups, statusGroups, recentCalls, triggers] =
    await Promise.all([
      prisma.agencyDailyStat.findMany({
        where: { projectId, date: { gte: since } },
        orderBy: { date: "asc" },
      }),
      prisma.reasoningCall.groupBy({
        by: ["purpose", "isMock"],
        where: { projectId },
        _count: { id: true },
        _sum: { costUsd: true },
        _avg: { durationMs: true },
      }),
      prisma.reasoningCall.groupBy({
        by: ["status"],
        where: { projectId },
        _count: { id: true },
      }),
      prisma.reasoningCall.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 25,
      }),
      prisma.agencyTrigger.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

  const series: Array<{
    key:
      | "tasksCreated"
      | "signalsIngested"
      | "opportunitiesCreated"
      | "ideasCreated"
      | "reasoningCalls";
    label: string;
  }> = [
    { key: "tasksCreated", label: "Görevler" },
    { key: "signalsIngested", label: "Sinyaller" },
    { key: "opportunitiesCreated", label: "Fırsatlar" },
    { key: "ideasCreated", label: "Fikirler" },
    { key: "reasoningCalls", label: "AI Çağrıları" },
  ];

  const totalCalls = reasoningGroups.reduce((sum, g) => sum + g._count.id, 0);
  const mockCalls = reasoningGroups
    .filter((g) => g.isMock)
    .reduce((sum, g) => sum + g._count.id, 0);
  const totalCost = reasoningGroups.reduce(
    (sum, g) => sum + (g._sum.costUsd ?? 0),
    0,
  );

  const purposeRows = new Map<
    string,
    { count: number; mock: number; cost: number; avgMs: number }
  >();
  for (const group of reasoningGroups) {
    const row = purposeRows.get(group.purpose) ?? {
      count: 0,
      mock: 0,
      cost: 0,
      avgMs: 0,
    };
    row.count += group._count.id;
    if (group.isMock) row.mock += group._count.id;
    row.cost += group._sum.costUsd ?? 0;
    row.avgMs = group._avg.durationMs ?? row.avgMs;
    purposeRows.set(group.purpose, row);
  }

  return (
    <div className="space-y-4">
      {stats.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Aktivite verisi yok"
          hint="Ajans çalışmaya başladığında günlük istatistikler burada birikir."
        />
      ) : (
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-base">Son 30 Gün</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {series.map((serie) => {
              const max = Math.max(...stats.map((s) => s[serie.key]), 1);
              const total = stats.reduce((sum, s) => sum + s[serie.key], 0);
              return (
                <div key={serie.key}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{serie.label}</span>
                    <span className="font-medium tabular-nums">{total}</span>
                  </div>
                  <div className="flex h-8 items-end gap-px">
                    {stats.map((stat) => (
                      <div
                        key={stat.id}
                        title={`${shortDate(stat.date)}: ${stat[serie.key]}`}
                        className={cn(
                          "min-w-0 flex-1 rounded-t-sm",
                          stat[serie.key] > 0 ? "bg-primary/70" : "bg-muted",
                        )}
                        style={{
                          height: `${Math.max(6, (stat[serie.key] / max) * 100)}%`,
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">AI Akıl Yürütme</CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">{totalCalls} çağrı</span>
              {totalCalls > 0 ? (
                <StatusBadge
                  meta={{
                    label: `%${Math.round((mockCalls / totalCalls) * 100)} mock`,
                    tone: "special",
                  }}
                  className="h-4 px-1.5 text-[10px]"
                />
              ) : null}
              <span className="tabular-nums">${totalCost.toFixed(2)}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {purposeRows.size === 0 ? (
            <p className="text-sm text-muted-foreground">
              Henüz AI çağrısı yapılmadı.
            </p>
          ) : (
            <>
              <div className="divide-y divide-foreground/5">
                {[...purposeRows.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .map(([purpose, row]) => (
                    <div
                      key={purpose}
                      className="flex items-center justify-between gap-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {purpose}
                      </span>
                      <div className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                        <span>{row.count} çağrı</span>
                        <span>{row.mock} mock</span>
                        <span>{Math.round(row.avgMs)} ms</span>
                        <span>${row.cost.toFixed(3)}</span>
                      </div>
                    </div>
                  ))}
              </div>

              {statusGroups.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {statusGroups.map((group) => (
                    <span
                      key={group.status}
                      className="rounded-4xl bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {group.status}: {group._count.id}
                    </span>
                  ))}
                </div>
              ) : null}

              {recentCalls.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium text-foreground">
                    Son Çağrılar
                  </p>
                  <div className="divide-y divide-foreground/5">
                    {recentCalls.map((call) => (
                      <div key={call.id} className="space-y-1 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{call.purpose}</span>
                          <span className="rounded-4xl bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {call.model}
                          </span>
                          <StatusBadge
                            meta={{
                              label: call.status,
                              tone:
                                call.status === "ERROR" ||
                                call.status === "FAILED"
                                  ? "danger"
                                  : call.status === "OK" ||
                                      call.status === "SUCCESS"
                                    ? "positive"
                                    : "neutral",
                            }}
                            className="h-4 px-1.5 text-[10px]"
                          />
                          {call.isMock ? (
                            <StatusBadge
                              meta={{ label: "mock", tone: "special" }}
                              className="h-4 px-1.5 text-[10px]"
                            />
                          ) : null}
                          <span className="ml-auto text-muted-foreground">
                            {timeAgo(call.createdAt)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                          <span>giriş: {call.inputTokens ?? "—"} tok</span>
                          <span>çıkış: {call.outputTokens ?? "—"} tok</span>
                          <span>{call.durationMs} ms</span>
                          <span>${(call.costUsd ?? 0).toFixed(4)}</span>
                        </div>
                        {call.errorMessage ? (
                          <p className="text-destructive">
                            {call.errorMessage}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base">Tetikleyiciler</CardTitle>
        </CardHeader>
        <CardContent>
          {triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Henüz tetikleyici oluşmadı.
            </p>
          ) : (
            <div className="divide-y divide-foreground/5">
              {triggers.map((trigger) => (
                <div key={trigger.id} className="space-y-1.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusBadge meta={AGENCY_TRIGGER_TYPE[trigger.type]} />
                      {trigger.error ? (
                        <span className="min-w-0 truncate text-xs text-destructive">
                          {trigger.error}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge
                        meta={AGENCY_TRIGGER_STATUS[trigger.status]}
                        className="h-4 px-1.5 text-[10px]"
                      />
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(trigger.createdAt)}
                      </span>
                    </div>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Detaylar
                    </summary>
                    <FieldGrid
                      className="mt-1"
                      fields={[
                        {
                          type: "date",
                          label: "Zamanlanan",
                          value: trigger.scheduledFor,
                        },
                        {
                          type: "date",
                          label: "İşlenme",
                          value: trigger.processedAt,
                        },
                      ]}
                    />
                  </details>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

// Silme önizlemesi tablo tablo sayım yaptığı için yalnızca bu sekme
// açıldığında hesaplanır — diğer sekmelerin yükünü artırmamalı.
async function DangerTab({ projectId }: { projectId: string }) {
  const preview = await ProjectDeletionService.preview(projectId);
  if (!preview) return null;

  return (
    <div className="space-y-3">
      <p className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <span>Yerel varlık dosyaları (asset)</span>
        <span className="font-mono tabular-nums text-foreground">
          {preview.localAssetFiles}
        </span>
      </p>
      <DeleteProjectCard
        projectId={preview.projectId}
        projectName={preview.projectName}
        totalRows={preview.totalRows}
        topTables={preview.byTable.slice(0, 12)}
      />
    </div>
  );
}
