import "server-only";

import { prisma } from "@/lib/prisma";

// The language the brand-rule checker compiles its lexicon for. The chat agent
// and the alternatives route use the project's language with a "tr" fallback;
// the Server Actions that re-check a plan (save, pick, swap, schedule) must use
// the exact same value, or the server re-check is blind to the owner's main
// language (the Turkish lexicon loads only for "tr").
//
// Fails toward the stricter side: any lookup error answers "tr", which compiles
// the Turkish and the English lexicon together.
export const DEFAULT_RULE_LANGUAGE = "tr";

export async function brandRuleLanguageOf(projectId: string): Promise<string> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { language: true },
    });
    return project?.language || DEFAULT_RULE_LANGUAGE;
  } catch {
    return DEFAULT_RULE_LANGUAGE;
  }
}
