import "server-only";

import { parseIdeaConcept } from "@/lib/ideas/concept";
import type { CreativeOrigin } from "@/lib/ads/lineage";
import { prisma } from "@/lib/prisma";

// Reklamın çıktığı postun fikir kökeni (docs/meta-ads-autonomy.md): reklam →
// Creative → Post → Idea zincirini çözer. Bir lansmanı asla bozmaz: okuma
// hatasında kökensiz döner (reklam yine metin etiketlerini taşır).
export async function loadCreativeOrigins(
  projectId: string,
  creativeIds: readonly string[],
): Promise<Record<string, CreativeOrigin>> {
  const ids = [...new Set(creativeIds)];
  if (ids.length === 0) return {};
  try {
    const creatives = await prisma.creative.findMany({
      where: { id: { in: ids }, projectId },
      select: { id: true, postId: true },
    });
    const postIds = [
      ...new Set(creatives.map((c) => c.postId).filter((v): v is string => !!v)),
    ];
    const posts = postIds.length
      ? await prisma.post.findMany({
          where: { id: { in: postIds }, projectId },
          select: { id: true, ideaId: true, topic: true },
        })
      : [];
    const ideaIds = [
      ...new Set(posts.map((p) => p.ideaId).filter((v): v is string => !!v)),
    ];
    const ideas = ideaIds.length
      ? await prisma.idea.findMany({
          where: { id: { in: ideaIds }, projectId },
          select: { id: true, concept: true },
        })
      : [];
    const postById = new Map(posts.map((p) => [p.id, p]));
    const ideaById = new Map(ideas.map((i) => [i.id, i]));

    const origins: Record<string, CreativeOrigin> = {};
    for (const creative of creatives) {
      const post = creative.postId ? postById.get(creative.postId) : undefined;
      const idea = post?.ideaId ? ideaById.get(post.ideaId) : undefined;
      const concept = idea ? parseIdeaConcept(idea.concept) : null;
      let angle: string | undefined = post?.topic ?? undefined;
      let pillar: string | undefined;
      if (concept?.module === "social") {
        angle = concept.draft.hook;
        pillar = concept.draft.pillar;
      } else if (concept?.module === "ads") {
        angle = concept.draft.angle;
      }
      origins[creative.id] = {
        ...(post ? { postId: post.id } : {}),
        ...(idea ? { ideaId: idea.id } : {}),
        ...(angle ? { angle } : {}),
        ...(pillar ? { pillar } : {}),
        ...(concept ? { ideaSource: concept.source } : {}),
      };
    }
    return origins;
  } catch (error) {
    console.warn(
      `[ads] lineage lookup failed, launching without idea origins: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}
