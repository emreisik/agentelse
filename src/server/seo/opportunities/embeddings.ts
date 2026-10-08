import "server-only";

import OpenAI from "openai";
import type { GscSiteLink } from "@prisma/client";

import { getEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { isFuzzyBrandQuery } from "@/lib/seo/brand-fuzzy";
import {
  effectiveBrandTerms,
  parseBrandTermsConfig,
} from "@/lib/seo/brand-terms";
import { addWeeks } from "@/lib/seo/dates";
import {
  SEO_EMBEDDING_DIMS,
  encodeVector,
  mockEmbedding,
} from "@/lib/seo/vector";
import { recordUsage } from "@/server/billing/usage-recorder";
import { maskGoogleText } from "@/server/integrations/google/pii";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
import { AgentelseError } from "@/server/security/errors";

import type { SeoScope } from "./classify";

// Sorgu embedding'leri (docs/search-opportunities.md "Konu kümeleri", SK13):
// marka dışı ve 13 haftada ≥ 10 gösterim alan her sorgu için bir kez,
// maskelenmiş metin OpenAI text-embedding-3-small'a (256 boyut) gider. Koşu
// başına ≤ 10 istek × 100 sorgu. Bütçe ReasoningService ile aynı günlük
// sayaçtan düşer, her çağrı ReasoningCall'a yazılır ("seo.embed"). Mock
// kipte SDK hiç kurulmaz, deterministik vektör kullanılır. Sorgu metni
// günlüğe yazılmaz.

export const SEO_EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBED_BATCH = 100;
export const EMBED_REQUESTS_PER_RUN = 10;
export const EMBED_MAX_QUERIES = 2000;
export const EMBED_MIN_IMPRESSIONS = 10;
export const EMBED_USD_PER_MTOKEN = 0.02;

const PURPOSE = "seo.embed";
const HISTORY_WEEKS = 13;
const MOCK_MODEL = "mock";

let client: OpenAI | undefined;

function sdk(apiKey: string): OpenAI {
  client ??= new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  return client;
}

export function seoEmbeddingsMock(): boolean {
  return gscMockMode() || process.env.AGENTELSE_REASONING_MODE === "mock";
}

function isBudgetError(error: unknown): boolean {
  return error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED";
}

// Hata günlüğü: yalnız sınıf adı ve HTTP durumu (metin yok).
function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === "number" ? `${name} (${status})` : name;
}

export async function embedTexts(
  texts: readonly string[],
  scope: SeoScope,
): Promise<{ vectors: Float32Array[] | null; budgetHit: boolean }> {
  if (texts.length === 0) return { vectors: [], budgetHit: false };
  const mock = seoEmbeddingsMock();
  const apiKey = mock ? "" : getEnv().OPENAI_API_KEY;
  if (!mock && !apiKey) return { vectors: null, budgetHit: false };

  // Bütçe kapısı önce: mock çağrı da sayılır (ReasoningService gibi).
  try {
    await AutonomyPolicyRepository.checkAndIncrement(scope, "reasoningCalls");
  } catch (error) {
    if (isBudgetError(error)) return { vectors: null, budgetHit: true };
    throw error;
  }

  const startedAt = Date.now();
  if (mock) {
    await ReasoningCallRepository.record({
      ...scope,
      purpose: PURPOSE,
      model: MOCK_MODEL,
      isMock: true,
      costUsd: 0,
      durationMs: Date.now() - startedAt,
      status: "OK",
    });
    return {
      vectors: texts.map((text) => mockEmbedding(text, SEO_EMBEDDING_DIMS)),
      budgetHit: false,
    };
  }

  try {
    const response = await sdk(apiKey).embeddings.create({
      model: SEO_EMBEDDING_MODEL,
      input: [...texts],
      dimensions: SEO_EMBEDDING_DIMS,
    });
    const vectors: (Float32Array | null)[] = texts.map(() => null);
    for (const item of response.data) {
      if (item.index >= 0 && item.index < vectors.length) {
        vectors[item.index] = Float32Array.from(item.embedding);
      }
    }
    const tokens = response.usage?.total_tokens ?? 0;
    const costUsd = (tokens / 1_000_000) * EMBED_USD_PER_MTOKEN;
    await recordUsage({
      kind: "EMBED",
      provider: "openai",
      model: SEO_EMBEDDING_MODEL,
      purpose: PURPOSE,
      costUsd,
      costEstimated: response.usage?.total_tokens === undefined,
      success: true,
      durationMs: Date.now() - startedAt,
      inputTokens: tokens,
      units: texts.length,
      scope: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        source: "embeddings",
        module: "SEO",
      },
    });
    await ReasoningCallRepository.record({
      ...scope,
      purpose: PURPOSE,
      model: SEO_EMBEDDING_MODEL,
      isMock: false,
      inputTokens: tokens,
      outputTokens: 0,
      costUsd,
      durationMs: Date.now() - startedAt,
      status: "OK",
    });
    if (costUsd > 0) {
      await AutonomyPolicyRepository.checkAndIncrement(
        scope,
        "reasoningCalls",
        0,
        costUsd,
      ).catch(() => undefined);
    }
    if (vectors.some((vector) => vector === null)) {
      return { vectors: null, budgetHit: false };
    }
    return { vectors: vectors as Float32Array[], budgetHit: false };
  } catch (error) {
    const label = errorLabel(error);
    await ReasoningCallRepository.record({
      ...scope,
      purpose: PURPOSE,
      model: SEO_EMBEDDING_MODEL,
      isMock: false,
      durationMs: Date.now() - startedAt,
      status: "ERROR",
      errorMessage: label,
    }).catch(() => undefined);
    console.warn(`[seo-opportunities] embeddings failed: ${label}`);
    return { vectors: null, budgetHit: false };
  }
}

