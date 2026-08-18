import Link from "next/link";
import { ArrowLeft, RadioTower, SlidersHorizontal } from "lucide-react";
import type { SignalIntensity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { shortDate, timeAgo } from "@/lib/dates";
import {
  SIGNAL_CATEGORY,
  SIGNAL_INTENSITY,
  SIGNAL_INTENSITY_HINT,
  SIGNAL_STATUS,
  FACT_CLASSIFICATION,
  FINDING_SOURCE_TYPE,
  stripCapabilityPrefix,
} from "@/lib/labels";
import { updateSignalIntensityAction } from "@/server/actions/agency-config-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { ModeSwitcher } from "@/components/shared/mode-switcher";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { buildHubHref } from "../hub-core-params";
import { CrossLinkChip } from "../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../primitives/field-grid";
import { FindingList, SignalList } from "./sinyaller-list-filters";
import type { PanelProps } from "./panel-props";

// Sinyaller paneli — ham/yakın-ham girdi katmanı: sinyaller, onlardan
// çıkarılan bulgular ve tarama yoğunluğu profili, art arda üç bölüm.
// `entity` bu panelin sahip olduğu bir kaydı (signal/finding) işaret
// ediyorsa, ilgili bölüm listenin yerine o kaydın tam detayını gösterir.
export async function SinyallerPanel({ projectId, entity }: PanelProps) {
  const [signalCount, findingCount] = await Promise.all([
    prisma.signal.count({ where: { projectId } }),
    prisma.finding.count({ where: { projectId } }),
  ]);

  return (
    <div className="space-y-8 py-6">
      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">
          Sinyaller{" "}
          <span className="text-muted-foreground">({signalCount})</span>
        </p>
        {entity?.kind === "signal" ? (
          <SignalDetail projectId={projectId} signalId={entity.id} />
        ) : (
          <SignalsSection projectId={projectId} />
        )}
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">
          Bulgular{" "}
          <span className="text-muted-foreground">({findingCount})</span>
        </p>
        {entity?.kind === "finding" ? (
          <FindingDetail projectId={projectId} findingId={entity.id} />
        ) : (
          <FindingsSection projectId={projectId} />
        )}
      </section>

      <section className="space-y-3">
        <p className="text-sm font-medium text-foreground">Sinyal Profili</p>
        <ProfileSection projectId={projectId} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function BackToList({ projectId }: { projectId: string }) {
  return (
    <Link
      href={buildHubHref(projectId, {
        panel: "sinyaller",
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

async function SignalsSection({ projectId }: { projectId: string }) {
  const signals = await prisma.signal.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return <SignalList projectId={projectId} signals={signals} />;
}

async function SignalDetail({
  projectId,
  signalId,
}: {
  projectId: string;
  signalId: string;
}) {
  const signal = await prisma.signal.findFirst({
    where: { id: signalId, projectId },
  });

  if (!signal) {
    return (
      <div className="space-y-4">
        <BackToList projectId={projectId} />
        <EmptyState
          icon={RadioTower}
          title="Sinyal bulunamadı"
          hint="Bu kayıt silinmiş olabilir."
        />
      </div>
    );
  }

  const [duplicateOf, sourceTask, relatedInsights] = await Promise.all([
    signal.duplicateOfId
      ? prisma.signal.findUnique({
          where: { id: signal.duplicateOfId },
          select: { id: true, title: true },
        })
      : Promise.resolve(null),
    signal.sourceTaskId
      ? prisma.task.findUnique({
          where: { id: signal.sourceTaskId },
          select: { id: true, title: true },
        })
      : Promise.resolve(null),
    prisma.insight.findMany({
      where: { projectId, signalIds: { has: signal.id } },
      select: { id: true, title: true },
    }),
  ]);

  const categoryMeta = SIGNAL_CATEGORY[signal.category];

  const fields: FieldSpec[] = [
    { type: "text", label: "Kaynak", value: signal.source },
    { type: "text", label: "Dış referans", value: signal.externalRef },
    { type: "date", label: "Gerçekleşme", value: signal.occurredAt },
    {
      type: "date",
      label: "Toplanma",
      value: signal.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Güncellenme",
      value: signal.updatedAt,
      relative: true,
    },
    {
      type: "node",
      label: "Kaynak görev",
      node: sourceTask ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "task", id: sourceTask.id }}
          text={stripCapabilityPrefix(sourceTask.title)}
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Mükerrer",
      node: duplicateOf ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "signal", id: duplicateOf.id }}
          text={duplicateOf.title}
        />
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
            <p className="font-heading text-lg font-semibold">{signal.title}</p>
            {signal.summary ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {signal.summary}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge meta={categoryMeta} showIcon />
            <StatusBadge meta={SIGNAL_STATUS[signal.status]} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <ScoreBar value={signal.freshness} label="Tazelik" />
            <ScoreBar value={signal.reliability} label="Güvenilirlik" />
            <ScoreBar value={signal.relevanceScore} label="İlgililik" />
          </div>
          <FieldGrid fields={fields} />
          {relatedInsights.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">
                İlişkili içgörüler
              </p>
              <div className="flex flex-wrap gap-1.5">
                {relatedInsights.map((insight) => (
                  <CrossLinkChip
                    key={insight.id}
                    projectId={projectId}
                    entity={{ kind: "insight", id: insight.id }}
                    text={insight.title}
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

async function FindingsSection({ projectId }: { projectId: string }) {
  const findings = await prisma.finding.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return <FindingList projectId={projectId} findings={findings} />;
}

async function FindingDetail({
  projectId,
  findingId,
}: {
  projectId: string;
  findingId: string;
}) {
  const finding = await prisma.finding.findFirst({
    where: { id: findingId, projectId },
  });

  if (!finding) {
    return (
      <div className="space-y-4">
        <BackToList projectId={projectId} />
        <EmptyState
          icon={RadioTower}
          title="Bulgu bulunamadı"
          hint="Bu kayıt silinmiş olabilir."
        />
      </div>
    );
  }

  const [sourceTask, signal] = await Promise.all([
    finding.sourceTaskId
      ? prisma.task.findUnique({
          where: { id: finding.sourceTaskId },
          select: { id: true, title: true },
        })
      : Promise.resolve(null),
    finding.signalId
      ? prisma.signal.findUnique({
          where: { id: finding.signalId },
          select: { id: true, title: true },
        })
      : Promise.resolve(null),
  ]);

  const fields: FieldSpec[] = [
    { type: "text", label: "Kategori", value: finding.category },
    { type: "boolean", label: "Demo verisi", value: finding.isMock },
    {
      type: "date",
      label: "Oluşturulma",
      value: finding.createdAt,
      relative: true,
    },
    {
      type: "node",
      label: "Kaynak görev",
      node: sourceTask ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "task", id: sourceTask.id }}
          text={stripCapabilityPrefix(sourceTask.title)}
        />
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      ),
    },
    {
      type: "node",
      label: "Kaynak sinyal",
      node: signal ? (
        <CrossLinkChip
          projectId={projectId}
          entity={{ kind: "signal", id: signal.id }}
          text={signal.title}
        />
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
          <p className="text-sm">{finding.statement}</p>
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge meta={FACT_CLASSIFICATION[finding.classification]} />
            <StatusBadge meta={FINDING_SOURCE_TYPE[finding.sourceType]} />
          </div>
          <ScoreBar value={finding.confidence} label="Güven" />
          <FieldGrid fields={fields} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

async function ProfileSection({ projectId }: { projectId: string }) {
  const profiles = await prisma.projectSignalProfile.findMany({
    where: { projectId },
    orderBy: { category: "asc" },
  });

  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={SlidersHorizontal}
        title="Sinyal profili yok"
        hint="Sinyal profili kurulumun 4. aşamasında oluşturulur; her kategorinin izleme yoğunluğunu buradan yönetirsiniz."
      />
    );
  }

  const intensityOptions = (
    Object.keys(SIGNAL_INTENSITY) as SignalIntensity[]
  ).map((intensity) => ({
    value: intensity,
    label: SIGNAL_INTENSITY[intensity].label,
    hint: SIGNAL_INTENSITY_HINT[intensity],
  }));

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {profiles.map((profile) => {
        const categoryMeta = SIGNAL_CATEGORY[profile.category];
        const CategoryIcon = categoryMeta.icon;
        return (
          <Card key={profile.id} size="sm">
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                    {CategoryIcon ? (
                      <CategoryIcon className="size-4" />
                    ) : (
                      <RadioTower className="size-4" />
                    )}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {categoryMeta.label}
                  </span>
                </div>
                <ModeSwitcher
                  value={profile.intensity}
                  options={intensityOptions}
                  action={updateSignalIntensityAction}
                  hiddenFields={{
                    projectId,
                    category: profile.category,
                  }}
                  fieldName="intensity"
                  successMessage={`${categoryMeta.label} yoğunluğu güncellendi`}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{SIGNAL_INTENSITY_HINT[profile.intensity]}</span>
                <span>
                  {profile.lastScanAt
                    ? `Son: ${timeAgo(profile.lastScanAt)}`
                    : "Henüz taranmadı"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Sonraki tarama</span>
                <span className="tabular-nums">
                  {profile.nextScanAt ? shortDate(profile.nextScanAt) : "—"}
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
