import type { ChatModel } from "./types";

// Deterministic stand-in used when AGENTELSE_REASONING_MODE=mock (tests and
// seed scripts), mirroring what chatTurnDef.buildMock does for the legacy
// engine: derives everything from the input, calls no tools, marks itself
// plainly as a mock reply.
export function createMockChatModel(message: string): ChatModel {
  return {
    async *stream() {
      const text = `Mock reply: received the message "${message.slice(0, 120)}".`;
      yield { type: "text.delta", text };
      yield {
        type: "completed",
        output: [{ role: "assistant", content: text }],
        functionCalls: [],
      };
    },
  };
}
