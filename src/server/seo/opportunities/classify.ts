import "server-only";

import { Prisma, type GscSiteLink } from "@prisma/client";

import { SEO_INTENTS } from "@/lib/ideas/concept";
import { prisma } from "@/lib/prisma";
import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import { addWeeks, gscToday, weekStartOf } from "@/lib/seo/dates";
import { ruleIntent } from "@/lib/seo/intent";
import { detectQueryLanguage } from "@/lib/seo/query-language";
import { maskGoogleText } from "@/server/integrations/google/pii";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import {
  SEO_INTENT_BATCH,
  seoIntentDef,
} from "@/server/reasoning/prompts/seo-intent";
import { AgentelseError } from "@/server/security/errors";

// Sorgu niyeti ve dili (docs/search-opportunities.md "Sınıflayıcılar"):
// önce kurallar (marka = W1 isBrand ya da bulanık eşleşme → navigational).
// Kuralın karar veremediği ve 13 haftada ≥ 50 gösterim alan sorgular lite
// LLM'e gider: çağrı başına ≤ 20 maskelenmiş sorgu, koşu başına ≤ 5 çağrı.
// Gönderilemeyenler NULL kalır ve sonraki koşuda yeniden denenir; < 50
// gösterimliler "informational" olur. Dil her satıra yazılır. Marka terimleri
// değişince (brandClassifiedHash) navigational ve marka satırları sıfırlanır.

export type SeoScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

const SELECT_LIMIT = 2_000;
const LLM_MIN_IMPRESSIONS = 50;
const LLM_MAX_CALLS = 5;
const HISTORY_WEEKS = 13;
const UPDATE_CHUNK = 500;

type SeoIntent = (typeof SEO_INTENTS)[number];

const INTENT_SET: ReadonlySet<string> = new Set(SEO_INTENTS);

function isIntent(value: unknown): value is SeoIntent {
  return typeof value === "string" && INTENT_SET.has(value);
}

export async function scopeForProject(
  projectId: string,
): Promise<SeoScope | null> {
  const [project, brand] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    }),
    prisma.brand.findFirst({
      where: { projectId, isDefault: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }),
  ]);
  if (!project || !brand) return null;
  return { workspaceId: project.workspaceId, projectId, brandId: brand.id };
}

type PendingSqlRow = {
  id: string;
  text: string;
  isBrand: boolean;
  impressions: bigint | number | null;
};

type Classified = {
  id: string;
  intent: SeoIntent | null;
  language: string | null;
};

function isBudgetError(error: unknown): boolean {
  return error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED";
}

export async function classifyQueries(input: {
  link: Pick<
    GscSiteLink,
    "id" | "projectId" | "brandTerms" | "brandClassifiedHash"
  >;
  stateId: string;
  intentBrandHash: string | null;
  scope: SeoScope | null;
  deadline: number;
  now: Date;
}): Promise<{ classified: number; llmCalls: number; budgetHit: boolean }> {
  const { link } = input;

  // Marka terimleri değişti: navigational ve marka satırları yeniden sınıflanır.
  if (link.brandClassifiedHash !== input.intentBrandHash) {
    await prisma.gscQuery.updateMany({
      where: {
        linkId: link.id,
        OR: [{ intent: "navigational" }, { isBrand: true }],
      },
      data: { intent: null },
    });
    await prisma.seoEngineState.update({
      where: { id: input.stateId },
      data: { intentBrandHash: link.brandClassifiedHash },
    });
  }

  const since = addWeeks(weekStartOf(gscToday(input.now)), -HISTORY_WEEKS);
  const rows = await prisma.$queryRaw<PendingSqlRow[]>`
    SELECT q."id", q."text", q."isBrand",
           COALESCE(SUM(w."impressions"), 0)::bigint AS "impressions"
      FROM "GscQuery" q
      LEFT JOIN "GscWeeklyQuery" w
        ON w."queryId" = q."id" AND w."weekStart" >= ${since}::date
     WHERE q."linkId" = ${link.id}
       AND q."intent" IS NULL
     GROUP BY q."id"
     ORDER BY q."lastSeenWeek" DESC, q."id" ASC
     LIMIT ${SELECT_LIMIT}
  `;
  if (rows.length === 0)
    return { classified: 0, llmCalls: 0, budgetHit: false };

  const terms = effectiveBrandTerms(parseBrandTermsConfig(link.brandTerms));
  const results: Classified[] = [];
  const leftovers: { index: number; text: string }[] = [];
  for (const row of rows) {
    const brand = row.isBrand || isFuzzyBrandQuery(row.text, terms);
    const intent = ruleIntent(row.text, { isBrand: brand });
    const index = results.length;
    results.push({
      id: row.id,
      intent,
      language: detectQueryLanguage(row.text),
    });
    if (intent === null) {
      if (Number(row.impressions ?? 0) >= LLM_MIN_IMPRESSIONS) {
        leftovers.push({ index, text: row.text });
      } else {
        results[index]!.intent = "informational";
      }
    }
  }

  // LLM: ≤ 5 çağrı × ≤ 20 maskelenmiş sorgu, süre bitmeden.
  let llmCalls = 0;
  let budgetHit = false;
  if (input.scope) {
    for (
      let start = 0;
      start < leftovers.length && llmCalls < LLM_MAX_CALLS;
      start += SEO_INTENT_BATCH
    ) {
      if (Date.now() >= input.deadline) break;
      const batch = leftovers.slice(start, start + SEO_INTENT_BATCH);
      llmCalls += 1;
      try {
        const { output } = await ReasoningService.run(seoIntentDef, {
          ...input.scope,
          context: {
            queries: batch.map((item, i) => [i, maskGoogleText(item.text)]),
          },
        });
        for (const item of output.items) {
          const target = Number.isInteger(item.i) ? batch[item.i] : undefined;
          if (!target || !isIntent(item.intent)) continue;
          results[target.index]!.intent = item.intent;
        }
      } catch (error) {
        if (isBudgetError(error)) {
          budgetHit = true;
          break;
        }
        // Sorgu metni günlüğe yazılmaz; kalanlar sonraki koşuda denenir.
        console.warn(
          "[seo-opportunities] intent classification failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        break;
      }
    }
  }

  for (let start = 0; start < results.length; start += UPDATE_CHUNK) {
    const values = results
      .slice(start, start + UPDATE_CHUNK)
      .map(
        (item) =>
          Prisma.sql`(${item.id}::text, ${item.intent}::text, ${item.language}::text)`,
      );
    await prisma.$executeRaw`
      UPDATE "GscQuery" AS q
         SET "intent" = v."intent", "language" = v."language"
        FROM (VALUES ${Prisma.join(values)}) AS v("id", "intent", "language")
       WHERE q."id" = v."id"
         AND q."linkId" = ${link.id}
    `;
  }
  await prisma.seoEngineState.update({
    where: { id: input.stateId },
    data: { classifiedAt: input.now },
  });
  return {
    classified: results.filter((item) => item.intent !== null).length,
    llmCalls,
    budgetHit,
  };
}
