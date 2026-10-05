import type { ReactNode } from "react";
import Link from "next/link";
import { Compass } from "lucide-react";

import { prisma } from "@/lib/prisma";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button";
import type { EntityRef } from "../../hub-core-params";
import {
  INTELLIGENCE_SECTIONS,
  intelligenceIsEmpty,
  sectionOfEntity,
  sectionOpenedFirst,
  type IntelligenceCounts,
  type IntelligenceSection as SectionKey,
} from "./intelligence-state";
import {
  InsightDetail,
  InsightsSection,
  OpportunitiesSection,
  OpportunityDetail,
} from "./insights-parts";
import {
  FindingDetail,
  FindingsSection,
  SignalDetail,
  SignalsSection,
} from "./signals-parts";

const TITLE: Record<SectionKey, string> = {
  findings: "Findings",
  insights: "Insights",
  opportunities: "Opportunities",
  signals: "Signals",
};

const HINT: Record<SectionKey, string> = {
  findings: "What research and scans found out about the brand and its market.",
  insights: "What the findings and signals mean for the brand.",
  opportunities: "Things worth acting on, derived from the insights.",
  signals: "Raw observations from connected accounts (Meta Ads, Google Analytics).",
};

// The Brand Brain's Intelligence tab: everything the agency has gathered about
// the brand's market, in the order it is derived (finding -> insight ->
// opportunity, with raw signals last). A record opened from a cross-link
// replaces the lists with its detail. Read-only apart from dismissing an
// opportunity.
export async function IntelligenceSection({
  projectId,
  entity,
}: {
  projectId: string;
  entity: EntityRef | null;
}) {
  const detail = entity && sectionOfEntity(entity.kind) ? entity : null;
  if (detail) {
    return (
      <div className="space-y-4">
        {detail.kind === "finding" ? (
          <FindingDetail projectId={projectId} findingId={detail.id} />
        ) : detail.kind === "signal" ? (
          <SignalDetail projectId={projectId} signalId={detail.id} />
        ) : detail.kind === "insight" ? (
          <InsightDetail projectId={projectId} insightId={detail.id} />
        ) : (
          <OpportunityDetail projectId={projectId} opportunityId={detail.id} />
        )}
      </div>
    );
  }

  const [findings, insights, opportunities, signals] = await Promise.all([
    prisma.finding.count({ where: { projectId } }),
    prisma.insight.count({ where: { projectId } }),
    prisma.opportunity.count({ where: { projectId } }),
    prisma.signal.count({ where: { projectId } }),
  ]);
  const counts: IntelligenceCounts = {
    findings,
    insights,
    opportunities,
    signals,
  };
  if (intelligenceIsEmpty(counts)) {
    return <NothingGathered projectId={projectId} />;
  }

  const opened = sectionOpenedFirst(counts);
  const body: Record<SectionKey, ReactNode> = {
    findings: <FindingsSection projectId={projectId} />,
    insights: <InsightsSection projectId={projectId} />,
    opportunities: <OpportunitiesSection projectId={projectId} />,
    signals: <SignalsSection projectId={projectId} />,
  };

  return (
    <div className="space-y-4">
      {INTELLIGENCE_SECTIONS.filter((key) => counts[key] > 0).map((key) => (
        <details
          key={key}
          open={key === opened}
          className="group rounded-xl ring-1 ring-foreground/10"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span>
              <span className="text-sm font-medium">
                {TITLE[key]}{" "}
                <span className="text-muted-foreground">({counts[key]})</span>
              </span>
              <span className="block text-xs text-muted-foreground">
                {HINT[key]}
              </span>
            </span>
            <span
              aria-hidden
              className="text-xs text-muted-foreground group-open:hidden"
            >
              Show
            </span>
          </summary>
          <div className="px-4 pb-4">{body[key]}</div>
        </details>
      ))}
    </div>
  );
}

// Said once, plainly, with the two ways it fills.
function NothingGathered({ projectId }: { projectId: string }) {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing gathered yet"
      hint="Findings appear when the agent researches for you: ask it to research your competitors or your market. Signals appear once Meta Ads or Google Analytics is connected."
    >
      <Link
        href={`/projects/${projectId}/integrations`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Open Connectors
      </Link>
    </EmptyState>
  );
}
