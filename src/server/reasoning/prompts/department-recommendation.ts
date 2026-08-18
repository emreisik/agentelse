import { z } from "zod";

import type { ReasoningDef } from "../types";

export const DepartmentRecommendationSchema = z.object({
  departments: z.array(
    z.object({
      department: z.string(),
      mode: z.enum(["OFF", "LISTEN", "SUGGEST", "PREPARE", "EXECUTE"]),
      rationale: z.string(),
    }),
  ),
});

export type DepartmentRecommendationOutput = z.infer<
  typeof DepartmentRecommendationSchema
>;

export const departmentRecommendationDef: ReasoningDef<DepartmentRecommendationOutput> =
  {
    purpose: "department.recommend",
    schema: DepartmentRecommendationSchema,
    // 2048'de MAX_TOKENS'a takılıp JSON'u yarıda kesiyordu (19 departmanın
    // hepsi için rationale metniyle) — constitution-synthesis.ts'teki aynı
    // sorunun notu: "thinking" token'ları da bu bütçeden düşüyor, çıktı
    // metni küçük görünse bile bütçe hızla tükeniyor. Aynı kalıp
    // signal-profile-recommendation.ts'te de var, orada da yükseltildi.
    maxTokens: 8192,

    buildPrompt(context) {
      return {
        system:
          "You configure the department modules of an AI agency for a brand. " +
          `Departments: ${JSON.stringify(context.departments ?? [])}. ` +
          "Modes: OFF (never runs), LISTEN (collects signals only), SUGGEST " +
          "(also proposes opportunities/ideas), PREPARE (prepares work, waits " +
          "for approval), EXECUTE (completes work where policy allows). " +
          "Intelligence departments usually EXECUTE; externally visible " +
          "departments usually PREPARE; niche ones LISTEN or OFF.",
        user:
          `Brand context:\n${JSON.stringify(context.brand ?? {}, null, 2)}\n\n` +
          `Baseline audits:\n${JSON.stringify(context.audits ?? [], null, 2)}\n\n` +
          "Recommend a mode per department.",
      };
    },

    buildMock(context) {
      const departments = (context.departments ?? []) as string[];
      const defaults: Record<
        string,
        "OFF" | "LISTEN" | "SUGGEST" | "PREPARE" | "EXECUTE"
      > = {
        BRAND_STRATEGY: "EXECUTE",
        MARKET_INTELLIGENCE: "EXECUTE",
        CUSTOMER_INTELLIGENCE: "EXECUTE",
        COMPETITOR_INTELLIGENCE: "EXECUTE",
        DATA_ANALYTICS: "EXECUTE",
        CREATIVE: "PREPARE",
        ART_DIRECTION: "PREPARE",
        COPY_CONTENT: "PREPARE",
        SOCIAL_MEDIA: "PREPARE",
        SEO: "PREPARE",
        WEB_PRODUCT: "PREPARE",
        GROWTH: "PREPARE",
        PERFORMANCE_MARKETING: "SUGGEST",
        PR_MEDIA: "SUGGEST",
        INFLUENCER_CREATOR: "LISTEN",
        PARTNERSHIPS: "LISTEN",
        CRM_LIFECYCLE: "LISTEN",
        EVENTS: "OFF",
        OFFLINE_MEDIA: "OFF",
      };
      return {
        departments: departments.map((department) => ({
          department,
          mode: defaults[department] ?? "LISTEN",
          rationale: `Mock recommendation for ${department} from standard agency posture`,
        })),
      };
    },
  };
