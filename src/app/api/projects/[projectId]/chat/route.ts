import { NextResponse } from "next/server";

import { isRateLimited } from "@/lib/rate-limit";
import { CommandRepository } from "@/server/repositories/command.repository";
import { WorkRepository } from "@/server/repositories/work.repository";
import { applyDefaultChannels } from "@/server/works/channel-defaults";
import { isWorksEnabled } from "@/server/works/flag";
import { storeChatFiles, validateChatFiles } from "@/server/chat/attachments";
import { runChatAgent } from "@/server/chat/chat-agent";
import { loadAttachmentBodies } from "@/server/chat/history-files";
import {
  findActiveRun,
  isRunLive,
  startChatRun,
} from "@/server/chat/run-registry";
import { chatRunResponse } from "@/server/chat/run-sse";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Streaming chat endpoint (CHAT_ENGINE=agent). One POST = one chat turn, run
// DETACHED from this request (run-registry.ts): the response is a Server-Sent
// Events stream of ChatStreamEvent frames (src/server/chat/types.ts, sse.ts)
// that only follows the run. A reload, a chat switch or a closed tab drops the
// stream, never the turn; the client re-attaches through
// /chat/runs/[commandId] and stops it through /chat/runs/[commandId]/cancel.

// Per-user message rate. In-memory (see rate-limit.ts): enforced per
// instance, which is fine as a runaway-client guard; the real spend cap is
// the per-project daily AutonomyPolicy budget.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const BUSY_MESSAGE =
  "A reply is still being written in this chat. Wait for it or press Stop.";

function busy() {
  return NextResponse.json({ error: BUSY_MESSAGE }, { status: 409 });
}

// Turns of this chat still marked RUNNING that no run of this process drives
// any more (a restart or deploy cut them off) end as INTERRUPTED. Best-effort:
// it never fails the message.
async function settleOrphans(projectId: string, workId: string | null) {
  try {
    const ids = await CommandRepository.runningTurnIds({ projectId, workId });
    await CommandRepository.markInterrupted(ids.filter((id) => !isRunLive(id)));
  } catch (error) {
    console.error(
      "[chat-route] settling interrupted turns failed:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let access: Awaited<ReturnType<typeof requireProjectAccess>>;
  try {
    access = await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (isRateLimited(`chat:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many messages. Please slow down for a moment." },
      { status: 429 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const text = String(formData.get("text") ?? "").trim();
  const ideaIdField = formData.get("ideaId");
  const ideaId =
    typeof ideaIdField === "string" && ideaIdField ? ideaIdField : undefined;
  // Works on: every turn belongs to an ACTIVE Work of this project. The id is
  // re-checked here (a form field is not trusted); Works off: no workId at all.
  let workId: string | undefined;
  // A chat with no channel yet gets its defaults with the message (see below).
  let needsDefaults = false;
  // Works only: the sent message this one replaces (an edit).
  let editOf: string | undefined;
  if (isWorksEnabled()) {
    const field = formData.get("workId");
    const work =
      typeof field === "string" && field
        ? await WorkRepository.get(projectId, field)
        : null;
    if (!work || work.status !== "ACTIVE") {
      return NextResponse.json(
        { error: "Open or start a Work first." },
        { status: 400 },
      );
    }
    workId = work.id;
    needsDefaults = work.channels.length === 0;
    const editField = formData.get("editOf");
    if (typeof editField === "string" && editField) editOf = editField;
  }
  const files = formData
    .getAll("files")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (!text && files.length === 0) {
    return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  }
  const fileError = validateChatFiles(files);
  if (fileError) {
    return NextResponse.json({ error: fileError }, { status: 400 });
  }

  // One turn at a time per chat: checked before anything is stored or edited.
  const chatWorkId = workId ?? null;
  if (findActiveRun(projectId, chatWorkId)) return busy();
  await settleOrphans(projectId, chatWorkId);

  // An edit: the edited message and everything after it leave the chat and
  // the model's history; its files come along with the new text.
  let carried: Awaited<
    ReturnType<typeof CommandRepository.supersedeFrom>
  > | null = null;
  if (editOf && workId) {
    carried = await CommandRepository.supersedeFrom({
      projectId,
      workId,
      commandId: editOf,
    });
    if (!carried.ok) {
      return NextResponse.json(
        { error: "This message can't be edited." },
        { status: 400 },
      );
    }
  }

  // A chat is free, but its tools default pieces to the connected channels:
  // stored BEFORE the message becomes a Command so this very turn sees them
  // (conditional: never over channels stored meanwhile). A failure only means
  // the pieces fall back to Instagram.
  if (workId && needsDefaults) {
    await applyDefaultChannels({ projectId, workId }).catch((error) => {
      console.error(
        "[chat-route] storing the chat's default channels failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  const stored = await storeChatFiles(files, {
    workspaceId: access.workspaceId,
    projectId,
    brandId: access.defaultBrandId,
  });
  const carriedFiles = carried?.ok ? carried.attachments : [];
  const carriedBodies =
    carriedFiles.length > 0
      ? await loadAttachmentBodies(carriedFiles, projectId).catch(() => [])
      : [];

  const started = startChatRun(
    {
      workspaceId: access.workspaceId,
      projectId,
      userId,
      message: text || "(file only, no message text)",
      ideaId,
      workId,
      attachments: [...carriedFiles, ...stored.attachments],
      attachmentBodies: [...carriedBodies, ...stored.attachmentBodies],
    },
    { agent: runChatAgent },
  );
  if (!started.ok) return busy();

  return chatRunResponse(started.run, request.signal);
}
