import { copyText } from "@/lib/works/copy";
import { createSseParser } from "@/server/chat/sse";
import type { ChatStreamEvent } from "@/server/chat/types";

export type VariantsResult = { ok: true } | { ok: false; message: string };

export type VariantsRequest = {
  commandId: string;
  creativeId: string;
  // false = the first set on an empty slot, true = "Make 3 more" on a piece.
  more: boolean;
};

const failed = (): VariantsResult => ({
  ok: false,
  message: copyText("variants.failed"),
});

// The route answers refusals in two shapes: a JSON body with a non-2xx status
// before it streams (401 / 404 / 409 / 429 / 400) and, after that, an SSE
// stream with HTTP 200 whose first event is `error` (BUSY / STATE / LIMIT /
// BUDGET / PROJECT_INACTIVE / FAILED). Both must surface here: an HTTP 200 on
// its own is not success.
function refusalOf(code: string, message: string): VariantsResult {
  if (code === "LIMIT") return { ok: false, message: copyText("variants.limit") };
  // The budget notice is already written for the person; every other code
  // (BUSY / STATE / PROJECT_INACTIVE / FAILED) gets the generic sentence.
  if (code === "BUDGET" && message.trim()) return { ok: false, message };
  return failed();
}

// One call to the variants route, read to the end of its stream. The run
// patches the card itself; the caller only refreshes on `ok`.
export async function postVariants(
  projectId: string,
  body: VariantsRequest,
): Promise<VariantsResult> {
  try {
    const response = await fetch(`/api/projects/${projectId}/chat/variants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // 401 / 404 / 409 / 429 / 400 arrive as JSON with a status: nothing ran.
    if (!response.ok) return failed();
    if (!response.body) return { ok: true };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser();
    // A holder, so the narrowing below sees what the closure wrote.
    const seen: {
      refusal?: Extract<ChatStreamEvent, { type: "error" }>;
      started?: number;
    } = {};
    const inspect = (events: ChatStreamEvent[]): void => {
      for (const event of events) {
        if (event.type === "error" && !seen.refusal) seen.refusal = event;
        if (event.type === "package.done") seen.started = event.started;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      inspect(parse(decoder.decode(value, { stream: true })));
    }
    inspect(parse(`${decoder.decode()}\n\n`));

    if (seen.refusal) {
      return refusalOf(seen.refusal.code, seen.refusal.message);
    }
    // Nothing started (every job failed to begin): not a success either.
    if (seen.started === 0) return failed();
    return { ok: true };
  } catch {
    return failed();
  }
}