type PendingSqlRow = {
  id: string;
  text: string;
  impressions: bigint | number | null;
};

export async function embedPendingQueries(input: {
  link: Pick<GscSiteLink, "id" | "projectId">;
  scope: SeoScope | null;
  week: string;
  deadline: number;
  now: Date;
}): Promise<{ embedded: number; budgetHit: boolean }> {
  const { link, scope } = input;
  if (!scope) return { embedded: 0, budgetHit: false };
  const config = await prisma.gscSiteLink.findUnique({
    where: { id: link.id },
    select: { brandTerms: true },
  });
  const terms = effectiveBrandTerms(parseBrandTermsConfig(config?.brandTerms));
  const rows = await prisma.$queryRaw<PendingSqlRow[]>`
    SELECT q."id", q."text", SUM(w."impressions")::bigint AS "impressions"
      FROM "GscQuery" q
      JOIN "GscWeeklyQuery" w ON w."queryId" = q."id"
     WHERE q."linkId" = ${link.id}
       AND q."isBrand" = false
       AND w."weekStart" BETWEEN ${addWeeks(input.week, -(HISTORY_WEEKS - 1))}::date AND ${input.week}::date
       AND NOT EXISTS (
         SELECT 1 FROM "SeoQueryEmbedding" e WHERE e."queryId" = q."id"
       )
     GROUP BY q."id"
    HAVING SUM(w."impressions") >= ${EMBED_MIN_IMPRESSIONS}
     ORDER BY "impressions" DESC, q."id" ASC
     LIMIT ${EMBED_MAX_QUERIES}
  `;
  const pending = rows.filter((row) => !isFuzzyBrandQuery(row.text, terms));

  const mock = seoEmbeddingsMock();
  let embedded = 0;
  let budgetHit = false;
  let requests = 0;
  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    if (requests >= EMBED_REQUESTS_PER_RUN || Date.now() >= input.deadline) {
      break;
    }
    const batch = pending.slice(start, start + EMBED_BATCH);
    requests += 1;
    const result = await embedTexts(
      batch.map((row) => maskGoogleText(row.text)),
      scope,
    );
    if (result.budgetHit) budgetHit = true;
    if (!result.vectors) break;
    const vectors = result.vectors;
    const created = await prisma.seoQueryEmbedding.createMany({
      data: batch.map((row, index) => ({
        linkId: link.id,
        projectId: link.projectId,
        queryId: row.id,
        model: mock ? MOCK_MODEL : SEO_EMBEDDING_MODEL,
        dims: SEO_EMBEDDING_DIMS,
        vector: encodeVector(vectors[index]!),
      })),
      skipDuplicates: true,
    });
    embedded += created.count;
  }
  if (requests > 0) {
    await prisma.seoEngineState.updateMany({
      where: { linkId: link.id },
      data: { embeddedAt: input.now },
    });
  }
  return { embedded, budgetHit };
}
