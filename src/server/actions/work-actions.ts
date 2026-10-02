"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import {
  WORK_TITLE_MAX,
  channelNeedsConnection,
  isTodayWork,
  parseChannelKeys,
} from "@/lib/works/work";
import { getProjectTimezone, todayInTimezone } from "@/server/chat/content-plan";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { WorkRepository } from "@/server/repositories/work.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import { isWorksEnabled } from "@/server/works/flag";
import { authorizeWorks, guardedAction } from "@/server/works/guard";

// Actions of the Works surface (docs/works.md): open a Work, choose its
// channels, complete / reopen / archive / rename / delete it. Each one is a
// public POST: the flag, the session and the project access are checked here,
// and every Work id is looked up WITH the project id (never trusted alone).

export type WorkActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

const MESSAGE = {
  failed: "That didn't work. Try again.",
  disabled: "Works aren't available.",
  rate: "Slow down for a moment.",
  notFound: "That Work no longer exists.",
} as const;

const TODAY_REFUSAL =
  "Today's brief can't be completed, archived, renamed or deleted.";

const PER_WINDOW = 40;
const WINDOW_MS = 10 * 60_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64;
}

type Authed = { userId: string; workspaceId: string };

async function authorize(
  projectId: unknown,
): Promise<WorkActionResult<{ auth: Authed }>> {
  if (!validId(projectId)) return { ok: false, message: MESSAGE.failed };
  if (!isWorksEnabled()) return { ok: false, message: MESSAGE.disabled };
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (isRateLimited(`works:${userId}`, PER_WINDOW, WINDOW_MS)) {
    return { ok: false, message: MESSAGE.rate };
  }
  return { ok: true, auth: { userId, workspaceId: access.workspaceId } };
}

function refresh(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}`);
  } catch (error) {
    console.error(
      "[works] revalidate failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function guarded<T>(
  label: string,
  run: () => Promise<WorkActionResult<T>>,
): Promise<WorkActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    console.error(
      `[works] ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
    return { ok: false, message: MESSAGE.failed };
  }
}

// Which of the chosen channels are not connected right now ("I'll connect
// later"): stored so the screen can tell a deliberate choice from a gap.
async function unconnectedOf(
  projectId: string,
  channels: ChannelKey[],
): Promise<ChannelKey[]> {
  const connections: ChannelConnections = await getChannelConnections(
    projectId,
  ).catch(() => ({}));
  return channels.filter(
    (key) => channelNeedsConnection(key) && !connections[key]?.connected,
  );
}

// "New Work". Idempotent: while the project still has a Work nobody has written
// in (default title, no chat rows), that one is opened instead of making another
// empty row. `reused: true` tells the screen so it can say it (it is only
// present then, so a freshly created Work answers exactly as before).
export async function createWorkAction(
  projectId: string,
  channels?: unknown,
): Promise<WorkActionResult<{ workId: string; reused?: true }>> {
  return guarded("create", async () => {
    const gate = await authorize(projectId);
    if (!gate.ok) return gate;
    const chosen = parseChannelKeys(channels);
    const { work, reused } = await WorkRepository.createOrReuseBlank({
      workspaceId: gate.auth.workspaceId,
      projectId,
      createdByUserId: gate.auth.userId,
      channels: chosen,
      // Only a channel choice needs the live connection read.
      acknowledgedUnconnected:
        chosen.length > 0 ? await unconnectedOf(projectId, chosen) : [],
    });
    refresh(projectId);
    return reused
      ? { ok: true, workId: work.id, reused: true }
      : { ok: true, workId: work.id };
  });
}

export async function setWorkChannelsAction(
  projectId: string,
  workId: string,
  channels: unknown,
): Promise<WorkActionResult<{ channels: ChannelKey[] }>> {
  return guarded("set-channels", async () => {
    if (!validId(workId)) return { ok: false, message: MESSAGE.failed };
    const gate = await authorize(projectId);
    if (!gate.ok) return gate;
    const chosen = parseChannelKeys(channels);
    if (chosen.length === 0) {
      return { ok: false, message: "Pick at least one channel." };
    }
    const saved = await WorkRepository.setChannels(
      projectId,
      workId,
      chosen,
      await unconnectedOf(projectId, chosen),
    );
    if (!saved) return { ok: false, message: MESSAGE.notFound };
    refresh(projectId);
    return { ok: true, channels: chosen };
  });
}

type Transition = "DONE" | "ACTIVE" | "ARCHIVED";

async function transition(
  label: string,
  projectId: string,
  workId: string,
  status: Transition,
): Promise<WorkActionResult> {
  return guarded(label, async () => {
    if (!validId(workId)) return { ok: false, message: MESSAGE.failed };
    // Only the UI hid these buttons: a direct POST must not archive today's Work.
    if (status !== "ACTIVE" && isTodayWork({ id: workId })) {
      return { ok: false, message: TODAY_REFUSAL };
    }
    const gate = await authorize(projectId);
    if (!gate.ok) return gate;
    const done = await WorkRepository.setStatus(projectId, workId, status);
    if (!done) return { ok: false, message: MESSAGE.notFound };
    refresh(projectId);
    return { ok: true };
  });
}

