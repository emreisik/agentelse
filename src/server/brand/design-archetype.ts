import "server-only";

import { prisma } from "@/lib/prisma";
import type { Archetype } from "@/lib/auto-layout";
import { archetypeOfBrandContext } from "@/lib/brand-archetype";

// The design a brand's posts follow when nobody picked one (src/lib/auto-layout.ts), read from what the
// brand has written about itself. Best-effort: any failure is "editorial",
// the safe default, so a post is never held up by it.
export async function resolveArchetype(brandId: string): Promise<Archetype> {
  try {
    const [dossier, constitution, identity] = await Promise.all([
      prisma.brandDossier.findUnique({
        where: { brandId },
        select: {
          summary: true,
          positioning: true,
          products: true,
          services: true,
        },
      }),
      prisma.brandConstitution.findFirst({
        where: { brandId, status: "ACTIVE" },
        orderBy: { version: "desc" },
        select: { summary: true, payload: true },
      }),
      prisma.brandVisualIdentity.findUnique({
        where: { brandId },
        select: { moodTags: true },
      }),
    ]);
    return archetypeOfBrandContext({
      ...(dossier ?? {}),
      brandConstitution: constitution ?? null,
      visualIdentity: identity ?? null,
    });
  } catch {
    return "editorial";
  }
}
