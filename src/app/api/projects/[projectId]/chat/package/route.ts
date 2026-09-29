import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isRateLimited } from "@/lib/rate-limit";
import { runContentPackage } from "@/server/chat/content-package-run";
import { MAX_PACKAGE_ITEMS } from "@/server/chat/content-package";
import { encodeSseEvent } from "@/server/chat/sse";
import type { ChatStreamEvent } from "@/server/chat/types";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// "Create selected" on a content-package card: starts every ticked
// deliverable at once and streams the run as Server-Sent Events (the item.* /
// package.done variants of ChatStreamEvent — see src/server/chat/types.ts),
// so the chat can show each piece being made live. Same wire format and
// keep-alive as the chat turn route next door.

const HEARTBEAT_MS = 10_000;

// A package is a deliberate click, not typing: a tight per-user cap is only a
// runaway-client guard (the claim itself already makes a package run once).
const RATE_LIMIT_MAX = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;

const BodySchema = z.object({
  commandId: z.string().min(1),
  selections: z
    .array(
      z.object({
        id: z.string().min(1),
        contentFormat: z.string().optional(),
      }),
    )
    .min(1)
    .max(MAX_PACKAGE_ITEMS),
});

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

  if (isRateLimited(`package:${userId}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down for a moment." },
      { status: 429 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

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
          // The client went away; the run keeps going so every claimed item
          // finishes and persists its card.
          closed = true;
        }
      };
      const send = (event: ChatStreamEvent) => write(encodeSseEvent(event));

      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

      try {
        for await (const event of runContentPackage({
          workspaceId: access.workspaceId,
          projectId,
          brandId: access.defaultBrandId,
          userId,
          commandId: body.commandId,
          selections: body.selections,
        })) {
          send(event);
        }
        revalidatePath(`/projects/${projectId}`);
      } catch (error) {
        console.error("[package-route] run crashed:", error);
        send({
          type: "error",
          code: "FAILED",
          message:
            error instanceof Error ? error.message : "Could not start the package",
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
      "X-Accel-Buffering": "no",
    },
  });
}
