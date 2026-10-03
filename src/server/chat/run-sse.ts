import "server-only";

import { subscribe, type ChatRun } from "./run-registry";
import { encodeSseEvent } from "./sse";

// Proxies (Railway edge, Cloudflare) close connections that stay silent for
// tens of seconds; a reasoning model can think that long before its first
// token, so an SSE comment goes out on this interval to keep the pipe warm.
const HEARTBEAT_MS = 10_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  // Reverse proxies (nginx-style) buffer by default; this opts out so tokens
  // reach the browser as they are produced.
  "X-Accel-Buffering": "no",
} as const;

// The SSE response of one chat run (the POST that started it, or a re-attach):
// what the run sent so far, then its live events as frames; the stream ends
// when the run does. It is a SUBSCRIPTION only: a client that goes away
// (reload, chat switch, closed tab) just unsubscribes and the run goes on.
// Stop is its own endpoint (runs/[commandId]/cancel).
export function chatRunResponse(run: ChatRun, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let detached = false;
  let unsubscribe: () => void = () => undefined;

  const detach = () => {
    if (detached) return;
    detached = true;
    clearInterval(heartbeat);
    unsubscribe();
    signal?.removeEventListener("abort", detach);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (detached) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away.
          detach();
        }
      };
      const finish = () => {
        if (detached) return;
        detach();
        try {
          controller.close();
        } catch {
          // Already closed by a client cancel.
        }
      };

      if (signal?.aborted) {
        finish();
        return;
      }
      unsubscribe = subscribe(run, {
        onEvent: (event) => write(encodeSseEvent(event)),
        onEnd: finish,
      });
      // The run had already ended: it was replayed to its end.
      if (detached) return;
      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      signal?.addEventListener("abort", detach, { once: true });
    },
    cancel() {
      detach();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
