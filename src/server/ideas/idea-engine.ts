import "server-only";

import {
  ideaFingerprint,
  isExpired,
  type IdeaConcept,
} from "@/lib/ideas/concept";
import { normalizeSocialIdeas } from "@/lib/ideas/normalize";
import { blocksOf, checkText } from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull } from "@/lib/works/clean-text";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { ideaSocialDef } from "@/server/reasoning/prompts/idea-social";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { AgentelseError } from "@/server/security/errors";
import { loadBrandRules } from "@/server/works/brand-rule-loader";
import {
  ideaMemoryOf,
  loadIdeaContext,
  type IdeaRow,
} from "@/server/ideas/idea-context";

// The idea engine (docs/ideas.md): one lite model call writes a batch of
// ready-to-make post ideas from everything the brand knows, the server cleans
// them, drops what breaks a brand rule or repeats the pool or a recent post,
// makes room in a full pool by retiring the oldest untouched ideas, and saves
// the rest as typed ideas (VALIDATED, Idea.concept v2). Called on demand (the
// board's Generate ideas, Another angle, an opportunity's Turn into ideas) and
// by the pool refill (idea-refill.ts).

// The pool keeps about this many fresh ideas of a module, and is topped up
// once it falls below the low-water mark.
export const IDEA_POOL_TARGET = 20;
export const IDEA_LOW_WATER = 8;
// At most this many ideas per model call.
export const IDEAS_PER_CALL = 6;

export type IdeaTrigger =
  "manual" | "refill" | "opportunity" | "angle" | "chat";

export type GenerateIdeasInput = {
  projectId: string;
  count: number;
  trigger: IdeaTrigger;
  // What the ideas should be about (the board's "About…", an opportunity, the
  // idea "Another angle" starts from).
  focus?: string;
  relatedIdeaId?: string;
  opportunityId?: string;
  now?: Date;
};

export type GenerateIdeasResult =
  | { ok: true; created: string[]; rotated: number }
  | { ok: false; reason: "NO_BRAND" | "BUDGET" | "FULL" | "EMPTY" };

// Ideas the engine may retire to make room: typed ideas still waiting
// untouched (never a saved, planned or older untyped one), expired first,
// then the oldest.
export function rotationCandidates(
  rows: readonly IdeaRow[],
  needed: number,
  now: Date,
): string[] {
  if (needed <= 0) return [];
  return rows
    .filter((row) => row.status === "VALIDATED" && row.concept !== null)
    .sort((a, b) => {
      const expired =
        Number(isExpired(b.concept, now)) - Number(isExpired(a.concept, now));
      return expired || a.createdAt.getTime() - b.createdAt.getTime();
    })
    .slice(0, needed)
    .map((row) => row.id);
}

function brandSafe(
  concept: IdeaConcept,
  rules: Parameters<typeof checkText>[1],
): boolean {
  if (concept.module !== "social") return true;
  const { hook, headline, caption } = concept.draft;
  return (
    blocksOf(checkText(`${hook}\n${headline}\n${caption}`, rules)).length === 0
  );
}

export const IdeaEngine = {
  async generate(input: GenerateIdeasInput): Promise<GenerateIdeasResult> {
    const now = input.now ?? new Date();
    const ctx = await loadIdeaContext({ projectId: input.projectId, now });
    if (!ctx) return { ok: false, reason: "NO_BRAND" };
    const scope = {
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      brandId: ctx.brandId,
    };
    const count = Math.min(
      Math.max(1, Math.round(input.count)),
      IDEAS_PER_CALL + 2,
    );
    // Room first: a pool full of saved, planned or older ideas has nothing
    // to retire, and a model call for ideas that cannot be saved is never
    // paid for.
    const capacity = await poolCapacity({
      scope,
      rows: ctx.ideas,
      isMock: ReasoningService.isMockMode(),
      now,
      wanted: count,
    });
    const fits = Math.min(count, capacity.free + capacity.retire.length);
    if (fits <= 0) return { ok: false, reason: "FULL" };
    const focus = cleanWorksTextOrNull(input.focus, 300);
    const memory = ideaMemoryOf(ctx.ideas);

    const run = await ReasoningService.run(ideaSocialDef, {
      ...scope,
      context: {
        count: fits,
        today: ctx.today,
        timezone: ctx.timezone,
        brand: ctx.brand,
        channels: ctx.channels,
        layouts: ctx.layouts,
        // The model refers to a signal by its number; the link stays here.
        signals: ctx.signals.map((signal) => ({
          n: signal.n,
          title: signal.title,
          ...(signal.summary ? { summary: signal.summary } : {}),
          ...(signal.when ? { when: signal.when } : {}),
        })),
        opportunities: ctx.opportunities,
        postResults: ctx.postResults,
        saved: memory.saved,
        dismissed: memory.dismissed,
        recentPosts: ctx.recentPosts.slice(0, 20),
        pool: memory.pool.slice(0, 40),
        ...(focus ? { focus } : {}),
      },
    }).catch((error: unknown) => {
      if (error instanceof AgentelseError && error.code === "BUDGET_EXCEEDED") {
        return null;
      }
      throw error;
    });
    if (!run) return { ok: false, reason: "BUDGET" };
    const { output, isMock } = run;

    const concepts = normalizeSocialIdeas(output.ideas, {
      channels: ctx.channels,
      layoutIds: ctx.layouts.map((layout) => layout.id),
      signals: ctx.signals,
      today: ctx.today,
      timezone: ctx.timezone,
      ...(input.trigger === "opportunity"
        ? { source: "opportunity" as const }
        : input.trigger === "chat"
          ? { source: "chat" as const }
          : {}),
      ...(input.relatedIdeaId ? { relatedIdeaId: input.relatedIdeaId } : {}),
      avoid: [...memory.pool, ...ctx.recentPosts],
    }).slice(0, fits);

    const language = await brandRuleLanguageOf(input.projectId);
    const rules = await loadBrandRules({
      projectId: input.projectId,
      brandId: ctx.brandId,
      language,
    });
    const safe = concepts.filter((concept) => brandSafe(concept, rules));
    if (safe.length === 0) return { ok: false, reason: "EMPTY" };

    return saveIdeaConcepts({
      scope,
      concepts: safe,
      rows: ctx.ideas,
      isMock,
      now,
      ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
    });
  },
};

