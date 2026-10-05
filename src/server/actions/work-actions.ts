"use server";

import { revalidatePath } from "next/cache";

import { isRateLimited } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import type { ChannelConnections, ChannelKey } from "@/lib/content-channels";
import { parseModuleKey, type ModuleKey } from "@/lib/modules/catalog";
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
import { unconnectedOf } from "@/server/works/channel-defaults";
import { isModulesEnabled, isWorksEnabled } from "@/server/works/flag";
import { authorizeWorks, guardedAction } from "@/server/works/guard";

// Actions of the Works surface (docs/works.md): open a Work, choose its
// channels or its module, complete / reopen / archive / rename / delete it.
// Each one is a public POST: the flag, the session and the project access are
// checked here, and every Work id is looked up WITH the project id (never
// trusted alone).

export type WorkActionResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

const MESSAGE = {
  failed: "That didn't work. Try again.",
  disabled: "Works aren't available.",
  rate: "Slow down for a moment.",
  notFound: "That Work no longer exists.",
  modulesOff: "Modules aren't available.",
  started: "This chat has already started.",
} as const;

const TODAY_REFUSAL =
  "Today's brief can't be completed, archived, renamed or deleted.";

const PER_WINDOW = 40;
const CREATE_PER_WINDOW = 300;
// A channel menu is made for quick multi-select: every tick is one store.
const CHANNELS_PER_WINDOW = 120;
// The New Chat screen's module tiles: one store per tap.
const MODULE_PER_WINDOW = 120;
const WINDOW_MS = 10 * 60_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 64;
}

type Authed = { userId: string; workspaceId: string };

async function authorize(
  projectId: unknown,
  // Opening a chat has its own, larger bucket: every project open does it.
  bucket: { name: string; limit: number } = { name: "works", limit: PER_WINDOW },
): Promise<WorkActionResult<{ auth: Authed }>> {
  if (!validId(projectId)) return { ok: false, message: MESSAGE.failed };
  if (!isWorksEnabled()) return { ok: false, message: MESSAGE.disabled };
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  if (isRateLimited(`${bucket.name}:${userId}`, bucket.limit, WINDOW_MS)) {
    return { ok: false, message: MESSAGE.rate };
  }
  return { ok: true, auth: { userId, workspaceId: access.workspaceId } };
}

// The module a client asks a new chat to be for (New Chat, `?module=`): a known
// key while modules are on, else a general chat. The flag is read only when a
// module is asked for.
function requestedModule(value: unknown): ModuleKey | null {
  const key = parseModuleKey(value);
  return key && isModulesEnabled() ? key : null;
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

// "New Chat" (and opening the project). Idempotent: while the project still
// has a Work nobody has written in (default title, no chat rows), that one is
// opened instead of making another empty row, and other empty copies are
// archived. `currentWorkId` is the Work the person is in: when it is the empty
// one, they stay there. `module` is what the chat is for (src/lib/modules);
// without one (or with modules off) it is a general chat, the reused empty one
// included.
export async function createWorkAction(
  projectId: string,
  channels?: unknown,
  currentWorkId?: unknown,
  module?: unknown,
): Promise<WorkActionResult<{ workId: string }>> {
  return guarded("create", async () => {
    // Opening a project lands here. The call is idempotent (an empty chat is
    // reused, not added), so its bucket is far larger than the one that guards
    // the destructive actions: normal use must never lock someone out of it.
    const gate = await authorize(projectId, {
      name: "work-create",
      limit: CREATE_PER_WINDOW,
    });
    if (!gate.ok) return gate;
    const chosen = parseChannelKeys(channels);
    const { work } = await WorkRepository.createOrReuseBlank({
      workspaceId: gate.auth.workspaceId,
      projectId,
      createdByUserId: gate.auth.userId,
      // Only a hint: the repository uses it only if it is this project's blank Work.
      currentWorkId: validId(currentWorkId) ? currentWorkId : undefined,
      channels: chosen,
      // Only a channel choice needs the live connection read.
      acknowledgedUnconnected:
        chosen.length > 0 ? await unconnectedOf(projectId, chosen) : [],
      module: requestedModule(module),
    });
    // No revalidation: an empty chat is not in Recents, and both callers move
    // to a freshly rendered URL, so re-reading the page they leave is waste.
    return { ok: true, workId: work.id };
  });
}

export async function setWorkChannelsAction(
  projectId: string,
  workId: string,
  channels: unknown,
): Promise<WorkActionResult<{ channels: ChannelKey[] }>> {
  return guarded("set-channels", async () => {
    if (!validId(workId)) return { ok: false, message: MESSAGE.failed };
    // Its own bucket: ticking channels in the composer's menu must not use up
    // the one that guards complete / archive / rename / delete.
    const gate = await authorize(projectId, {
      name: "work-channels",
      limit: CHANNELS_PER_WINDOW,
    });
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

// The New Chat screen's choice of module (null: back to a general chat). Only
// a chat nobody has written in changes module: one that has started keeps what
// it is for.
export async function setWorkModuleAction(
  projectId: string,
  workId: string,
  module: unknown,
): Promise<WorkActionResult<{ module: ModuleKey | null }>> {
  return guarded("set-module", async () => {
    if (!validId(workId)) return { ok: false, message: MESSAGE.failed };
    const key = parseModuleKey(module);
    // null is a choice (a general chat); anything else must be a module.
    if (module !== null && !key) return { ok: false, message: MESSAGE.failed };
    if (!isModulesEnabled()) return { ok: false, message: MESSAGE.modulesOff };
    // Its own bucket: tapping through the tiles must not use up the one that
    // guards complete / archive / rename / delete.
    const gate = await authorize(projectId, {
      name: "work-module",
      limit: MODULE_PER_WINDOW,
    });
    if (!gate.ok) return gate;
    if (!(await WorkRepository.setModule(projectId, workId, key))) {
      const work = await WorkRepository.get(projectId, workId);
      return { ok: false, message: work ? MESSAGE.started : MESSAGE.notFound };
    }
    refresh(projectId);
    return { ok: true, module: key };
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
