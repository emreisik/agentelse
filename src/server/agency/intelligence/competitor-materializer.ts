import "server-only";

import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

export type CompetitorFindingInput = {
  competitorName: string;
  statement: string;
  confidence?: number;
};

// Groups research-extraction findings (research-extraction.ts's optional
// competitorName field) by the named competitor they're about and writes
// them into the previously-unused Competitor/CompetitorSnapshot/
// CompetitorChange/CompetitorInsight tables (schema.prisma:1642-1730).
// Before this, COMPETITOR_RESEARCH/MONITORING/CHANGE_DETECTION results only
// ever reached the generic Finding/Signal tables — nothing (including the
// council's "evidence" dimension, see council-engine.ts) could see
// structured, per-competitor data.
export const CompetitorMaterializer = {
  async materialize(
    scope: { workspaceId: string; projectId: string; brandId: string },
    sourceTaskId: string,
    findings: CompetitorFindingInput[],
  ): Promise<{ competitors: number; insights: number }> {
    const byCompetitor = new Map<string, CompetitorFindingInput[]>();
    for (const finding of findings) {
      const name = finding.competitorName.trim();
      if (!name) continue;
      const bucket = byCompetitor.get(name) ?? [];
      bucket.push(finding);
      byCompetitor.set(name, bucket);
    }
    if (byCompetitor.size === 0) return { competitors: 0, insights: 0 };

    let insightCount = 0;
    for (const [name, competitorFindings] of byCompetitor) {
      let competitor = await prisma.competitor.findFirst({
        where: { projectId: scope.projectId, name },
      });
      if (!competitor) {
        competitor = await prisma.competitor.create({
          data: { ...scope, name },
        });
      }

      const contentHash = createHash("sha256")
        .update(
          JSON.stringify(competitorFindings.map((f) => f.statement).sort()),
        )
        .digest("hex");

      const previousSnapshot = await prisma.competitorSnapshot.findFirst({
        where: { competitorId: competitor.id },
        orderBy: { capturedAt: "desc" },
      });

      // Identical to the last capture (e.g. a re-scan surfacing nothing
      // new) — skip writing a duplicate snapshot/change/insight set.
      if (previousSnapshot?.contentHash === contentHash) continue;

      const snapshot = await prisma.competitorSnapshot.create({
        data: {
          competitorId: competitor.id,
          capturedAt: new Date(),
          payload: { sourceTaskId, findings: competitorFindings },
          contentHash,
        },
      });

      let changeId: string | undefined;
      if (previousSnapshot) {
        const change = await prisma.competitorChange.create({
          data: {
            competitorId: competitor.id,
            fromSnapshotId: previousSnapshot.id,
            toSnapshotId: snapshot.id,
            summary: `New research on ${name}: ${competitorFindings[0]?.statement.slice(0, 200) ?? "updated findings"}`,
            diff: {
              addedFindings: competitorFindings.map((f) => f.statement),
            },
          },
        });
        changeId = change.id;
      }

      for (const finding of competitorFindings) {
        await prisma.competitorInsight.create({
          data: {
            competitorId: competitor.id,
            changeId,
            insight: finding.statement,
            confidence: finding.confidence,
          },
        });
      }
      insightCount += competitorFindings.length;
    }

    return { competitors: byCompetitor.size, insights: insightCount };
  },
};
