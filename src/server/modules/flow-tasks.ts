import "server-only";

import { prisma } from "@/lib/prisma";
import { taskFingerprint } from "@/server/agency/fingerprint";

// The Tasks that module flow cards run (docs/modules.md): the ones whose
// Command is a card (the Ads Manager's campaign), then each link the Meta chain
// relays plan after it with no Command, found by the fingerprint the relay gave
// it (meta-campaign-chain-relay.ts: the ad set's subject is the campaign Task;
// meta-adset-chain-relay.ts: the ad's subject is the ad set Task). The card
// shows their state and approvals in place, so the Work's chat does not repeat
// them under it. Read-only, tenant-scoped.

const CHAIN_DEPARTMENT = "PERFORMANCE_MARKETING";

const NEXT_LINK: Readonly<Record<string, string>> = {
  META_CAMPAIGN_CREATE: "META_ADSET_CREATE",
  META_ADSET_CREATE: "META_AD_CREATE",
};

// Campaign, ad set, ad: the longest chain there is.
const MAX_LINKS = 3;

export async function moduleFlowTaskIds(
  projectId: string,
  cardCommandIds: readonly string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (cardCommandIds.length === 0) return ids;
  let links = await prisma.task.findMany({
    where: { projectId, commandId: { in: [...cardCommandIds] } },
    select: { id: true, capability: true },
  });
  for (let depth = 1; links.length > 0; depth += 1) {
    for (const task of links) ids.add(task.id);
    if (depth >= MAX_LINKS) break;
    const fingerprints = links.flatMap((task) => {
      const next = NEXT_LINK[task.capability];
      return next
        ? [
            taskFingerprint({
              capability: next,
              department: CHAIN_DEPARTMENT,
              subject: task.id,
            }),
          ]
        : [];
    });
    if (fingerprints.length === 0) break;
    links = await prisma.task.findMany({
      where: { projectId, fingerprint: { in: fingerprints } },
      select: { id: true, capability: true },
    });
  }
  return ids;
}
