import { revalidatePath } from "next/cache";

import { encodeSseEvent } from "./sse";
import type { ChatStreamEvent } from "./types";

// The SSE response of a live production run (content package, content plan):
// relays the run's events as frames with a keep-alive, and lets the run finish
// and persist its cards even when the client goes away (its work is already
// claimed). Same wire format as the chat turn route.

const HEARTBEAT_MS = 10_000;

export function sseRunResponse(input: {
  projectId: string;
  run: () => AsyncGenerator<ChatStreamEvent>;
  // Prefix of the crash log line, and the message when the run throws
  // something that is not an Error.
  logTag: string;
  failureMessage: string;
}): Response {
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
        for await (const event of input.run()) send(event);
        revalidatePath(`/projects/${input.projectId}`);
      } catch (error) {
        console.error(`[${input.logTag}] run crashed:`, error);
        send({
          type: "error",
          code: "FAILED",
          message:
            error instanceof Error ? error.message : input.failureMessage,
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
