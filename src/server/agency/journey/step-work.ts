import "server-only";

import { prisma } from "@/lib/prisma";
import {
  planIdOfStep,
  type JourneySnapshot,
  type NextStep,
} from "@/lib/journey";

// The Work that holds the plan a next step is about (the plan Command's
// workId), or undefined when the plan belongs to no Work (a plan from before
// Works) or the read fails. Used to link the calendar's banner to that chat:
// without it the link would open a new chat, where the step runs nothing.
export async function workIdOfStep(
  projectId: string,
  snapshot: JourneySnapshot,
  step: NextStep,
): Promise<string | undefined> {
  const planId = planIdOfStep(step, snapshot.items);
  if (!planId) return undefined;
  try {
    const plan = await prisma.command.findFirst({
      where: { id: planId, projectId },
      select: { workId: true },
    });
    return plan?.workId ?? undefined;
  } catch {
    return undefined;
  }
}
