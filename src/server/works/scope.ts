import "server-only";

import { prisma } from "@/lib/prisma";

// The Work of the Command that started each task, plus the task's capability.
// A task with no Command or a Command without a Work has workId null
// (legacy / background; the performance scanner's spend proposals are these).
export type TaskOwner = { workId: string | null; capability: string };

export async function workOwnersByTask(
  projectId: string,
  taskIds: readonly string[],
): Promise<Map<string, TaskOwner>> {
  const map = new Map<string, TaskOwner>();
  if (taskIds.length === 0) return map;
  const rows = await prisma.task.findMany({
    where: { id: { in: [...taskIds] }, projectId },
    select: {
      id: true,
      capability: true,
      command: { select: { workId: true } },
    },
  });
  for (const row of rows) {
    map.set(row.id, {
      workId: row.command?.workId ?? null,
      capability: row.capability,
    });
  }
  return map;
}

// Which Work each task was started in: the Work of the Command that started it.
// Used to keep a Work's conversation to its own decisions.
export async function workIdsByTask(
  projectId: string,
  taskIds: readonly string[],
): Promise<Map<string, string | null>> {
  const owners = await workOwnersByTask(projectId, taskIds);
  return new Map(
    [...owners].map(([taskId, owner]) => [taskId, owner.workId] as const),
  );
}

// A pending decision belongs in this Work's conversation when its task was
// started here, or when it has no Work at all (taskless or background: it still
// needs an answer, so it shows wherever the client is).
export function decisionBelongsTo(
  workId: string,
  taskId: string | undefined,
  workIds: ReadonlyMap<string, string | null>,
): boolean {
  if (!taskId) return true;
  const owner = workIds.get(taskId);
  return owner === undefined || owner === null || owner === workId;
}

// Real-money Meta proposals made by the performance scanner have no Command,
// so they have no Work. They must never become unreachable.
const SPEND_CAPABILITY_PREFIX = "META_";

// Works version of decisionBelongsTo. Owned decisions keep strict scoping.
// An unowned META_* spend decision belongs to a Work that chose ads, to the
// Today Work, or to EVERY Work when no ACTIVE Work covers ads. Other unowned
// decisions keep showing everywhere.
export function decisionBelongsToWork(input: {
  workId: string;
  channels: readonly string[];
  isToday: boolean;
  taskId?: string;
  owner?: { workId: string | null; capability: string } | undefined;
  anyActiveWorkCoversAds: boolean;
}): boolean {
  if (!input.taskId) return true;
  const owner = input.owner;
  if (owner === undefined) return true;
  if (owner.workId !== null) return owner.workId === input.workId;
  if (!owner.capability.startsWith(SPEND_CAPABILITY_PREFIX)) return true;
  return (
    input.isToday ||
    input.channels.includes("ads") ||
    !input.anyActiveWorkCoversAds
  );
}
