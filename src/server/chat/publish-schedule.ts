import "server-only";

import { cache } from "react";

import { prisma } from "@/lib/prisma";

// Whether anything releases approved posts on their day: the project's enabled
// Instagram publishing schedules. The chat page asks three times per render
// (the journey, the live card overlays, the pending decisions); cache() makes
// that one read. Outside a server render it is a plain pass-through.
export const countEnabledPublishSchedules = cache(
  (projectId: string): Promise<number> =>
    prisma.projectSchedule.count({
      where: { projectId, capability: "INSTAGRAM_PUBLISH", enabled: true },
    }),
);
