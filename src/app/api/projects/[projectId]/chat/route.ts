import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { isRateLimited } from "@/lib/rate-limit";
import { runChatAgent } from "@/server/chat/chat-agent";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isWorksEnabled } from "@/server/works/flag";
import { storeChatFiles, validateChatFiles } from "@/server/chat/attachments";
import { encodeSseEvent } from "@/server/chat/sse";
import type { ChatStreamEvent } from "@/server/chat/types";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Streaming chat endpoint (CHAT_ENGINE=agent). One POST = one chat turn; the
// response is a Server-Sent Events stream of ChatStreamEvent frames (see
// src/server/chat/types.ts and sse.ts). The Command row for the turn is
// written by the agent before the first frame, so an aborted or dropped
// request never loses the client's message.

// Proxies (Railway edge, Cloudflare) close connections that stay silent for
// tens of seconds; a reasoning model can think that long before its first
// token, so an SSE comment goes out on this interval to keep the pipe warm.
const HEARTBEAT_MS = 10_000;

// Per-user message rate. In-memory (see rate-limit.ts): enforced per
// instance, which is fine as a runaway-client guard; the real spend cap is
// the per-project daily AutonomyPolicy budget.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

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

  const { attachments, attachmentBodies } = await storeChatFiles(files, {
    workspaceId: access.workspaceId,
    projectId,
    brandId: access.defaultBrandId,
  });

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away; the agent keeps running to persist its
          // partial reply (request.signal aborts the model stream).
          closed = true;
        }
      };
      const send = (event: ChatStreamEvent) => write(encodeSseEvent(event));

      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      try {
        for await (const event of runChatAgent({
          workspaceId: access.workspaceId,
          projectId,
          userId,
          message: text || "(file only, no message text)",
          ideaId,
          workId,
          attachments,
          attachmentBodies,
          signal: request.signal,
        })) {
          send(event);
        }
        revalidatePath(`/projects/${projectId}`);
      } catch (error) {
        console.error("[chat-route] agent crashed:", error);
        send({
          type: "error",
          code: "FAILED",
          message:
            error instanceof Error ? error.message : "Failed to send message",
        });
      } finally {
        clearInterval(heartbeat);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed by a client cancel.
          }
        }
      }
    },
    cancel() {
      closed = true;
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Reverse proxies (nginx-style) buffer by default; this opts out so
      // tokens reach the browser as they are produced.
      "X-Accel-Buffering": "no",
    },
  });
}