export async function completeWorkAction(projectId: string, workId: string) {
  return transition("complete", projectId, workId, "DONE");
}

export async function reopenWorkAction(projectId: string, workId: string) {
  return transition("reopen", projectId, workId, "ACTIVE");
}

export async function archiveWorkAction(projectId: string, workId: string) {
  return transition("archive", projectId, workId, "ARCHIVED");
}

export async function renameWorkAction(
  projectId: string,
  workId: string,
  title: unknown,
): Promise<WorkActionResult> {
  return guarded("rename", async () => {
    if (!validId(workId) || typeof title !== "string") {
      return { ok: false, message: MESSAGE.failed };
    }
    if (isTodayWork({ id: workId })) {
      return { ok: false, message: TODAY_REFUSAL };
    }
    const clean = title.replace(/\s+/g, " ").trim().slice(0, WORK_TITLE_MAX);
    if (!clean) return { ok: false, message: "Give it a name." };
    const gate = await authorize(projectId);
    if (!gate.ok) return gate;
    const done = await WorkRepository.rename(projectId, workId, clean);
    if (!done) return { ok: false, message: MESSAGE.notFound };
    refresh(projectId);
    return { ok: true };
  });
}

export async function deleteWorkAction(
  projectId: string,
  workId: string,
): Promise<WorkActionResult> {
  return guarded("delete", async () => {
    if (!validId(workId)) return { ok: false, message: MESSAGE.failed };
    if (isTodayWork({ id: workId })) {
      return { ok: false, message: TODAY_REFUSAL };
    }
    const gate = await authorize(projectId);
    if (!gate.ok) return gate;
    // Plan Commands hold the calendar entries: never drop them under live
    // slots. The count and the delete run in one Serializable transaction.
    const outcome = await WorkRepository.removeUnlessLive(projectId, workId);
    if (outcome === "LIVE") {
      return {
        ok: false,
        message: "This Work still has pieces on your calendar. Archive it instead.",
      };
    }
    if (outcome === "NOT_FOUND") return { ok: false, message: MESSAGE.notFound };
    refresh(projectId);
    return { ok: true };
  });
}

// Today's Work: one per project and day. Only ever called from a client
// effect, never from a GET. With nothing connected it starts with NO channel
// (the chooser appears and the brief offers "Connect a channel"); seo is added
// only once a publishing channel is connected.
export async function openTodayWorkAction(
  projectId: string,
): Promise<WorkActionResult<{ workId: string }>> {
  const result = await guardedAction("open-today", async () => {
    const gate = await authorizeWorks(projectId, { bucket: "work-open", limit: 20 });
    if (!gate.ok) return gate;
    const timezone = await getProjectTimezone(projectId);
    const dayKey = todayInTimezone(timezone);
    const connections: ChannelConnections = await getChannelConnections(
      projectId,
    ).catch(() => ({}));
    const connected = (Object.keys(connections) as ChannelKey[]).filter(
      (key) => channelNeedsConnection(key) && connections[key]?.connected === true,
    );
    const channels: ChannelKey[] =
      connected.length > 0 ? [...connected, "seo"] : [];
    const work = await WorkRepository.ensureToday({
      workspaceId: gate.auth.workspaceId,
      projectId,
      createdByUserId: gate.auth.userId,
      dayKey,
      channels,
      acknowledgedUnconnected: [],
    });
    refresh(projectId);
    return { ok: true as const, workId: work.id };
  });
  return result.ok ? result : { ok: false, message: result.message };
}

// Opens (or reuses) the one ACTIVE Work of a single channel. seo is refused:
// a Website Work is opened from the channel chooser.
export async function openChannelWorkAction(
  projectId: string,
  channel: unknown,
): Promise<WorkActionResult<{ workId: string }>> {
  const result = await guardedAction("open-channel", async () => {
    const keys = parseChannelKeys([channel]);
    const key = keys[0];
    if (keys.length !== 1 || !key || !channelNeedsConnection(key)) {
      return { ok: false as const, message: MESSAGE.failed };
    }
    const gate = await authorizeWorks(projectId, { bucket: "work-open", limit: 20 });
    if (!gate.ok) return gate;
    // The advisory lock serialises two taps: the second waits, then sees the
    // Work the first created.
    const workId = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId + ":" + key}))`;
      const coverage = await WorkRepository.channelCoverage(projectId);
      for (const entry of coverage) {
        if (
          entry.status === "ACTIVE" &&
          !isTodayWork(entry) &&
          entry.channels.length === 1 &&
          entry.channels[0] === key
        ) {
          const existing = await WorkRepository.get(projectId, entry.id);
          if (existing) return existing.id;
        }
      }
      const created = await WorkRepository.create({
        workspaceId: gate.auth.workspaceId,
        projectId,
        createdByUserId: gate.auth.userId,
        channels: [key],
        acknowledgedUnconnected: [],
      });
      return created.id;
    });
    refresh(projectId);
    return { ok: true as const, workId };
  });
  return result.ok ? result : { ok: false, message: result.message };
}
