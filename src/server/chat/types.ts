import type {
  ResponseInputItem,
  Tool,
} from "openai/resources/responses/responses";

import type { CommandReplyStatus } from "@/server/repositories/command.repository";
import type { IdeaEventCardData } from "@/types/idea-event-card";

// Events the chat agent emits while it works. The route handler serializes
// them 1:1 onto the SSE wire (sse.ts) and project-chat.tsx consumes the same
// shapes, so this union IS the client/server protocol.
export type ChatStreamEvent =
  // The Command row for this turn exists — the message is safe from here on.
  | { type: "start"; commandId: string }
  | { type: "text.delta"; text: string }
  | { type: "tool.start"; name: string; label: string }
  | { type: "tool.end"; name: string; ok: boolean }
  | { type: "card"; card: IdeaEventCardData }
  // A streamed in-progress preview of the image being generated right now
  // (data URL), replaced by each newer partial and by the final card.
  | { type: "image.partial"; index: number; dataUrl: string }
  // Clickable follow-up prompts shown under the finished reply.
  | { type: "suggestions"; items: string[] }
  // Content-package runs (POST /api/projects/[id]/chat/package,
  // content-package-run.ts): the same wire format, but one tagged stream for
  // several deliverables that run at once instead of a single chat turn.
  // `itemId` is the package item's own id (not a Command id).
  //
  // A content-plan run (POST /api/projects/[id]/chat/plan, plan-run.ts) picks
  // its pieces on the server (the nearest week of the saved plan), so it
  // announces them first: the chat opens one live message per piece.
  | {
      type: "run.items";
      items: {
        id: string;
        title: string;
        label: string;
        department?: string;
        // Image pieces show the live render block, text ones a running card.
        image: boolean;
      }[];
    }
  // The task behind the item exists and is about to run.
  | { type: "item.start"; itemId: string; taskId: string }
  // Streamed in-progress preview of an image item (like `image.partial`).
  | { type: "item.partial"; itemId: string; index: number; dataUrl: string }
  // The item finished (ok) or could not be produced. `card` is the final
  // chat card; `commandId` the persisted chat row behind it, so the client
  // can drop its local copy once that row arrives with the page refresh.
  | {
      type: "item.done";
      itemId: string;
      ok: boolean;
      reply: string;
      commandId?: string;
      card?: IdeaEventCardData;
    }
  // Every item is settled (the stream ends right after).
  | { type: "package.done"; started: number; failed: number }
  | {
      type: "done";
      commandId: string;
      status: CommandReplyStatus;
      reply: string;
      card?: IdeaEventCardData;
    }
  | {
      type: "error";
      code: string;
      message: string;
      card?: IdeaEventCardData;
    };

// What the agent loop needs from a model backend. The OpenAI Responses
// implementation is openai-chat-client.ts; tests and mock mode plug in fakes.
export type ChatModelRequest = {
  model: string;
  instructions: string;
  input: ResponseInputItem[];
  tools: Tool[];
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type ChatModelEvent =
  | { type: "text.delta"; text: string }
  | {
      type: "completed";
      // Every output item of this model turn (messages, reasoning, function
      // calls) — appended verbatim to `input` before the next loop turn so
      // the stateless (store:false) conversation stays intact.
      output: ResponseInputItem[];
      functionCalls: { callId: string; name: string; arguments: string }[];
      inputTokens?: number;
      // The part of inputTokens OpenAI served from its prompt cache.
      cachedInputTokens?: number;
      outputTokens?: number;
    };

export interface ChatModel {
  stream(request: ChatModelRequest): AsyncIterable<ChatModelEvent>;
}
