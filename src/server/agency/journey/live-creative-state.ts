import "server-only";

import { prisma } from "@/lib/prisma";
import type { ChannelConnections } from "@/lib/content-channels";
import {
  describePublishLine,
  type PublishLineInput,
} from "@/lib/works/publish-guard";
import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { ownedPlanIds } from "@/server/works/work-owned";
import { swapCurrentPicture } from "@/server/execution/variant-card";

// Read-time overlay (spec 3.6.4): the stored creative card is a snapshot, the
// Creative row is the truth. Nothing here is persisted.

export type LiveCreativeRow = {
  id: string;
  status: string;
  platform: string | null;
  channel: string | null;
  formatKey: string | null;
  scheduledFor: Date | null;
  planId: string | null;
  // Is the piece under the Works publish rules (Creative.planId -> Command.workId,
  // the server's own ownership rule)? false = a legacy piece (Studio, autopilot,
  // an older thread): the legacy "no time = publish now" rule still applies, so
  // the overlay must not promise a hold for it. Absent (hand-built rows) counts
  // as owned. loadLiveCreativeRows always sets it.
  owned?: boolean;
  version: { version: number; assetId: string | null } | null;
};

export type LiveInputs = {
  projectId: string;
  now: Date;
  timezone: string;
  connections: ChannelConnections;
  connectedPlatforms: ReadonlySet<string>;
  scheduleEnabled: boolean;
};

export async function loadLiveInputs(projectId: string): Promise<LiveInputs> {
  const [connections, scheduleCount, timezone] = await Promise.all([
    getChannelConnections(projectId).catch((): ChannelConnections => ({})),
    prisma.projectSchedule
      .count({
        where: { projectId, capability: "INSTAGRAM_PUBLISH", enabled: true },
      })
      .catch(() => 0),
    getProjectTimezone(projectId).catch(() => "Europe/Istanbul"),
  ]);
  const connectedPlatforms = new Set<string>(
    Object.entries(connections)
      .filter(([, connection]) => connection?.connected)
      .map(([key]) => key.toLowerCase()),
  );
  return {
    projectId,
    now: new Date(),
    timezone,
    connections,
    connectedPlatforms,
    scheduleEnabled: scheduleCount > 0,
  };
}

export async function loadLiveCreativeRows(
  projectId: string,
  creativeIds: string[],
): Promise<Map<string, LiveCreativeRow>> {
  const rows = new Map<string, LiveCreativeRow>();
  if (creativeIds.length === 0) return rows;
  try {
    const found = await prisma.creative.findMany({
      where: { id: { in: creativeIds }, projectId },
      select: {
        id: true,
        status: true,
        platform: true,
        channel: true,
        formatKey: true,
        scheduledFor: true,
        planId: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, assetId: true },
        },
      },
    });
    const ownedPlans = await ownedPlanIds(
      found.flatMap((row) => (row.planId ? [row.planId] : [])),
    );
    for (const row of found) {
      rows.set(row.id, {
        id: row.id,
        status: row.status,
        platform: row.platform,
        channel: row.channel,
        formatKey: row.formatKey,
        scheduledFor: row.scheduledFor,
        planId: row.planId,
        owned: row.planId !== null && ownedPlans.has(row.planId),
        version: row.versions[0] ?? null,
      });
    }
  } catch {
    return new Map();
  }
  return rows;
}

function stageOf(status: string): PublishLineInput["stage"] {
  if (status === "IN_REVIEW" || status === "DRAFT") return "IN_REVIEW";
  if (status === "APPROVED") return "APPROVED";
  if (status === "PUBLISHED") return "PUBLISHED";
  return "OTHER";
}

export function withLiveCreativeState(
  card: CreativeCardData,
  rows: ReadonlyMap<string, LiveCreativeRow>,
  inputs: LiveInputs,
  options?: { isNewestCard?: boolean },
): CreativeCardData {
  if (card.kind !== "creative-ready") return card;
  // The page archives older cards of a revised creative on purpose: never
  // revive them with the live row.
  if (options?.isNewestCard === false) return card;
  const row = rows.get(card.creativeId);
  if (!row) return card;

  const assetId = row.version?.assetId ?? card.assetId;
  // A legacy piece is published by the legacy rule (approved with no time and
  // no schedule goes live at once): a hold line would promise the opposite and
  // hiding approveIntent would drop the honest "Approve & publish" label.
  const publishLine =
    row.owned === false
      ? undefined
      : describePublishLine({
          stage: stageOf(row.status),
          facts: {
            status: row.status,
            platform: row.platform,
            formatKey: row.formatKey,
            hasAsset: Boolean(assetId),
            scheduledFor: row.scheduledFor,
            connectedPlatforms: inputs.connectedPlatforms,
            channel: row.channel,
            scheduleEnabled: inputs.scheduleEnabled,
          },
          publishState: card.publishState,
          publishError: card.publishError,
          now: inputs.now,
        });

  // The stored picture list can lag the live current picture (a failed best
  // effort patch after "Use this one"): keep the set exactly "every other
  // picture", never repeating the current one.
  const alternatives =
    card.alternatives && assetId
      ? swapCurrentPicture(card, assetId, card.assetId)
      : undefined;

  const next: CreativeCardData = {
    ...card,
    status: row.status,
    ...(alternatives ? { alternatives } : {}),
    ...(assetId ? { assetId } : {}),
    ...(row.version ? { versionNumber: row.version.version } : {}),
    ...(row.scheduledFor ? { plannedFor: row.scheduledFor.toISOString() } : {}),
    ...(publishLine ? { publishLine } : {}),
    // Only a piece under a Work can be given more pictures (the route checks
    // the plan's Work again).
    ...(row.planId && row.owned !== false ? { planId: row.planId } : {}),
  };
  // A publish line states the consequence itself; a stale "publish" intent
  // would promise "Approve & publish" for a piece the hold rule will hold.
  if (publishLine) delete next.approveIntent;
  return next;
}

export function withLiveConnections(
  card: IdeaEventCardData,
  connections: ChannelConnections,
): IdeaEventCardData {
  if (card.kind !== "content-plan-draft") return card;
  return { ...card, connections };
}
