import "server-only";

import type { Prisma, WorkStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { ChannelKey } from "@/lib/content-channels";
import { parseModuleKey, type ModuleKey } from "@/lib/modules/catalog";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import {
  TODAY_WORK_PREFIX,
  WORK_DEFAULT_TITLE,
  WORK_DEFAULT_TITLES,
  isDefaultWorkTitle,
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
  module: string | null;
  lastActivityAt: Date;
};

const SELECT = {
  id: true,
  title: true,
  summary: true,
  status: true,
  channels: true,
  acknowledgedUnconnected: true,
  module: true,
  lastActivityAt: true,
} as const;

// A Work nobody has used yet: still ACTIVE, untitled, and with no chat row at
// all (a chosen channel does not count). The one New Chat reuses instead of
// adding another, and the one Recents does not list until its first message.
const UNTOUCHED: Prisma.WorkWhereInput = {
  status: "ACTIVE",
  title: { in: [...WORK_DEFAULT_TITLES] },
  commands: { none: {} },
};

// A project's untouched Works, Today Works never among them: what New Chat
// reuses and what the sidebar shows as the new chat.
function blankOf(projectId: string): Prisma.WorkWhereInput {
  return {
    projectId,
    ...UNTOUCHED,
    NOT: { id: { startsWith: TODAY_WORK_PREFIX } },
  };
}

export function toWorkView(row: WorkRow): WorkView {
  return {
    id: row.id,
    // An untitled Work from before the rename reads like a new one.
    title: isDefaultWorkTitle(row.title) ? WORK_DEFAULT_TITLE : row.title,
    summary: row.summary,
    status: row.status,
    channels: parseChannelKeys(row.channels),
    acknowledgedUnconnected: parseChannelKeys(row.acknowledgedUnconnected),
    // A plain string column: anything but a known module is a general chat.
    module: parseModuleKey(row.module),
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

  // "New Chat", made idempotent: a project needs at most ONE Work that nobody has
  // written in yet, so a second tap, a second tab, or opening the project (the
  // bare URL always starts a new chat) gets that one back instead of another
  // empty row.
  //
  // Blank means: ACTIVE, not a Today Work, still untitled (WORK_DEFAULT_TITLES:
  // the first message renames it, and so does the person) and no chat row at all.
  // Which blank Work: the one the person is in (`currentWorkId`, when it is
  // blank), else the most recently active one. Any OTHER blank Work of the
  // project (empty copies piled up before this rule) is archived, not deleted:
  // it holds nothing, and it leaves the sidebar.
  //
  // The advisory lock serialises two creators of the same project: the second
  // waits, then finds the Work the first one made. All reads and writes use the
  // transaction's own client (not the global one), so the lock and the rows
  // always share one connection.
  //
  // `module` is what the new chat is for (a module's start, src/lib/modules);
  // none is a general chat. A reused blank Work takes it too: a plain New Chat
  // tap turns an empty module chat back into a general one.
  async createOrReuseBlank(input: {
    workspaceId: string;
    projectId: string;
    createdByUserId?: string;
    channels?: ChannelKey[];
    acknowledgedUnconnected?: ChannelKey[];
    currentWorkId?: string;
    module?: ModuleKey | null;
  }): Promise<{ work: WorkView; reused: boolean; archived: number }> {
    const moduleKey = input.module ?? null;
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.projectId}:blank-work`}))`;

      const blankWhere = blankOf(input.projectId);

      const current = input.currentWorkId
        ? await tx.work.findFirst({
            where: { AND: [blankWhere, { id: input.currentWorkId }] },
            select: SELECT,
          })
        : null;
      const blank =
        current ??
        (await tx.work.findFirst({
          where: blankWhere,
          orderBy: [{ lastActivityAt: "desc" }, { createdAt: "desc" }],
          select: SELECT,
        }));

      let archived = 0;
      if (blank) {
        ({ count: archived } = await tx.work.updateMany({
          where: { AND: [blankWhere, { id: { not: blank.id } }] },
          data: { status: "ARCHIVED" },
        }));
        // Reopened: it moves to the top of the list like any Work just used. Only
        // explicitly requested channels replace what it has; none keeps its own.
        // Conditional on it STILL being blank: the lock only serialises New Chat
        // taps, so a delete or a first message from another tab can land between
        // the read and this write. Then it is not reused, and a fresh Work is
        // made below instead of failing the tap.
        const channels = input.channels ?? [];
        const { count } = await tx.work.updateMany({
          where: { AND: [blankWhere, { id: blank.id }] },
          data: {
            lastActivityAt: new Date(),
            module: moduleKey,
            ...(channels.length > 0
              ? {
                  channels,
                  acknowledgedUnconnected: input.acknowledgedUnconnected ?? [],
                }
              : {}),
          },
        });
        const row =
          count > 0
            ? await tx.work.findFirst({
                where: { id: blank.id, projectId: input.projectId },
                select: SELECT,
              })
            : null;
        if (row) return { work: toWorkView(row), reused: true, archived };
      }

      const row = await tx.work.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          createdByUserId: input.createdByUserId,
          title: WORK_DEFAULT_TITLE,
          channels: input.channels ?? [],
          acknowledgedUnconnected: input.acknowledgedUnconnected ?? [],
          module: moduleKey,
        },
        select: SELECT,
      });
      return { work: toWorkView(row), reused: false, archived };
    });
  },

  // Whether this Work is still the new chat (untouched, by the same rule New
  // Chat reuses it): the sidebar then marks New Chat, not a Recents row.
  async isUntouched(projectId: string, workId: string): Promise<boolean> {
    const count = await prisma.work.count({
      where: { AND: [blankOf(projectId), { id: workId }] },
    });
    return count > 0;
  },

  // The New Chat screen's choice of module (null: back to a general chat). One
  // conditional write on the isUntouched rule: once a chat has started, it
  // keeps what it is for. false = nothing was written (gone, started, renamed,
  // completed, a Today Work or another project's).
  async setModule(
    projectId: string,
    workId: string,
    module: ModuleKey | null,
  ): Promise<boolean> {
    const result = await prisma.work.updateMany({
      where: { AND: [blankOf(projectId), { id: workId }] },
      data: { module },
    });
    return result.count > 0;
  },

  async get(projectId: string, workId: string): Promise<WorkView | null> {
    const row = await prisma.work.findFirst({
      where: { id: workId, projectId },
      select: SELECT,
    });
    return row ? toWorkView(row) : null;
  },

  // Every live Work, newest activity first, archived hidden (the integrations
  // page's way back to a Work).
  async listRecent(projectId: string, limit = 12): Promise<WorkView[]> {
    const rows = await prisma.work.findMany({
      where: { projectId, status: { not: "ARCHIVED" } },
      orderBy: { lastActivityAt: "desc" },
      take: limit,
      select: SELECT,
    });
    return rows.map(toWorkView);
  },

  // The sidebar's Recents (docs/works.md), newest activity first. Like ChatGPT
  // a chat joins it with its first message: the blank one (what New Chat and
  // opening the project land in) is not listed. Today Works are not either
  // (Today is not in the sidebar), and archived ones never are.
  async recents(projectId: string, limit = 50): Promise<WorkView[]> {
    const rows = await prisma.work.findMany({
      where: {
        projectId,
        status: { not: "ARCHIVED" },
        NOT: [{ id: { startsWith: TODAY_WORK_PREFIX } }, UNTOUCHED],
      },
      orderBy: { lastActivityAt: "desc" },
      take: limit,
      select: SELECT,
    });
    return rows.map(toWorkView);
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

  // The default channels of a chat, stored with a message that finds it with
  // none (docs/works.md): one conditional write, only for an ACTIVE Work that
  // has no channel yet, so a channel stored meanwhile (a card, another tab) is
  // never overwritten. A chat is not bound to a channel: these are defaults.
  // false = nothing was written.
  async setInitialChannels(
    projectId: string,
    workId: string,
    channels: ChannelKey[],
    acknowledgedUnconnected: ChannelKey[],
  ): Promise<boolean> {
    const result = await prisma.work.updateMany({
      where: {
        id: workId,
        projectId,
        status: "ACTIVE",
        channels: { equals: [] },
      },
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
        where: {
          id: workId,
          projectId,
          title: { in: [...WORK_DEFAULT_TITLES] },
        },
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
  const planCard = {
    cardKind: "content-plan-draft",
  };
  // SEO_ACTIONS açıkken SEO Manager kartlarının makaleleri de (Creative.planId =
  // kartın Command'ı) canlı slot sayılır: takvimdeki makalesi olan Work silinemez.
  const seoCard = {
    AND: [
      { cardKind: "module-flow" },
      { parsedIntent: { path: ["card", "module"], equals: "seo" } },
    ],
  };
  const plans = await db.command.findMany({
    where: {
      projectId,
      workId,
      ...(SeoActionFlags.manager() ? { OR: [planCard, seoCard] } : planCard),
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
