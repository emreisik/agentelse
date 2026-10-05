// The raw input layer of the Brand Brain's Intelligence tab: signals and the
// findings extracted from them. Composed by intelligence-section.tsx.
import Link from "next/link";
import { ArrowLeft, RadioTower } from "lucide-react";

import { prisma } from "@/lib/prisma";
import {
  SIGNAL_CATEGORY,
  SIGNAL_STATUS,
  FACT_CLASSIFICATION,
  FINDING_SOURCE_TYPE,
  stripCapabilityPrefix,
} from "@/lib/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { ScoreBar } from "@/components/shared/score-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { buildHubHref } from "../../hub-core-params";
import { CrossLinkChip } from "../../primitives/cross-link-chip";
import { FieldGrid, type FieldSpec } from "../../primitives/field-grid";
import { FindingList, SignalList } from "./signals-list-filters";

// ---------------------------------------------------------------------------

function BackToList({ projectId }: { projectId: string }) {
  return (
    <Link
      href={buildHubHref(projectId, {
        panel: "brand-brain",
        sub: "intelligence",
        entity: null,
      })}
      className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
    >
      <ArrowLeft className="size-3" />
      Back to list
    </Link>
  );
}

// ---------------------------------------------------------------------------

export async function SignalsSection({ projectId }: { projectId: string }) {
  const signals = await prisma.signal.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return <SignalList projectId={projectId} signals={signals} />;
}

export async function SignalDetail({
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
          title="Signal not found"
          hint="This record may have been deleted."
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
    { type: "text", label: "Source", value: signal.source },
    { type: "text", label: "External reference", value: signal.externalRef },
    { type: "date", label: "Occurred", value: signal.occurredAt },
    {
      type: "date",
      label: "Collected",
      value: signal.createdAt,
      relative: true,
    },
    {
      type: "date",
      label: "Updated",
      value: signal.updatedAt,
      relative: true,
    },
    {
      type: "node",
      label: "Source task",
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
      label: "Duplicate",
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
            <ScoreBar value={signal.freshness} label="Freshness" />
            <ScoreBar value={signal.reliability} label="Reliability" />
            <ScoreBar value={signal.relevanceScore} label="Relevance" />
          </div>
          <FieldGrid fields={fields} />
          {relatedInsights.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">
                Related insights
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

export async function FindingsSection({ projectId }: { projectId: string }) {
  const findings = await prisma.finding.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return <FindingList projectId={projectId} findings={findings} />;
}

export async function FindingDetail({
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
          title="Finding not found"
          hint="This record may have been deleted."
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
    { type: "text", label: "Category", value: finding.category },
    { type: "boolean", label: "Demo data", value: finding.isMock },
    {
      type: "date",
      label: "Created",
      value: finding.createdAt,
      relative: true,
    },
    {
      type: "node",
      label: "Source task",
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
      label: "Source signal",
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
          <ScoreBar value={finding.confidence} label="Confidence" />
          <FieldGrid fields={fields} />
        </CardContent>
      </Card>
    </div>
  );
}
