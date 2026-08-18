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

    // allSettled, Promise.all değil: tek bir departmanın modeli kesik JSON
    // döndürmesi bütün partiyi çöpe atıyordu, hiçbir denetim kaydedilmiyordu
    // ve aşama baştan başlıyordu — %27 hata oranıyla aşama pratikte hiç
    // bitmiyor, her turda 19 çağrı yeniden harcanıyordu.
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

    // Kesik JSON geçici bir hata — başarısız departmanlara tek bir ek şans.
    for (const department of failed) {
      try {
        audits.push(await auditOne(department));
      } catch {
        // İkinci deneme de tuttursa o departman denetimsiz kalır; aşama
        // yine de ilerler ve elde edilenler kaydedilir.
      }
    }

    // Hiçbiri tutmadıysa gerçek bir arıza var (kota, anahtar, sağlayıcı):
    // aşamayı FAILED'a düşür ki Sistem Sağlığı'nda görünsün.
    if (audits.length === 0) {
      throw new Error(
        `Hiçbir departman için temel denetim üretilemedi (${AUDIT_DEPARTMENTS.length} deneme)`,
      );
    }

    return BaselineAuditRepository.upsertMany(scope, audits);
  },
};
