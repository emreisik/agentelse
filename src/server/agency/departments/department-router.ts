import "server-only";

import type { CapabilityKey, DepartmentKey, DepartmentMode } from "@prisma/client";

import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { departmentRecommendationDef } from "@/server/reasoning/prompts/department-recommendation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BaselineAuditRepository } from "@/server/repositories/baseline-audit.repository";
import { ProjectDepartmentRepository } from "@/server/repositories/project-department.repository";

import { ALL_DEPARTMENT_KEYS, ownerOfCapability } from "./department-registry";

const VALID_MODES = new Set(["OFF", "LISTEN", "SUGGEST", "PREPARE", "EXECUTE"]);

export const DepartmentRouter = {
  ownerOf(capability: CapabilityKey): DepartmentKey | undefined {
    return ownerOfCapability(capability);
  },

  // Recommends a mode per department from constitution + audits (spec
  // section 15) and persists ProjectDepartment rows. mode starts equal to
  // recommendedMode; the client can change it later.
  async recommendModes(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
  }) {
    const [brand, audits] = await Promise.all([
      ConstitutionService.getBrandContext(scope.brandId),
      BaselineAuditRepository.listForProject(scope.projectId),
    ]);

    const { output } = await ReasoningService.run(departmentRecommendationDef, {
      ...scope,
      context: {
        brand,
        departments: ALL_DEPARTMENT_KEYS,
        audits: audits.map((a) => ({
          department: a.department,
          score: a.score,
          summary: a.summary,
        })),
      },
    });

    const byDepartment = new Map(
      output.departments.map((d) => [d.department, d]),
    );

    return ProjectDepartmentRepository.upsertMany(
      scope,
      ALL_DEPARTMENT_KEYS.map((department) => {
        const rec = byDepartment.get(department);
        const mode: DepartmentMode =
          rec && VALID_MODES.has(rec.mode)
            ? (rec.mode as DepartmentMode)
            : "LISTEN";
        return {
          department,
          mode,
          recommendedMode: mode,
          recommendationRationale: rec?.rationale,
        };
      }),
    );
  },

  // Department mode gate: may this department's work actually be created/
  // executed right now? PREPARE allows creating work that parks at approval;
  // EXECUTE allows full completion. SUGGEST/LISTEN/OFF create no tasks.
  async allowsTaskCreation(
    projectId: string,
    department: DepartmentKey,
  ): Promise<boolean> {
    const config = await ProjectDepartmentRepository.get(projectId, department);
    // Missing row (e.g. during setup before AGENCY_CONFIGURATION) defaults to
    // allowed — setup research must run before departments are configured.
    if (!config) return true;
    return config.mode === "PREPARE" || config.mode === "EXECUTE";
  },
};