// The title and line an idea row carries for its older readers (the chat's
// pool, the Brand Brain): the thing it becomes, in one line and a sentence.
export function rowTextOf(concept: IdeaConcept): {
  title: string;
  description: string;
} {
  switch (concept.module) {
    case "social":
      return { title: concept.draft.hook, description: concept.draft.caption };
    case "seo":
      return {
        title: concept.draft.title,
        description: concept.draft.description,
      };
    case "ads":
      return {
        title: concept.draft.angle,
        description: concept.why ?? concept.draft.angle,
      };
  }
}

type PoolScope = { workspaceId: string; projectId: string; brandId: string };

// How many new ideas the pool takes now: the free places under the pool size
// (Settings -> Autonomy "Idea pool size"), then the untouched typed ideas a
// full pool may retire for them (`retire`, at most what is missing). A run
// only counts and retires ideas of its own kind: a mock run (the dev database
// is shared) never archives a real idea, and a real run neither counts nor
// archives a mock one.
export async function poolCapacity(input: {
  scope: PoolScope;
  rows: readonly IdeaRow[];
  isMock: boolean;
  now: Date;
  wanted: number;
}): Promise<{ free: number; retire: string[] }> {
  const policy = await AutonomyPolicyRepository.getOrCreate(input.scope);
  if (policy.unlimitedMode) return { free: input.wanted, retire: [] };
  const active = await IdeaRepository.countActive(input.scope.projectId, {
    isMock: input.isMock,
  });
  const free = Math.max(0, policy.maxActiveIdeas - active);
  const own = input.rows.filter((row) => row.isMock === input.isMock);
  return {
    free,
    retire: rotationCandidates(own, input.wanted - free, input.now),
  };
}

// Saves typed ideas into the pool: room first (poolCapacity: a full pool
// retires its oldest untouched typed ideas), then each idea as VALIDATED with
// its concept and fingerprint.
export async function saveIdeaConcepts(input: {
  scope: PoolScope;
  concepts: readonly IdeaConcept[];
  rows: readonly IdeaRow[];
  isMock: boolean;
  now: Date;
  opportunityId?: string;
}): Promise<GenerateIdeasResult> {
  const { scope, concepts, now } = input;
  if (concepts.length === 0) return { ok: false, reason: "EMPTY" };
  const capacity = await poolCapacity({
    scope,
    rows: input.rows,
    isMock: input.isMock,
    now,
    wanted: concepts.length,
  });
  let room = Math.min(concepts.length, capacity.free);
  let rotated = 0;
  for (const id of capacity.retire) {
    try {
      await IdeaRepository.transition(id, scope.projectId, "ARCHIVED");
      rotated += 1;
    } catch (error) {
      console.error(
        `[idea-engine] could not retire idea ${id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  room += rotated;
  const keep = concepts.slice(0, room);
  if (keep.length === 0) return { ok: false, reason: "FULL" };

  const created: string[] = [];
  for (const concept of keep) {
    const idea = await IdeaRepository.create({
      ...scope,
      ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
      ...rowTextOf(concept),
      concept,
      fingerprint: ideaFingerprint(concept),
      isMock: input.isMock,
      status: "VALIDATED",
    });
    created.push(idea.id);
  }
  await AutonomyPolicyRepository.checkAndIncrement(
    scope,
    "ideasCreated",
    created.length,
  ).catch(() => undefined);
  return { ok: true, created, rotated };
}
