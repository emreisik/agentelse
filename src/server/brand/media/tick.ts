import "server-only";

import { MEDIA_ANALYSIS_VERSION } from "@/lib/brand-media";
import { prisma } from "@/lib/prisma";
import { analyzeBrandMedia } from "@/server/brand/media/analyze";
import { adoptExistingPhotos } from "@/server/brand/media/store";

// The worker's part of the media library: analyse the photos that are waiting
// (new uploads, retries after a failure or the AI budget, a library analysed by
// an older version), and bring in uploads that predate the library. Small steps
// per tick so one big upload never holds the worker.

const PER_TICK = 4;
const ADOPT_EVERY_MS = 30 * 60_000;
let lastAdopt = 0;

export async function runDueMediaAnalysis(
  limit = PER_TICK,
  now = new Date(),
): Promise<number> {
  if (now.getTime() - lastAdopt > ADOPT_EVERY_MS) {
    lastAdopt = now.getTime();
    await adoptExistingPhotos().catch((error) =>
      console.error("[brand-media] adopting existing photos failed:", error),
    );
  }

  const due = await prisma.brandMedia.findMany({
    where: {
      kind: "IMAGE",
      archivedAt: null,
      OR: [
        {
          status: "PENDING",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        // Analysed by an older version: read again.
        { status: "OK", version: { lt: MEDIA_ANALYSIS_VERSION } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let done = 0;
  for (const media of due) {
    if ((await analyzeBrandMedia(media.id, now)) === "ok") done += 1;
  }
  return done;
}
