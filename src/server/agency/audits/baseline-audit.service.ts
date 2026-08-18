import "server-only";

import type { DepartmentKey } from "@prisma/client";

import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { baselineAuditDef } from "@/server/reasoning/prompts/baseline-audit";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BaselineAuditRepository } from "@/server/repositories/baseline-audit.repository";
import { FindingRepository } from "@/server/repositories/finding.repository";

// Spec section 11 lists 15 audit dimensions; they map onto our department
// keys (Brand->BRAND_STRATEGY, Market->MARKET_INTELLIGENCE, ...).
const AUDIT_DEPARTMENTS: DepartmentKey[] = [
  "BRAND_STRATEGY",
  "MARKET_INTELLIGENCE",
  "CUSTOMER_INTELLIGENCE",
  "COMPETITOR_INTELLIGENCE",
  "CREATIVE",
  "SOCIAL_MEDIA",
  "SEO",
  "COPY_CONTENT",
  "WEB_PRODUCT",
  "PERFORMANCE_MARKETING",
  "DATA_ANALYTICS",
  "PR_MEDIA",
  "INFLUENCER_CREATOR",
  "PARTNERSHIPS",
  "GROWTH",
];

export const BaselineAuditService = {
  async generateAll(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
  }) {
    const [brand, findings] = await Promise.all([
      ConstitutionService.getBrandContext(scope.brandId),
      FindingRepository.listForProject(scope.projectId, { limit: 300 }),
    ]);

    const findingSlice = findings.slice(0, 60).map((f) => ({
      statement: f.statement,
      classification: f.classification,
      category: f.category,
    }));
    const findingIds = findings.slice(0, 60).map((f) => f.id);

    // Independent per-department evaluations — run in bounded parallel
    // batches to keep remote-DB wall clock manageable.
    type Audit = Parameters<
      typeof BaselineAuditRepository.upsertMany
    >[1][number];

    const auditOne = async (department: (typeof AUDIT_DEPARTMENTS)[number]) => {
      const { output, isMock } = await ReasoningService.run(baselineAuditDef, {
        ...scope,
        context: { department, brand, findings: findingSlice },
      });
      return {
        department,
        score: Math.round(output.score),
        summary: output.summary,
        strengths: output.strengths,
        weaknesses: output.weaknesses,
        risks: output.risks,
        potentialOpportunities: output.potentialOpportunities,
        findingIds,
        isMock,
      } satisfies Audit;
    };

    // allSettled, not Promise.all: a single department's model returning
    // truncated JSON used to trash the whole batch, no audit got saved,
    // and the stage restarted from scratch — with a 27% error rate the
    // stage practically never finished, wasting 19 calls on every round.
    const audits: Audit[] = [];
    const failed: Array<(typeof AUDIT_DEPARTMENTS)[number]> = [];
    const BATCH = 5;
    for (let i = 0; i < AUDIT_DEPARTMENTS.length; i += BATCH) {
      const chunk = AUDIT_DEPARTMENTS.slice(i, i + BATCH);
      const results = await Promise.allSettled(chunk.map(auditOne));
      results.forEach((result, index) => {
        if (result.status === "fulfilled") audits.push(result.value);
        else failed.push(chunk[index]!);
      });
    }

    // Truncated JSON is a transient error — give failed departments one extra try.
    for (const department of failed) {
      try {
        audits.push(await auditOne(department));
      } catch {
        // If the retry also fails, that department is left without an
        // audit; the stage still proceeds and whatever was produced is saved.
      }
    }

    // If none succeeded, there's a real failure (quota, key, provider):
    // drop the stage to FAILED so it shows up in System Health.
    if (audits.length === 0) {
      throw new Error(
        `Failed to generate a baseline audit for any department (${AUDIT_DEPARTMENTS.length} attempts)`,
      );
    }

    return BaselineAuditRepository.upsertMany(scope, audits);
  },
};
