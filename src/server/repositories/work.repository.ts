import "server-only";

import type { Prisma, WorkStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { ChannelKey } from "@/lib/content-channels";
import {
  TODAY_WORK_PREFIX,
  WORK_DEFAULT_TITLE,
  parseChannelKeys,
  todayWorkId,
  todayWorkTitle,
  type WorkView,
} from "@/lib/works/work";
import { isUniqueViolation } from "@/server/guided-setup/store";

// Every read and write takes the projectId: a Work id alone is never trusted,
// so a guessed id from another project matches nothing.

type WorkRow = {
  id: string;
  title: string;
  summary: string | null;
  status: WorkStatus;
  channels: Prisma.JsonValue;
  acknowledgedUnconnected: Prisma.JsonValue;
  lastActivityAt: Date;
};

const SELECT = {
  id: true,
  title: true,
  summary: true,
  status: true,
  channels: true,
  acknowledgedUnconnected: true,
  lastActivityAt: true,
} as const;

export function toWorkView(row: WorkRow): WorkView {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    channels: parseChannelKeys(row.channels),
    acknowledgedUnconnected: parseChannelKeys(row.acknowledgedUnconnected),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

export const WorkRepository = {
  async create(input: {
    workspaceId: string;
    projectId: string;
    createdByUserId?: string;
    title?: string;
    channels?: ChannelKey[];
    acknowledgedUnconnected?: ChannelKey[];
  }): Promise<WorkView> {
    const row = await prisma.work.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        title: input.title?.trim() || WORK_DEFAULT_TITLE,
        channels: input.channels ?? [],
        acknowledgedUnconnected: input.acknowledgedUnconnected ?? [],
      },
      select: SELECT,
    });
    return toWorkView(row);
  },

  // "New Work", made idempotent: a project needs at most ONE Work that nobody has
  // written in yet, so a second tap, a second tab, or the first-Work opener gets
  // that one back instead of another empty "New Work" row.
  //
  // Blank means: ACTIVE, not a Today Work, still titled WORK_DEFAULT_TITLE (the
  // first message renames it, and so does the person) and no chat row at all.
  // With several (older duplicates), the most recently active one wins.
  //
  // The advisory lock serialises two creators of the same project: the second
  // waits, then finds the Work the first one made. All reads and writes use the
  // transaction's own client (not the global one), so the lock and the row
  // always share one connection.
  async createOrReuseBlank(input: {
    workspaceId: string;
    projectId: string;
    createdByUserId?: string;
    channels?: ChannelKey[];
    acknowledgedUnconnected?: ChannelKey[];
  }): Promise<{ work: WorkView; reused: boolean }> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.projectId}:blank-work`}))`;

      const blank = await tx.work.findFirst({
        where: {
          projectId: input.projectId,
          status: "ACTIVE",
          title: WORK_DEFAULT_TITLE,
          NOT: { id: { startsWith: TODAY_WORK_PREFIX } },
          commands: { none: {} },
        },
        orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
        select: SELECT,
      });

      if (blank) {
        // Reopened: it moves to the top of the list like any Work just used. Only
        // explicitly requested channels replace what it has; none keeps its own.
        const channels = input.channels ?? [];
        const row = await tx.work.update({
          where: { id: blank.id },
          data: {
            lastActivityAt: new Date(),
            ...(channels.length > 0
              ? {
                  channels,
                  acknowledgedUnconnected: input.acknowledgedUnconnected ?? [],
                }
              : {}),
          },
          select: SELECT,
        });
        return { work: toWorkView(row), reused: true };
      }

      const row = await tx.work.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
          title: WORK_DEFAULT_TITLE,
          channels: input.channels ?? [],
          acknowledgedUnconnected: input.acknowledgedUnconnected ?? [],
        },
        select: SELECT,
      });
      return { work: toWorkView(row), reused: false };
    });
  },

  async get(projectId: string, workId: string): Promise<WorkView | null> {
    const row = await prisma.work.findFirst({
      where: { id: workId, projectId },
      select: SELECT,
    });
    return row ? toWorkView(row) : null;
  },

  // The sidebar list: newest activity first, archived hidden. With todayKey,
  // earlier days' Today Works are hidden too (today's stays); without options
  // the query is byte-identical to the slice-1 one.
  async listRecent(
    projectId: string,
    limit = 12,
    options?: { todayKey?: string },
  ): Promise<WorkView[]> {
    const rows = await prisma.work.findMany({
      where: {
        projectId,
        status: { not: "ARCHIVED" },
        ...(options?.todayKey
          ? {
              NOT: {
                id: {
                  startsWith: `${TODAY_WORK_PREFIX}${projectId}_`,
                  lt: todayWorkId(projectId, options.todayKey),
                },
              },
            }
          : {}),
      },
      orderBy: { lastActivityAt: "desc" },
      take: limit,
      select: SELECT,
    });
    return rows.map(toWorkView);
  },

  // The Work a bare project URL opens: the newest active one. The Today-aware
  // page passes excludeToday so a bare URL never lands on a Today Work.
  async latestActive(
    projectId: string,
    options?: { excludeToday?: boolean },
  ): Promise<WorkView | null> {
    const row = await prisma.work.findFirst({
      where: {
        projectId,
        status: "ACTIVE",
        ...(options?.excludeToday
          ? { NOT: { id: { startsWith: TODAY_WORK_PREFIX } } }
          : {}),
      },
      orderBy: { lastActivityAt: "desc" },
      select: SELECT,
    });
    return row ? toWorkView(row) : null;
  },

  // The deterministic Today Work of a day: created once, and always ACTIVE
  // afterwards (a stale DONE/ARCHIVED row cannot be recreated under the same
  // id, so it is reopened). Two tabs converge on one row via the P2002 re-read.
  async ensureToday(input: {
    workspaceId: string;
    projectId: string;
    createdByUserId?: string;
    dayKey: string;
    channels: ChannelKey[];
    acknowledgedUnconnected: ChannelKey[];
  }): Promise<WorkView> {
    const id = todayWorkId(input.projectId, input.dayKey);
    const read = async (): Promise<WorkView | null> => {
      const row = await prisma.work.findFirst({
        where: { id, projectId: input.projectId },
        select: SELECT,
      });
      if (!row) return null;
      if (row.status === "ACTIVE") return toWorkView(row);
      await WorkRepository.setStatus(input.projectId, id, "ACTIVE");
      return toWorkView({ ...row, status: "ACTIVE" });
    };

    const existing = await read();
    if (existing) return existing;
    try {
      const row = await prisma.work.create({
        data: {
          id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
          title: todayWorkTitle(),
          summary: null,
          channels: input.channels,
          acknowledgedUnconnected: input.acknowledgedUnconnected,
        },
        select: SELECT,
      });
      return toWorkView(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await read();
      if (raced) return raced;
      throw error;
    }
  },

  async findToday(projectId: string, dayKey: string): Promise<WorkView | null> {
    return WorkRepository.get(projectId, todayWorkId(projectId, dayKey));
  },

  // Cheap coverage read: which channels the project's live Works already cover.
  async channelCoverage(
    projectId: string,
  ): Promise<{ id: string; channels: ChannelKey[]; status: WorkStatus }[]> {
    const rows = await prisma.work.findMany({
      where: { projectId, status: { not: "ARCHIVED" } },
      select: { id: true, channels: true, status: true },
    });
    return rows.map((r) => ({
      id: r.id,
      channels: parseChannelKeys(r.channels),
      status: r.status,
    }));
  },

  async setStatus(
    projectId: string,
    workId: string,
    status: WorkStatus,
  ): Promise<boolean> {
    const result = await prisma.work.updateMany({
      where: { id: workId, projectId },
      data: { status, lastActivityAt: new Date() },
    });
    return result.count > 0;
  },

  async rename(
    projectId: string,
    workId: string,
    title: string,
  ): Promise<boolean> {
    const result = await prisma.work.updateMany({
      where: { id: workId, projectId },
      data: { title },
    });
    return result.count > 0;
  },

  async setChannels(
    projectId: string,
    workId: string,
    channels: ChannelKey[],
    acknowledgedUnconnected: ChannelKey[],
  ): Promise<boolean> {
    const result = await prisma.work.updateMany({
      where: { id: workId, projectId },
      data: { channels, acknowledgedUnconnected, lastActivityAt: new Date() },
    });
    return result.count > 0;
  },

  // Activity bump: the newest card/message refreshes the subtitle and moves the
  // Work to the top of the list. A still-default title is replaced by the
  // first message's title (only then, so a rename is never overwritten).
  async touch(
    projectId: string,
    workId: string,
    patch: { summary?: string | null; titleIfDefault?: string },
  ): Promise<void> {
    const now = new Date();
    if (patch.titleIfDefault) {
      await prisma.work.updateMany({
        where: { id: workId, projectId, title: WORK_DEFAULT_TITLE },
        data: { title: patch.titleIfDefault },
      });
    }
    await prisma.work.updateMany({
      where: { id: workId, projectId },
      data: {
        lastActivityAt: now,
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      },
    });
  },

  // Deletes the Work together with its chat rows (Tasks, Creatives and Library
  // assets stay: they belong to the project, not to the conversation).
  async remove(projectId: string, workId: string): Promise<boolean> {
    const [, work] = await prisma.$transaction([
      prisma.command.deleteMany({ where: { workId, projectId } }),
      prisma.work.deleteMany({ where: { id: workId, projectId } }),
    ]);
    return work.count > 0;
  },

  // Slot Creatives of this Work's plans that are still alive. The plan Commands
  // are the only production state of calendar entries, so remove() must not run
  // while this is above zero (the action refuses; Archive is the alternative).
  countLiveSlots(projectId: string, workId: string): Promise<number> {
    return liveSlotCount(prisma, projectId, workId);
  },

  // Count and delete in ONE Serializable transaction: a slot landing between a
  // separate count and the delete would otherwise leave a live Creative whose
  // plan Command is gone (Creative.planId has no foreign key).
  async removeUnlessLive(
    projectId: string,
    workId: string,
  ): Promise<"REMOVED" | "LIVE" | "NOT_FOUND"> {
    return prisma.$transaction(
      async (tx) => {
        if ((await liveSlotCount(tx, projectId, workId)) > 0) return "LIVE";
        await tx.command.deleteMany({ where: { workId, projectId } });
        const work = await tx.work.deleteMany({
          where: { id: workId, projectId },
        });
        return work.count > 0 ? "REMOVED" : "NOT_FOUND";
      },
      { isolationLevel: "Serializable" },
    );
  },
};

async function liveSlotCount(
  db: Prisma.TransactionClient,
  projectId: string,
  workId: string,
): Promise<number> {
  const plans = await db.command.findMany({
    where: {
      projectId,
      workId,
      parsedIntent: { path: ["card", "kind"], equals: "content-plan-draft" },
    },
    select: { id: true },
    take: 500,
  });
  if (plans.length === 0) return 0;
  return db.creative.count({
    where: {
      projectId,
      planId: { in: plans.map((p) => p.id) },
      status: { notIn: ["ARCHIVED", "REJECTED", "PUBLISHED"] },
    },
  });
}
